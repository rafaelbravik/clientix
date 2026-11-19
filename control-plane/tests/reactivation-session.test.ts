import crypto from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  createInstallationRequestSignature,
  generateInstallationKeyPair,
  generateRequestNonce,
} from "@/lib/licensing/installation-auth";
import type { DatabaseClient } from "../scripts/migrator";
import { StaticVendorSignerProvider } from "../src/signer";

const artifactMock = vi.hoisted(() => ({ issueCurrentForInstallation: vi.fn() }));

vi.mock("../src/license-artifact-service", () => ({
  LicenseArtifactService: class {
    issueCurrentForInstallation = artifactMock.issueCurrentForInstallation;
    processPending = vi.fn();
  },
}));

import { PostgresNonceStore } from "../src/nonce-store";
import { ControlPlaneService } from "../src/service";

interface StoredLicense {
  id: string;
  serial: string;
  customer_id: string;
  product: string;
  deployment: string;
  plan: "standard" | "pro" | "enterprise";
  license_type: string;
  status: string;
  signing_key_id: string;
  valid_from: string;
  expires_at: string;
  maintenance_until: string | null;
  grace_days: number;
  max_installations: number;
  max_tenants: number | null;
  resale_allowed: boolean;
  white_label: boolean;
  features: string[];
  issued_at: string;
}

interface StoredInstallation {
  id: string;
  license_id: string;
  public_key: string;
  status: string;
  clone_status: "NORMAL" | "SUSPECTED_CLONE" | "CLONE_CONFIRMED" | "TRANSFER_PENDING";
  last_heartbeat_at: string;
  clientix_version?: string | null;
}

interface StoredSession {
  session_id: string;
  license_id: string;
  installation_id: string;
  status: "ACTIVE" | "ENDED";
  boot_started_at: string;
  started_at: string;
  last_heartbeat_at: string;
  clientix_version: string | null;
}

interface StoredChallenge {
  challenge_digest: string;
  license_id: string;
  installation_id: string;
  session_id: string;
  boot_started_at: string;
  clientix_version: string | null;
  expires_at: string;
  consumed_at: string | null;
}

class MemoryControlPlaneDatabase implements DatabaseClient {
  readonly sessions = new Map<string, StoredSession>();
  readonly challenges = new Map<string, StoredChallenge>();
  readonly nonces = new Set<string>();
  readonly events: Array<Record<string, unknown>> = [];
  license!: StoredLicense;
  installation!: StoredInstallation;

  constructor(
    readonly customer: { id: string; name: string; billing_email: string; country: string },
    private readonly now: () => Date,
  ) {}

  async query<R = Record<string, unknown>>(
    sql: string,
    params: unknown[] = [],
  ): Promise<{ rows: R[]; rowCount?: number }> {
    const query = sql.trim();
    if (["BEGIN;", "COMMIT;", "ROLLBACK;"].includes(query)) return { rows: [] };

    if (query.startsWith("delete from control_plane.licensing_attestation_challenges")) {
      const now = Date.parse(params[0] as string);
      for (const [digest, challenge] of this.challenges) {
        if (Date.parse(challenge.expires_at) <= now) this.challenges.delete(digest);
      }
      return { rows: [] };
    }
    if (query.startsWith("insert into control_plane.licensing_attestation_challenges")) {
      const challenge: StoredChallenge = {
        challenge_digest: params[0] as string,
        license_id: params[1] as string,
        installation_id: params[2] as string,
        session_id: params[3] as string,
        boot_started_at: params[4] as string,
        clientix_version: (params[5] as string | null) ?? null,
        expires_at: params[6] as string,
        consumed_at: null,
      };
      this.challenges.set(challenge.challenge_digest, challenge);
      return { rows: [] };
    }
    if (
      query.startsWith("select license_id, installation_id, session_id, boot_started_at") &&
      query.includes("from control_plane.licensing_attestation_challenges")
    ) {
      const challenge = this.challenges.get(params[0] as string);
      return { rows: challenge ? ([challenge] as R[]) : [] };
    }
    if (query.startsWith("update control_plane.licensing_attestation_challenges set consumed_at")) {
      const challenge = this.challenges.get(params[0] as string);
      if (challenge) challenge.consumed_at = params[1] as string;
      return { rows: [] };
    }

    if (
      query.startsWith("select id, license_id, status, clone_status") &&
      query.includes("from control_plane.licensing_installations where id = $1")
    ) {
      return {
        rows: this.installation.id === params[0] ? ([this.installation] as R[]) : [],
      };
    }
    if (
      query.startsWith("select id, license_id, public_key, status") &&
      query.includes("from control_plane.licensing_installations where id = $1")
    ) {
      return {
        rows: this.installation.id === params[0] ? ([this.installation] as R[]) : [],
      };
    }
    if (
      query.startsWith("select status, valid_from, expires_at, grace_days") &&
      query.includes("from control_plane.licensing_licenses")
    ) {
      return { rows: this.license.id === params[0] ? ([this.license] as R[]) : [] };
    }
    if (
      query.startsWith("select license_id, installation_id, boot_started_at, status") &&
      query.includes("from control_plane.licensing_instance_sessions")
    ) {
      const session = this.sessions.get(params[0] as string);
      return { rows: session ? ([session] as R[]) : [] };
    }
    if (query.startsWith("insert into control_plane.licensing_instance_sessions")) {
      const [sessionId, licenseId, installationId, bootStartedAt, timestamp, version] = params as [
        string,
        string,
        string,
        string,
        string,
        string | null,
      ];
      const existing = this.sessions.get(sessionId);
      if (existing) {
        existing.last_heartbeat_at = timestamp;
        existing.clientix_version = version ?? existing.clientix_version;
      } else {
        this.sessions.set(sessionId, {
          session_id: sessionId,
          license_id: licenseId,
          installation_id: installationId,
          status: "ACTIVE",
          boot_started_at: bootStartedAt,
          started_at: timestamp,
          last_heartbeat_at: timestamp,
          clientix_version: version,
        });
      }
      return { rows: [] };
    }
    if (
      query.startsWith("select session_id, started_at, last_heartbeat_at") &&
      query.includes("from control_plane.licensing_instance_sessions")
    ) {
      const installationId = params[0] as string;
      const since = Date.parse(params[1] as string);
      const sessions = [...this.sessions.values()].filter(
        (session) =>
          session.installation_id === installationId &&
          session.status === "ACTIVE" &&
          Date.parse(session.last_heartbeat_at) >= since,
      );
      return { rows: sessions as R[] };
    }
    if (
      query.startsWith("select exists (") &&
      query.includes("from control_plane.licensing_instance_sessions")
    ) {
      return { rows: [{ reported: false } as R] };
    }
    if (query.startsWith("select count(*)::int as count from control_plane.licensing_installations")) {
      const count = this.installation.license_id === params[0] && this.installation.status === "ACTIVE" ? 1 : 0;
      return { rows: [{ count } as R] };
    }
    if (query.startsWith("select l.*, c.id as cust_id")) {
      if (this.license.id !== params[0]) return { rows: [] };
      return {
        rows: [
          {
            ...this.license,
            cust_id: this.customer.id,
            cust_name: this.customer.name,
            cust_email: this.customer.billing_email,
            cust_country: this.customer.country,
            cust_status: "ACTIVE",
          } as R,
        ],
      };
    }
    if (query.startsWith("update control_plane.licensing_installations")) {
      if (query.includes("clone_status = 'NORMAL'")) this.installation.clone_status = "NORMAL";
      else if (query.includes("clone_status = $2"))
        this.installation.clone_status = params[1] as StoredInstallation["clone_status"];
      else {
        this.installation.last_heartbeat_at = this.now().toISOString();
        this.installation.clientix_version = (params[1] as string | null) ?? null;
      }
      return { rows: [{ license_id: this.installation.license_id } as R] };
    }
    if (query.startsWith("delete from control_plane.licensing_nonces")) return { rows: [] };
    if (query.startsWith("insert into control_plane.licensing_nonces")) {
      const nonce = `${params[0]}:${params[1]}`;
      if (this.nonces.has(nonce)) throw new Error("duplicate key value violates unique constraint");
      this.nonces.add(nonce);
      return { rows: [] };
    }
    if (query.startsWith("insert into control_plane.licensing_events")) {
      this.events.push({
        license_id: params[0],
        installation_id: params[1],
        event_type: params[2],
        payload: params[3],
      });
      return { rows: [] };
    }

    return { rows: [] };
  }
}

describe("installation session recovery after license reactivation", () => {
  const now = new Date("2026-11-10T12:00:00.000Z");
  const customerId = "cust_33333333-3333-4333-8333-333333333333";
  const licenseId = "44444444-4444-4444-8444-444444444444";
  const installationId = "inst_55555555-5555-4555-8555-555555555555";
  const signingKeyId = "synthetic-reactivation-signer";
  let db: MemoryControlPlaneDatabase;
  let service: ControlPlaneService;
  let installationKeys: ReturnType<typeof generateInstallationKeyPair>;

  beforeEach(() => {
    installationKeys = generateInstallationKeyPair();
    const signerKeys = generateInstallationKeyPair();
    db = new MemoryControlPlaneDatabase(
      { id: customerId, name: "Synthetic reactivation customer", billing_email: "synthetic@example.invalid", country: "BR" },
      () => now,
    );
    db.license = {
      id: licenseId,
      serial: "CLX-TEST-REACTIVATION",
      customer_id: customerId,
      product: "clientix",
      deployment: "self-hosted",
      plan: "pro",
      license_type: "internal",
      status: "ACTIVE",
      signing_key_id: signingKeyId,
      valid_from: new Date(now.getTime() - 86_400_000).toISOString(),
      expires_at: new Date(now.getTime() + 365 * 86_400_000).toISOString(),
      maintenance_until: null,
      grace_days: 7,
      max_installations: 1,
      max_tenants: null,
      resale_allowed: false,
      white_label: false,
      features: [],
      issued_at: now.toISOString(),
    };
    db.installation = {
      id: installationId,
      license_id: licenseId,
      public_key: installationKeys.publicKeyPem,
      status: "ACTIVE",
      clone_status: "NORMAL",
      last_heartbeat_at: now.toISOString(),
    };
    artifactMock.issueCurrentForInstallation.mockResolvedValue({
      payload: { license_id: licenseId, installation_id: installationId, status: "ACTIVE" },
      signature: "synthetic-artifact-signature",
      algorithm: "Ed25519",
      key_id: signingKeyId,
    });
    const signerProvider = new StaticVendorSignerProvider(signingKeyId, signerKeys.privateKeyPem);
    service = new ControlPlaneService({
      db,
      signerProvider,
      trustedPublicKeyMap: { [signingKeyId]: signerKeys.publicKeyPem },
      pepper: "synthetic-pepper-for-reactivation-tests-000001",
      nonceStore: new PostgresNonceStore(db),
      clockNow: () => now,
      cloneSessionWindowSeconds: 900,
    });
  });

  async function attest(sessionId: string, privateKeyPem = installationKeys.privateKeyPem) {
    const bootStartedAt = now.toISOString();
    const challengeTimestamp = Math.floor(now.getTime() / 1000);
    const challengeNonce = generateRequestNonce();
    const challengeBody = {
      installation_id: installationId,
      license_id: licenseId,
      instance_session_id: sessionId,
      boot_started_at: bootStartedAt,
      clientix_version: "reactivation-test",
      timestamp: challengeTimestamp,
      nonce: challengeNonce,
    };
    const rawChallengeBody = JSON.stringify(challengeBody);
    const challengeSignature = createInstallationRequestSignature({
      installationId,
      timestamp: challengeTimestamp,
      nonce: challengeNonce,
      method: "POST",
      path: "/api/v1/licensing/challenge",
      body: rawChallengeBody,
      privateKeyPem,
    });
    const challenge = await service.createAttestationChallenge({
      ...challengeBody,
      app_version: challengeBody.clientix_version,
      signatureBase64url: challengeSignature,
      rawBody: rawChallengeBody,
    });
    if (!challenge.ok || !challenge.data) return { challenge, validation: undefined };

    const validationTimestamp = Math.floor(now.getTime() / 1000);
    const validationNonce = generateRequestNonce();
    const validationBody = {
      ...challengeBody,
      local_license_status: "SUSPENDED",
      challenge: challenge.data.challenge,
      timestamp: validationTimestamp,
      nonce: validationNonce,
    };
    const rawValidationBody = JSON.stringify(validationBody);
    const validationSignature = createInstallationRequestSignature({
      installationId,
      timestamp: validationTimestamp,
      nonce: validationNonce,
      method: "POST",
      path: "/api/v1/licensing/validate-attestation",
      body: rawValidationBody,
      privateKeyPem,
    });
    const validationParams = {
      installation_id: installationId,
      license_id: licenseId,
      instance_session_id: sessionId,
      boot_started_at: bootStartedAt,
      app_version: challengeBody.clientix_version,
      local_license_state: "SUSPENDED",
      challenge: challenge.data.challenge,
      timestamp: validationTimestamp,
      nonce: validationNonce,
      signatureBase64url: validationSignature,
      rawBody: rawValidationBody,
    };
    const validation = await service.validateAttestation(validationParams);
    return { challenge, validation, validationParams };
  }

  it("never revives the old session and accepts a new attested session after reactivation", async () => {
    const oldSessionId = `sess_${crypto.randomUUID()}`;
    const first = await attest(oldSessionId);
    expect(first.validation?.ok, JSON.stringify(first.validation)).toBe(true);
    expect(db.sessions.get(oldSessionId)?.status).toBe("ACTIVE");

    db.license.status = "SUSPENDED";
    const oldSession = db.sessions.get(oldSessionId)!;
    oldSession.status = "ENDED";
    oldSession.last_heartbeat_at = now.toISOString();

    const suspended = await attest(oldSessionId);
    expect(suspended.validation?.ok).toBe(true);
    expect(suspended.validation?.data?.license_status).toBe("SUSPENDED");
    expect(db.sessions.get(oldSessionId)?.status).toBe("ENDED");

    db.license.status = "ACTIVE";
    const oldSessionRetry = await attest(oldSessionId);
    expect(oldSessionRetry.validation?.ok).toBe(false);
    expect(oldSessionRetry.validation?.status).toBe(409);
    expect(oldSessionRetry.validation?.error?.code).toBe("INSTANCE_SESSION_ENDED");
    expect(db.sessions.get(oldSessionId)?.status).toBe("ENDED");

    const newSessionId = `sess_${crypto.randomUUID()}`;
    const recovered = await attest(newSessionId);
    expect(recovered.validation?.ok).toBe(true);
    expect(recovered.validation?.data?.license_status).toBe("ACTIVE");
    expect(db.sessions.get(newSessionId)?.status).toBe("ACTIVE");
    expect(db.sessions.get(oldSessionId)?.status).toBe("ENDED");
  });

  it("rejects a new session challenge signed by a different installation key", async () => {
    const wrongKey = generateInstallationKeyPair();
    const result = await attest(`sess_${crypto.randomUUID()}`, wrongKey.privateKeyPem);

    expect(result.challenge.ok).toBe(false);
    expect(result.challenge.status).toBe(401);
    expect(result.challenge.error?.code).toBe("INVALID_INSTALLATION_SIGNATURE");
    expect(db.sessions.size).toBe(0);
  });

  it.each(["REVOKED", "EXPIRED"] as const)(
    "does not open a session for a %s license",
    async (status) => {
      db.license.status = status;
      const sessionId = `sess_${crypto.randomUUID()}`;
      const result = await attest(sessionId);

      expect(result.validation?.ok).toBe(true);
      expect(result.validation?.data?.license_status).toBe(status);
      expect(db.sessions.has(sessionId)).toBe(false);
    },
  );

  it("does not open a session after the temporal validity and grace period have ended", async () => {
    db.license.issued_at = new Date(now.getTime() - 365 * 86_400_000).toISOString();
    db.license.valid_from = new Date(now.getTime() - 365 * 86_400_000).toISOString();
    db.license.expires_at = new Date(now.getTime() - 10 * 86_400_000).toISOString();
    db.license.grace_days = 0;
    const sessionId = `sess_${crypto.randomUUID()}`;
    const result = await attest(sessionId);

    expect(result.validation?.ok).toBe(true);
    expect(result.validation?.data?.license_status).toBe("EXPIRED");
    expect(db.sessions.has(sessionId)).toBe(false);
  });

  it("rejects a consumed challenge as replay while retaining the current active session", async () => {
    const sessionId = `sess_${crypto.randomUUID()}`;
    const first = await attest(sessionId);
    expect(first.validation?.ok).toBe(true);

    const replay = await service.validateAttestation(first.validationParams!);
    expect(replay.ok).toBe(false);
    expect(replay.status).toBe(409);
    expect(replay.error?.code).toBe("REPLAY_DETECTED");
    expect(db.sessions.get(sessionId)?.status).toBe("ACTIVE");
  });
});
