import crypto from "crypto";
import type { DatabaseClient } from "../scripts/migrator";
import type { SignedLicenseDocument, LicensePayload, LicenseType } from "@/lib/licensing/types";
import {
  isValidCanonicalInstallationId,
  isValidInstallationPublicKey,
  computePublicKeyFingerprint,
  deriveActivationCodeDigest,
  verifyInstallationRequestSignature,
  type NonceStore,
} from "@/lib/licensing/installation-auth";
import { LicenseIssuer } from "./license-issuer";
import {
  LicenseArtifactService,
  type LicenseArtifactProcessingResult,
} from "./license-artifact-service";
import type { VendorSignerProvider } from "./signer";
import type { RateLimiter } from "./rate-limiter";
import {
  hasConcurrentSessionEvidence,
  transitionCloneStatus,
  type CloneStatus,
} from "@/lib/licensing/clone-status";

export interface DatabaseLicenseCustomerRow {
  id: string;
  customer_id: string;
  cust_id: string;
  cust_name: string;
  cust_email: string | null;
  cust_country: string | null;
  license_type: LicenseType;
  status: "DRAFT" | "ACTIVE" | "EXPIRED" | "SUSPENDED" | "REVOKED";
  signing_key_id: string;
  serial?: string;
  product?: string;
  deployment?: string;
  plan?: "standard" | "pro" | "enterprise";
  max_installations: number;
  max_tenants: number | null;
  resale_allowed: boolean;
  white_label: boolean;
  features: string[];
  issued_at: string | null;
  valid_from: string;
  expires_at: string;
  maintenance_until: string | null;
  grace_days: number;
  license_revision?: number | string;
  cust_status?: "ACTIVE" | "DISABLED";
}

export interface ControlPlaneServiceContext {
  db: DatabaseClient;
  signerProvider: VendorSignerProvider;
  trustedPublicKeyMap: Record<string, string>; // For verify-before-response parity check
  pepper: string;
  nonceStore: NonceStore;
  rateLimiter?: RateLimiter;
  clockNow?: () => Date;
  cloneSessionWindowSeconds?: number;
}

export type ControlPlaneErrorCode =
  | "ACTIVATION_INVALID"
  | "ACTIVATION_EXPIRED"
  | "ACTIVATION_CODE_USED"
  | "ACTIVATION_CODE_EXHAUSTED"
  | "ACTIVATION_LIMIT_REACHED"
  | "INSTALLATION_KEY_MISMATCH"
  | "INSTALLATION_REVOKED"
  | "LICENSE_SUSPENDED"
  | "LICENSE_REVOKED"
  | "LICENSE_EXPIRED"
  | "INVALID_INSTALLATION_SIGNATURE"
  | "CLOCK_SKEW_EXCEEDED"
  | "REPLAY_DETECTED"
  | "INSTANCE_SESSION_ENDED"
  | "RATE_LIMITED"
  | "RENEWAL_NOT_ALLOWED"
  | "MALFORMED_REQUEST"
  | "UNAUTHORIZED";

export interface ServiceResult<T> {
  ok: boolean;
  status: number;
  data?: T;
  error?: {
    code: ControlPlaneErrorCode;
    message: string;
  };
}

export interface ActivationParams {
  installation_id: string;
  installation_public_key: string;
  activation_code: string;
  timestamp: number;
  nonce: string;
  clientIp?: string;
  app_version?: string;
}

export interface ActivationResponseData {
  signed_license: SignedLicenseDocument;
  license_status: "ACTIVE" | "EXPIRED" | "SUSPENDED" | "REVOKED";
  installation_status:
    "ACTIVE" | "SUSPENDED" | "REVOKED" | "DEACTIVATED" | "TRANSFERRED" | "DISABLED";
  server_timestamp: string;
}

export interface HeartbeatParams {
  installation_id: string;
  clientIp?: string;
  license_id?: string;
  app_version?: string;
  schema_version?: string;
  release_version?: string;
  local_license_state?: string;
  timestamp: number;
  nonce: string;
  signatureBase64url: string;
  rawBody?: string;
  instance_session_id?: string;
  requestPath?:
    | "/api/v1/licensing/validate"
    | "/api/v1/licensing/heartbeat"
    | "/api/v1/licensing/validate-attestation";
}

export interface HeartbeatResponseData {
  license_id: string;
  signed_license: SignedLicenseDocument;
  license_status: "ACTIVE" | "EXPIRED" | "SUSPENDED" | "REVOKED";
  installation_status:
    "ACTIVE" | "SUSPENDED" | "REVOKED" | "DEACTIVATED" | "TRANSFERRED" | "DISABLED";
  temporal_state: "NOT_YET_VALID" | "VALID" | "GRACE" | "EXPIRED";
  server_timestamp: string;
  clone_status: CloneStatus;
  instance_session_id?: string;
  revocation_artifact?: string; // Signed proof of status
}

export interface AttestationChallengeParams {
  installation_id: string;
  license_id: string;
  instance_session_id: string;
  boot_started_at: string;
  app_version?: string;
  timestamp: number;
  nonce: string;
  signatureBase64url: string;
  rawBody: string;
  clientIp?: string;
}

export interface AttestationChallengeData {
  installation_id: string;
  license_id: string;
  instance_session_id: string;
  request_nonce: string;
  challenge: string;
  expires_at: string;
  server_time: string;
}

export interface ValidateAttestationParams extends AttestationChallengeParams {
  challenge: string;
  local_license_state?: string;
}

export interface InstallationRecoveryParams {
  installation_id: string;
  installation_public_key: string;
  recovery_code: string;
  timestamp: number;
  nonce: string;
  signatureBase64url: string;
  rawBody: string;
  clientIp?: string;
}

export interface InstallationRecoveryData {
  installation_id: string;
  public_key_fingerprint: string;
  clone_status: "NORMAL";
  server_timestamp: string;
}

export interface RenewalParams {
  installation_id: string;
  timestamp: number;
  nonce: string;
  signatureBase64url: string;
  rawBody?: string;
}

export interface RenewalResponseData {
  signed_license: SignedLicenseDocument;
  server_timestamp: string;
}

export interface DeactivationParams {
  installation_id: string;
  timestamp: number;
  nonce: string;
  signatureBase64url: string;
  rawBody?: string;
}

export interface DeactivationResponseData {
  installation_id: string;
  status: "DEACTIVATED";
  message: string;
  server_timestamp: string;
}

export class ControlPlaneService {
  private readonly licenseArtifacts: LicenseArtifactService;

  constructor(private readonly ctx: ControlPlaneServiceContext) {
    this.licenseArtifacts = new LicenseArtifactService(
      ctx.db,
      ctx.signerProvider,
      ctx.trustedPublicKeyMap,
      () => this.now(),
    );
  }

  async processPendingLicenseArtifacts(
    params: {
      licenseId?: string;
      limit?: number;
    } = {},
  ): Promise<LicenseArtifactProcessingResult> {
    return this.licenseArtifacts.processPending(params);
  }

  /** Vendor-only export of the installation-scoped document consumed by LIC-01. */
  async issueAdminLicenseDocument(params: {
    licenseId: string;
    installationId: string;
    actorId: string;
    requestId: string;
  }): Promise<SignedLicenseDocument> {
    const result = await this.ctx.db.query<{
      license_id: string;
      serial: string;
      product: string;
      deployment: string;
      plan: "standard" | "pro" | "enterprise";
      license_type: LicenseType;
      license_status: "DRAFT" | "ACTIVE" | "EXPIRED" | "SUSPENDED" | "REVOKED";
      signing_key_id: string;
      customer_id: string;
      customer_name: string;
      customer_email: string;
      customer_country: string | null;
      customer_status: "ACTIVE" | "DISABLED";
      installation_id: string;
      installation_status: string;
      clone_status: CloneStatus;
      max_installations: number;
      max_tenants: number | null;
      resale_allowed: boolean;
      white_label: boolean;
      features: string[];
      issued_at: string | null;
      valid_from: string;
      expires_at: string;
      maintenance_until: string | null;
      grace_days: number;
    }>(
      `select l.id as license_id, l.serial, l.product, l.deployment, l.plan, l.license_type,
              l.status as license_status, l.signing_key_id, l.customer_id,
              c.name as customer_name, c.billing_email as customer_email, c.country as customer_country,
              c.status as customer_status, i.id as installation_id, i.status as installation_status,
              i.clone_status, l.max_installations, l.max_tenants, l.resale_allowed, l.white_label,
              l.features, l.issued_at, l.valid_from, l.expires_at, l.maintenance_until, l.grace_days
         from control_plane.licensing_licenses l
         join control_plane.licensing_customers c on c.id = l.customer_id
         join control_plane.licensing_installations i on i.license_id = l.id
        where l.id = $1 and i.id = $2;`,
      [params.licenseId, params.installationId],
    );
    const row = result.rows[0];
    if (!row) throw new Error("License installation not found.");
    if (
      row.license_status !== "ACTIVE" ||
      row.customer_status !== "ACTIVE" ||
      row.installation_status !== "ACTIVE"
    ) {
      throw new Error("Only an active license and installation can receive a signed artifact.");
    }
    if (row.clone_status !== "NORMAL")
      throw new Error("Resolve the installation conflict before issuing an artifact.");

    const signed = await this.licenseArtifacts.issueCurrentForInstallation({
      licenseId: row.license_id,
      installationId: row.installation_id,
      source: "ADMIN_EXPORT",
    });
    await this.ctx.db.query(
      `insert into control_plane.licensing_events
         (license_id, installation_id, event_type, payload, actor, actor_type, actor_id, request_id, created_at)
       values ($1, $2, 'LICENSE_ARTIFACT_EXPORTED', $3::jsonb, 'admin', 'ADMIN', $4, $5, now());`,
      [
        row.license_id,
        row.installation_id,
        JSON.stringify({ key_id: signed.key_id }),
        params.actorId,
        params.requestId,
      ],
    );
    return signed;
  }

  private async signCurrentLicense(
    payload: LicensePayload,
    licenseId: string,
    recordedKeyId?: string,
  ): Promise<SignedLicenseDocument> {
    const activeKey = await this.ctx.signerProvider.getSigningKey();
    let payloadForCurrentKey = payload;
    if (recordedKeyId && recordedKeyId !== activeKey.keyId) {
      const issuedAt = this.now().toISOString();
      payloadForCurrentKey = { ...payload, issued_at: issuedAt };
      await this.ctx.db.query(
        `with changed as (
           update control_plane.licensing_licenses
            set signing_key_id = $2, issued_at = $3, updated_at = $3
           where id = $1 and signing_key_id <> $2
           returning id
         )
         insert into control_plane.licensing_events (license_id, event_type, payload, actor, created_at)
          select id, 'LICENSE_REISSUED', $4::jsonb, 'system', $3 from changed;`,
        [
          licenseId,
          activeKey.keyId,
          issuedAt,
          JSON.stringify({ previous_key_id: recordedKeyId, key_id: activeKey.keyId }),
        ],
      );
      const revision = await this.ctx.db.query<{ license_revision: number | string }>(
        `select license_revision from control_plane.licensing_licenses where id = $1;`,
        [licenseId],
      );
      payloadForCurrentKey = {
        ...payloadForCurrentKey,
        license_revision: Number(
          revision.rows[0]?.license_revision ?? payload.license_revision ?? 1,
        ),
      };
    }
    const issuer = new LicenseIssuer(this.ctx.signerProvider, this.ctx.trustedPublicKeyMap);
    return issuer.signPayload(payloadForCurrentKey, activeKey.keyId);
  }

  private now(): Date {
    return this.ctx.clockNow ? this.ctx.clockNow() : new Date();
  }

  private isValidSessionId(value: string): boolean {
    return /^sess_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
      value,
    );
  }

  private async verifyAttestationRequest(
    params: AttestationChallengeParams,
    requestPath: "/api/v1/licensing/challenge" | "/api/v1/licensing/validate-attestation",
    consumeRequestNonce: boolean,
  ): Promise<ServiceResult<{ license_id: string }>> {
    if (
      !isValidCanonicalInstallationId(params.installation_id) ||
      !this.isValidSessionId(params.instance_session_id) ||
      !Number.isInteger(params.timestamp) ||
      params.nonce.length < 16 ||
      params.nonce.length > 128 ||
      !Number.isFinite(Date.parse(params.boot_started_at))
    ) {
      return {
        ok: false,
        status: 400,
        error: { code: "MALFORMED_REQUEST", message: "Attestation could not be completed." },
      };
    }
    const installationResult = await this.ctx.db.query<{
      id: string;
      license_id: string;
      public_key: string;
      status: string;
    }>(
      `select id, license_id, public_key, status from control_plane.licensing_installations where id = $1;`,
      [params.installation_id],
    );
    const installation = installationResult.rows[0];
    if (
      !installation ||
      installation.status !== "ACTIVE" ||
      installation.license_id !== params.license_id
    ) {
      return {
        ok: false,
        status: 401,
        error: { code: "UNAUTHORIZED", message: "Attestation could not be completed." },
      };
    }
    const signature = await verifyInstallationRequestSignature({
      installationId: params.installation_id,
      timestamp: params.timestamp,
      nonce: params.nonce,
      method: "POST",
      path: requestPath,
      body: params.rawBody,
      signatureBase64url: params.signatureBase64url,
      publicKeyPem: installation.public_key,
      ...(consumeRequestNonce ? { nonceStore: this.ctx.nonceStore } : {}),
      currentTimestampUnixSeconds: Math.floor(this.now().getTime() / 1000),
    });
    if (!signature.ok) {
      const code =
        signature.code === "REPLAY_DETECTED" ? "REPLAY_DETECTED" : "INVALID_INSTALLATION_SIGNATURE";
      return {
        ok: false,
        status: signature.code === "REPLAY_DETECTED" ? 409 : 401,
        error: { code, message: "Attestation could not be completed." },
      };
    }
    return { ok: true, status: 200, data: { license_id: installation.license_id } };
  }

  async createAttestationChallenge(
    params: AttestationChallengeParams,
  ): Promise<ServiceResult<AttestationChallengeData>> {
    const now = this.now();
    if (this.ctx.rateLimiter) {
      const checks = [
        { key: `attest-challenge:installation:${params.installation_id}`, maxHits: 12 },
        ...(params.clientIp
          ? [{ key: `attest-challenge:ip:${params.clientIp}`, maxHits: 120 }]
          : []),
      ];
      for (const check of checks) {
        const result = await this.ctx.rateLimiter.checkLimit(check.key, check.maxHits, 60);
        if (!result.allowed)
          return {
            ok: false,
            status: 429,
            error: { code: "RATE_LIMITED", message: "Attestation could not be completed." },
          };
      }
    }
    const verified = await this.verifyAttestationRequest(
      params,
      "/api/v1/licensing/challenge",
      true,
    );
    if (!verified.ok) {
      return { ok: false, status: verified.status, error: verified.error };
    }

    const bootTime = Date.parse(params.boot_started_at);
    if (bootTime > now.getTime() + 60_000 || bootTime < now.getTime() - 30 * 86_400_000) {
      return {
        ok: false,
        status: 400,
        error: { code: "MALFORMED_REQUEST", message: "Attestation could not be completed." },
      };
    }
    const challenge = crypto.randomBytes(32).toString("base64url");
    const expiresAt = new Date(now.getTime() + 60_000).toISOString();
    await this.ctx.db.query(
      `delete from control_plane.licensing_attestation_challenges where expires_at <= $1;`,
      [now.toISOString()],
    );
    await this.ctx.db.query(
      `insert into control_plane.licensing_attestation_challenges
         (challenge_digest, license_id, installation_id, session_id, boot_started_at, clientix_version, expires_at)
       values ($1, $2, $3, $4, $5, $6, $7);`,
      [
        crypto.createHash("sha256").update(challenge).digest("hex"),
        verified.data!.license_id,
        params.installation_id,
        params.instance_session_id,
        new Date(bootTime).toISOString(),
        params.app_version ?? null,
        expiresAt,
      ],
    );
    return {
      ok: true,
      status: 200,
      data: {
        installation_id: params.installation_id,
        license_id: verified.data!.license_id,
        instance_session_id: params.instance_session_id,
        request_nonce: params.nonce,
        challenge,
        expires_at: expiresAt,
        server_time: now.toISOString(),
      },
    };
  }

  async validateAttestation(
    params: ValidateAttestationParams,
  ): Promise<ServiceResult<HeartbeatResponseData>> {
    if (this.ctx.rateLimiter) {
      const checks = [
        { key: `attest:installation:${params.installation_id}`, maxHits: 30 },
        ...(params.clientIp ? [{ key: `attest:ip:${params.clientIp}`, maxHits: 120 }] : []),
      ];
      for (const check of checks) {
        const result = await this.ctx.rateLimiter.checkLimit(check.key, check.maxHits, 60);
        if (!result.allowed)
          return {
            ok: false,
            status: 429,
            error: { code: "RATE_LIMITED", message: "Attestation could not be completed." },
          };
      }
    }
    const verified = await this.verifyAttestationRequest(
      params,
      "/api/v1/licensing/validate-attestation",
      false,
    );
    if (!verified.ok) {
      return { ok: false, status: verified.status, error: verified.error };
    }
    if (!/^[A-Za-z0-9_-]{32,128}$/.test(params.challenge)) {
      return {
        ok: false,
        status: 401,
        error: { code: "UNAUTHORIZED", message: "Attestation could not be completed." },
      };
    }

    const now = this.now();
    const digest = crypto.createHash("sha256").update(params.challenge).digest("hex");
    await this.ctx.db.query("BEGIN;");
    let cloneStatus: CloneStatus = "NORMAL";
    try {
      const installationResult = await this.ctx.db.query<{
        id: string;
        license_id: string;
        status: string;
        clone_status: CloneStatus;
        clone_conflict_count: number;
        last_clone_conflict_at: string | null;
      }>(
        `select id, license_id, status, clone_status, clone_conflict_count, last_clone_conflict_at
           from control_plane.licensing_installations where id = $1 for update;`,
        [params.installation_id],
      );
      const installation = installationResult.rows[0];
      if (
        !installation ||
        installation.status !== "ACTIVE" ||
        installation.license_id !== params.license_id ||
        installation.clone_status === "TRANSFER_PENDING"
      ) {
        await this.ctx.db.query("ROLLBACK;");
        return {
          ok: false,
          status: 401,
          error: { code: "UNAUTHORIZED", message: "Attestation could not be completed." },
        };
      }
      const challengeResult = await this.ctx.db.query<{
        license_id: string;
        installation_id: string;
        session_id: string;
        boot_started_at: string;
        clientix_version: string | null;
        expires_at: string;
        consumed_at: string | null;
      }>(
        `select license_id, installation_id, session_id, boot_started_at, clientix_version, expires_at, consumed_at
           from control_plane.licensing_attestation_challenges
          where challenge_digest = $1 for update;`,
        [digest],
      );
      const challenge = challengeResult.rows[0];
      const bootStartedAt = new Date(Date.parse(params.boot_started_at)).toISOString();
      if (
        !challenge ||
        challenge.consumed_at ||
        Date.parse(challenge.expires_at) <= now.getTime() ||
        challenge.installation_id !== params.installation_id ||
        challenge.license_id !== params.license_id ||
        challenge.session_id !== params.instance_session_id ||
        new Date(challenge.boot_started_at).toISOString() !== bootStartedAt ||
        (challenge.clientix_version ?? null) !== (params.app_version ?? null)
      ) {
        await this.ctx.db.query("ROLLBACK;");
        return {
          ok: false,
          status: 409,
          error: { code: "REPLAY_DETECTED", message: "Attestation could not be completed." },
        };
      }
      await this.ctx.db.query(
        `update control_plane.licensing_attestation_challenges set consumed_at = $2 where challenge_digest = $1;`,
        [digest, now.toISOString()],
      );

      const licenseStateResult = await this.ctx.db.query<{
        status: string;
        valid_from: string;
        expires_at: string;
        grace_days: number;
      }>(
        `select status, valid_from, expires_at, grace_days
           from control_plane.licensing_licenses where id = $1 for update;`,
        [params.license_id],
      );
      const licenseState = licenseStateResult.rows[0];
      if (!licenseState || licenseState.status === "DRAFT") {
        await this.ctx.db.query("ROLLBACK;");
        return {
          ok: false,
          status: 401,
          error: { code: "UNAUTHORIZED", message: "Attestation could not be completed." },
        };
      }
      const validFromMs = Date.parse(licenseState.valid_from);
      const expiresAtMs = Date.parse(licenseState.expires_at);
      const sessionEligible =
        licenseState.status === "ACTIVE" &&
        Number.isFinite(validFromMs) &&
        Number.isFinite(expiresAtMs) &&
        now.getTime() >= validFromMs &&
        now.getTime() < expiresAtMs + Number(licenseState.grace_days ?? 0) * 86_400_000;
      if (!sessionEligible) {
        // Return the signed authoritative state, but never open a boot session
        // for a suspended, revoked, or temporally unusable license.
        await this.ctx.db.query("COMMIT;");
        return this.heartbeat({
          ...params,
          instance_session_id: params.instance_session_id,
          requestPath: "/api/v1/licensing/validate-attestation",
        });
      }

      const existingSession = await this.ctx.db.query<{
        license_id: string;
        installation_id: string;
        boot_started_at: string;
        status: string;
      }>(
        `select license_id, installation_id, boot_started_at, status
           from control_plane.licensing_instance_sessions where session_id = $1 for update;`,
        [params.instance_session_id],
      );
      const storedSession = existingSession.rows[0];
      if (
        storedSession &&
        (storedSession.license_id !== params.license_id ||
          storedSession.installation_id !== params.installation_id)
      ) {
        await this.ctx.db.query("ROLLBACK;");
        return {
          ok: false,
          status: 401,
          error: { code: "UNAUTHORIZED", message: "Attestation could not be completed." },
        };
      }
      if (storedSession?.status === "ENDED") {
        await this.ctx.db.query("ROLLBACK;");
        return {
          ok: false,
          status: 409,
          error: {
            code: "INSTANCE_SESSION_ENDED",
            message: "Attestation could not be completed.",
          },
        };
      }
      if (
        storedSession &&
        (storedSession.status !== "ACTIVE" ||
          new Date(storedSession.boot_started_at).toISOString() !== bootStartedAt)
      ) {
        await this.ctx.db.query("ROLLBACK;");
        return {
          ok: false,
          status: 409,
          error: { code: "REPLAY_DETECTED", message: "Attestation could not be completed." },
        };
      }
      const isNewSession = existingSession.rows.length === 0;
      await this.ctx.db.query(
        `insert into control_plane.licensing_instance_sessions
           (session_id, license_id, installation_id, status, boot_started_at, started_at, last_heartbeat_at, clientix_version)
         values ($1, $2, $3, 'ACTIVE', $4, $5, $5, $6)
         on conflict (session_id) do update
           set last_heartbeat_at = excluded.last_heartbeat_at,
               clientix_version = coalesce(excluded.clientix_version, licensing_instance_sessions.clientix_version),
               updated_at = excluded.updated_at;`,
        [
          params.instance_session_id,
          params.license_id,
          params.installation_id,
          bootStartedAt,
          now.toISOString(),
          params.app_version ?? null,
        ],
      );

      const windowSeconds = this.ctx.cloneSessionWindowSeconds ?? 900;
      const freshSessions = await this.ctx.db.query<{
        session_id: string;
        started_at: string;
        last_heartbeat_at: string;
      }>(
        `select session_id, started_at, last_heartbeat_at
           from control_plane.licensing_instance_sessions
          where installation_id = $1 and status = 'ACTIVE' and last_heartbeat_at >= $2
          order by last_heartbeat_at desc limit 32;`,
        [params.installation_id, new Date(now.getTime() - windowSeconds * 1000).toISOString()],
      );
      const freshCount = freshSessions.rows.length;
      const concurrentSessionEvidence = hasConcurrentSessionEvidence(freshSessions.rows);
      const conflictSessionCount = concurrentSessionEvidence ? freshCount : Math.min(freshCount, 1);
      let anotherSessionReportedSinceConflict = false;
      if (installation.clone_status === "SUSPECTED_CLONE" && installation.last_clone_conflict_at) {
        const overlap = await this.ctx.db.query<{ reported: boolean }>(
          `select exists (
             select 1 from control_plane.licensing_instance_sessions
              where installation_id = $1
                and session_id <> $2
                and status = 'ACTIVE'
                and last_heartbeat_at >= $3
                and last_heartbeat_at > $4
           ) as reported;`,
          [
            params.installation_id,
            params.instance_session_id,
            new Date(now.getTime() - windowSeconds * 1000).toISOString(),
            installation.last_clone_conflict_at,
          ],
        );
        anotherSessionReportedSinceConflict = overlap.rows[0]?.reported === true;
      }
      const transition = transitionCloneStatus(
        installation.clone_status,
        conflictSessionCount,
        Number(installation.clone_conflict_count ?? 0),
        anotherSessionReportedSinceConflict,
      );
      cloneStatus = transition.status;
      if (transition.event === "CLONE_SUSPECTED" || transition.event === "CLONE_CONFIRMED") {
        await this.ctx.db.query(
          `update control_plane.licensing_installations
              set clone_status = $2, clone_conflict_count = clone_conflict_count + 1,
                  last_clone_conflict_at = $3, updated_at = $3 where id = $1;`,
          [params.installation_id, cloneStatus, now.toISOString()],
        );
      } else if (transition.event === "CLONE_CLEARED") {
        await this.ctx.db.query(
          `update control_plane.licensing_installations
              set clone_status = 'NORMAL', clone_conflict_count = 0,
                  last_clone_conflict_at = null, updated_at = $2 where id = $1;`,
          [params.installation_id, now.toISOString()],
        );
      }
      await this.recordEvent({
        licenseId: params.license_id,
        installationId: params.installation_id,
        eventType: isNewSession ? "INSTANCE_SESSION_STARTED" : "INSTANCE_SESSION_HEARTBEAT",
        payload: {
          session_id: params.instance_session_id,
          clientix_version: params.app_version ?? null,
        },
      });
      await this.recordEvent({
        licenseId: params.license_id,
        installationId: params.installation_id,
        eventType: "INSTALLATION_ATTESTED",
        payload: { session_id: params.instance_session_id },
      });
      if (transition.event) {
        await this.recordEvent({
          licenseId: params.license_id,
          installationId: params.installation_id,
          eventType: transition.event,
          payload: {
            fresh_session_count: freshCount,
            concurrent_session_evidence: concurrentSessionEvidence,
            heartbeat_window_seconds: windowSeconds,
          },
        });
      }
      await this.ctx.db.query("COMMIT;");
    } catch (error) {
      await this.ctx.db.query("ROLLBACK;").catch(() => undefined);
      throw error;
    }

    // Reuse the established signed-license response path. The challenge row is
    // the single-use proof; the existing request nonce store now protects the
    // final validation request against replay as well.
    const validated = await this.heartbeat({
      ...params,
      instance_session_id: params.instance_session_id,
      requestPath: "/api/v1/licensing/validate-attestation",
    });
    if (!validated.ok || !validated.data) return validated;
    return {
      ...validated,
      data: {
        ...validated.data,
        clone_status: cloneStatus,
        instance_session_id: params.instance_session_id,
      },
    };
  }

  async recoverInstallationKey(
    params: InstallationRecoveryParams,
  ): Promise<ServiceResult<InstallationRecoveryData>> {
    const now = this.now();
    if (this.ctx.rateLimiter) {
      const checks = [
        { key: `installation-recovery:${params.installation_id}`, maxHits: 8 },
        ...(params.clientIp
          ? [{ key: `installation-recovery-ip:${params.clientIp}`, maxHits: 30 }]
          : []),
      ];
      for (const check of checks) {
        const limit = await this.ctx.rateLimiter.checkLimit(check.key, check.maxHits, 60);
        if (!limit.allowed)
          return {
            ok: false,
            status: 429,
            error: {
              code: "RATE_LIMITED",
              message: "Installation recovery could not be completed.",
            },
          };
      }
    }
    if (
      !isValidCanonicalInstallationId(params.installation_id) ||
      !isValidInstallationPublicKey(params.installation_public_key) ||
      !/^REC_[A-Za-z0-9_-]{40,48}$/.test(params.recovery_code)
    ) {
      return {
        ok: false,
        status: 400,
        error: {
          code: "MALFORMED_REQUEST",
          message: "Installation recovery could not be completed.",
        },
      };
    }
    const fingerprint = computePublicKeyFingerprint(params.installation_public_key);
    const proof = await verifyInstallationRequestSignature({
      installationId: params.installation_id,
      timestamp: params.timestamp,
      nonce: params.nonce,
      method: "POST",
      path: "/api/v1/licensing/recover-installation",
      body: params.rawBody,
      signatureBase64url: params.signatureBase64url,
      publicKeyPem: params.installation_public_key,
      nonceStore: this.ctx.nonceStore,
      currentTimestampUnixSeconds: Math.floor(now.getTime() / 1000),
    });
    if (!proof.ok) {
      return {
        ok: false,
        status: proof.code === "REPLAY_DETECTED" ? 409 : 401,
        error: {
          code:
            proof.code === "REPLAY_DETECTED" ? "REPLAY_DETECTED" : "INVALID_INSTALLATION_SIGNATURE",
          message: "Installation recovery could not be completed.",
        },
      };
    }

    const codeDigest = crypto
      .createHmac("sha256", this.ctx.pepper)
      .update(`installation-recovery:${params.recovery_code.trim()}`, "utf8")
      .digest("hex");
    await this.ctx.db.query("BEGIN;");
    try {
      const installationResult = await this.ctx.db.query<{
        id: string;
        license_id: string;
        status: string;
        public_key_fingerprint: string;
      }>(
        `select id, license_id, status, public_key_fingerprint
           from control_plane.licensing_installations where id = $1 for update;`,
        [params.installation_id],
      );
      const installation = installationResult.rows[0];
      const recoveryResult = await this.ctx.db.query<{
        id: string;
        expires_at: string;
        consumed_at: string | null;
        consumed_public_key_fingerprint: string | null;
      }>(
        `select id, expires_at, consumed_at, consumed_public_key_fingerprint
           from control_plane.licensing_installation_recoveries
          where installation_id = $1 and code_digest = $2 for update;`,
        [params.installation_id, codeDigest],
      );
      const recovery = recoveryResult.rows[0];
      if (!installation || installation.status !== "ACTIVE" || !recovery) {
        await this.ctx.db.query("ROLLBACK;");
        return {
          ok: false,
          status: 401,
          error: { code: "UNAUTHORIZED", message: "Installation recovery could not be completed." },
        };
      }
      const retryAlreadyCommitted =
        recovery.consumed_at !== null &&
        recovery.consumed_public_key_fingerprint === fingerprint &&
        installation.public_key_fingerprint === fingerprint;
      if (recovery.consumed_at && !retryAlreadyCommitted) {
        await this.ctx.db.query("ROLLBACK;");
        return {
          ok: false,
          status: 409,
          error: { code: "UNAUTHORIZED", message: "Installation recovery could not be completed." },
        };
      }
      if (Date.parse(recovery.expires_at) <= now.getTime() && !retryAlreadyCommitted) {
        await this.ctx.db.query("ROLLBACK;");
        return {
          ok: false,
          status: 401,
          error: { code: "UNAUTHORIZED", message: "Installation recovery could not be completed." },
        };
      }
      if (!retryAlreadyCommitted) {
        await this.ctx.db.query(
          `update control_plane.licensing_installations
              set public_key = $2, public_key_fingerprint = $3, clone_status = 'NORMAL',
                  clone_conflict_count = 0, last_clone_conflict_at = null, updated_at = $4
            where id = $1;`,
          [params.installation_id, params.installation_public_key, fingerprint, now.toISOString()],
        );
        const ended = await this.ctx.db.query<{ session_id: string }>(
          `update control_plane.licensing_instance_sessions
              set status = 'ENDED', ended_at = $2, updated_at = $2
            where installation_id = $1 and status = 'ACTIVE'
            returning session_id;`,
          [params.installation_id, now.toISOString()],
        );
        await this.ctx.db.query(
          `update control_plane.licensing_installation_recoveries
              set consumed_at = $2, consumed_public_key_fingerprint = $3 where id = $1;`,
          [recovery.id, now.toISOString(), fingerprint],
        );
        for (const row of ended.rows) {
          await this.recordEvent({
            licenseId: installation.license_id,
            installationId: params.installation_id,
            eventType: "INSTANCE_SESSION_ENDED",
            payload: { session_id: row.session_id, reason: "installation_key_rotated" },
          });
        }
        await this.recordEvent({
          licenseId: installation.license_id,
          installationId: params.installation_id,
          eventType: "INSTALLATION_KEY_ROTATED",
          payload: { public_key_fingerprint: fingerprint },
        });
        await this.recordEvent({
          licenseId: installation.license_id,
          installationId: params.installation_id,
          eventType: "CLONE_CLEARED",
          payload: { reason: "vendor_authorized_recovery" },
        });
      }
      await this.ctx.db.query("COMMIT;");
      return {
        ok: true,
        status: 200,
        data: {
          installation_id: params.installation_id,
          public_key_fingerprint: fingerprint,
          clone_status: "NORMAL",
          server_timestamp: now.toISOString(),
        },
      };
    } catch (error) {
      await this.ctx.db.query("ROLLBACK;").catch(() => undefined);
      throw error;
    }
  }

  private buildLicensePayload(
    lic: Omit<DatabaseLicenseCustomerRow, "status"> & {
      status: Exclude<DatabaseLicenseCustomerRow["status"], "DRAFT">;
    },
    installationId: string,
    serverTimestamp: string,
  ): LicensePayload {
    return {
      license_version: 1,
      license_revision: lic.license_revision ? Number(lic.license_revision) : 1,
      license_id: lic.id,
      serial: lic.serial,
      product: lic.product ?? "clientix",
      deployment: lic.deployment ?? "self-hosted",
      plan: lic.plan ?? "pro",
      status: lic.status,
      customer: {
        id: lic.cust_id,
        name: lic.cust_name,
        email: lic.cust_email || undefined,
        country: lic.cust_country || undefined,
      },
      license_type: lic.license_type,
      installation_id: installationId,
      entitlements: {
        max_installations: lic.max_installations,
        max_tenants: lic.max_tenants,
        resale_allowed: lic.resale_allowed,
        white_label: lic.white_label,
        features: lic.features,
      },
      grace_period_days: lic.grace_days,
      issued_at: lic.issued_at ? new Date(lic.issued_at).toISOString() : serverTimestamp,
      valid_from: new Date(lic.valid_from).toISOString(),
      expires_at: new Date(lic.expires_at).toISOString(),
      maintenance_until: lic.maintenance_until
        ? new Date(lic.maintenance_until).toISOString()
        : undefined,
    };
  }

  private async resumeExistingActivation(params: {
    installationId: string;
    publicKeyFingerprint: string;
    codeHash: string;
    serverTimestamp: string;
    installation: {
      id: string;
      license_id: string;
      public_key_fingerprint: string;
      activation_code_id?: string | null;
      status: "ACTIVE" | "SUSPENDED" | "REVOKED" | "DEACTIVATED" | "TRANSFERRED" | "DISABLED";
    };
  }): Promise<ServiceResult<ActivationResponseData>> {
    const { installation } = params;
    if (installation.public_key_fingerprint !== params.publicKeyFingerprint) {
      await this.recordEvent({
        installationId: installation.id,
        eventType: "ACTIVATION_FAILED",
        payload: { reason: "KEY_MISMATCH" },
      });
      return {
        ok: false,
        status: 409,
        error: {
          code: "INSTALLATION_KEY_MISMATCH",
          message: "Installation already registered with a different public key.",
        },
      };
    }

    if (installation.status !== "ACTIVE") {
      return {
        ok: false,
        status: 403,
        error: { code: "UNAUTHORIZED", message: "Activation could not be completed." },
      };
    }

    const licenseResult = await this.ctx.db.query<DatabaseLicenseCustomerRow>(
      `select l.*, c.id as cust_id, c.name as cust_name, c.billing_email as cust_email, c.country as cust_country, c.status as cust_status
       from control_plane.licensing_licenses l
       join control_plane.licensing_customers c on c.id = l.customer_id
       where l.id = $1;`,
      [installation.license_id],
    );
    const license = licenseResult.rows[0];
    if (
      !license ||
      license.status === "DRAFT" ||
      license.status === "REVOKED" ||
      license.status === "SUSPENDED" ||
      license.cust_status === "DISABLED"
    ) {
      return {
        ok: false,
        status: 403,
        error: { code: "ACTIVATION_INVALID", message: "Activation could not be completed." },
      };
    }

    const activationResult = await this.ctx.db.query<{ id: string }>(
      `select id from control_plane.licensing_activation_codes
       where code_hash = $1 and license_id = $2 and revoked_at is null
         and expires_at > $3 and used_count > 0
       limit 1;`,
      [params.codeHash, license.id, params.serverTimestamp],
    );
    const activationCodeId = activationResult.rows[0]?.id;
    if (
      !activationCodeId ||
      (installation.activation_code_id != null &&
        installation.activation_code_id !== activationCodeId)
    ) {
      return {
        ok: false,
        status: 403,
        error: { code: "ACTIVATION_INVALID", message: "Activation could not be completed." },
      };
    }

    const issueableLicense = {
      ...license,
      status: license.status as "ACTIVE" | "EXPIRED",
    };
    const payload = this.buildLicensePayload(
      issueableLicense,
      params.installationId,
      params.serverTimestamp,
    );
    const signed =
      issueableLicense.status === "ACTIVE"
        ? await this.licenseArtifacts.issueCurrentForInstallation({
            licenseId: issueableLicense.id,
            installationId: params.installationId,
            source: "ACTIVATION",
          })
        : await this.signCurrentLicense(
            payload,
            issueableLicense.id,
            issueableLicense.signing_key_id,
          );
    return {
      ok: true,
      status: 200,
      data: {
        signed_license: signed,
        license_status: license.status,
        installation_status: installation.status,
        server_timestamp: params.serverTimestamp,
      },
    };
  }

  /**
   * Helper to append an audit event into control_plane.licensing_events.
   */
  private async recordEvent(params: {
    licenseId?: string | null;
    installationId?: string | null;
    eventType: string;
    payload?: Record<string, unknown>;
    actor?: string;
  }): Promise<void> {
    await this.ctx.db.query(
      `insert into control_plane.licensing_events (license_id, installation_id, event_type, payload, actor, created_at)
       values ($1, $2, $3, $4, $5, now());`,
      [
        params.licenseId ?? null,
        params.installationId ?? null,
        params.eventType,
        JSON.stringify(params.payload ?? {}),
        params.actor ?? "system",
      ],
    );
  }

  // =========================================================================
  // 1. ACTIVATION ENDPOINT (POST /api/v1/licensing/activate)
  // =========================================================================
  async activate(params: ActivationParams): Promise<ServiceResult<ActivationResponseData>> {
    const serverDate = this.now();
    const serverTimestamp = serverDate.toISOString();

    // 1. Rate Limiting Check
    if (this.ctx.rateLimiter) {
      const keys = [
        { key: `act:installation:${params.installation_id}`, maxHits: 10 },
        ...(params.clientIp ? [{ key: `act:ip:${params.clientIp}`, maxHits: 60 }] : []),
      ];
      for (const policy of keys) {
        const limit = await this.ctx.rateLimiter.checkLimit(policy.key, policy.maxHits, 60);
        if (!limit.allowed) {
          return {
            ok: false,
            status: 429,
            error: {
              code: "RATE_LIMITED",
              message: "Too many activation attempts. Rate limit exceeded.",
            },
          };
        }
      }
    }

    // 2. Validate format contracts
    if (!isValidCanonicalInstallationId(params.installation_id)) {
      return {
        ok: false,
        status: 400,
        error: {
          code: "MALFORMED_REQUEST",
          message: "Invalid installation_id format (expected inst_<UUIDv4>).",
        },
      };
    }

    if (!isValidInstallationPublicKey(params.installation_public_key)) {
      return {
        ok: false,
        status: 400,
        error: { code: "MALFORMED_REQUEST", message: "Invalid Ed25519 SPKI public key PEM." },
      };
    }

    if (
      !params.activation_code ||
      typeof params.activation_code !== "string" ||
      !params.activation_code.startsWith("ACT_")
    ) {
      return {
        ok: false,
        status: 400,
        error: { code: "MALFORMED_REQUEST", message: "Invalid activation code format." },
      };
    }

    // 3. Compute code hash
    const codeHash = deriveActivationCodeDigest(params.activation_code, this.ctx.pepper);
    const pubKeyFingerprint = computePublicKeyFingerprint(params.installation_public_key);

    // 4. Check if this exact installation is ALREADY ACTIVATED (Idempotent Retry Flow)
    const existingInstRes = await this.ctx.db.query<{
      id: string;
      license_id: string;
      public_key_fingerprint: string;
      activation_code_id: string | null;
      status: "ACTIVE" | "SUSPENDED" | "REVOKED" | "DEACTIVATED" | "TRANSFERRED" | "DISABLED";
    }>(
      `select id, license_id, public_key_fingerprint, activation_code_id, status
       from control_plane.licensing_installations where id = $1;`,
      [params.installation_id],
    );

    if (existingInstRes.rows.length > 0) {
      return this.resumeExistingActivation({
        installationId: params.installation_id,
        publicKeyFingerprint: pubKeyFingerprint,
        codeHash,
        serverTimestamp,
        installation: existingInstRes.rows[0]!,
      });
    }

    // 5. Atomic Activation Transaction
    // Steps inside transaction:
    // a) Lock & consume activation code
    // b) Check license status and slot count
    // c) Insert installation
    // d) Audit event
    await this.ctx.db.query("BEGIN;");
    try {
      // Find and lock activation code
      const codeRes = await this.ctx.db.query<{
        id: string;
        license_id: string;
        max_uses: number;
        used_count: number;
        expires_at: string;
        revoked_at: string | null;
      }>(
        `select id, license_id, max_uses, used_count, expires_at, revoked_at
         from control_plane.licensing_activation_codes
         where code_hash = $1
         for update;`,
        [codeHash],
      );

      if (codeRes.rows.length === 0) {
        await this.ctx.db.query("ROLLBACK;");
        return {
          ok: false,
          status: 403,
          error: { code: "ACTIVATION_INVALID", message: "Activation code not found or invalid." },
        };
      }

      const codeRow = codeRes.rows[0]!;
      const concurrentInstallationRes = await this.ctx.db.query<{
        id: string;
        license_id: string;
        public_key_fingerprint: string;
        activation_code_id: string | null;
        status: "ACTIVE" | "SUSPENDED" | "REVOKED" | "DEACTIVATED" | "TRANSFERRED" | "DISABLED";
      }>(
        `select id, license_id, public_key_fingerprint, activation_code_id, status
         from control_plane.licensing_installations where id = $1 for update;`,
        [params.installation_id],
      );
      if (concurrentInstallationRes.rows.length > 0) {
        await this.ctx.db.query("ROLLBACK;");
        return this.resumeExistingActivation({
          installationId: params.installation_id,
          publicKeyFingerprint: pubKeyFingerprint,
          codeHash,
          serverTimestamp,
          installation: concurrentInstallationRes.rows[0]!,
        });
      }

      if (codeRow.revoked_at !== null) {
        await this.ctx.db.query("ROLLBACK;");
        return {
          ok: false,
          status: 403,
          error: { code: "ACTIVATION_INVALID", message: "Activation code has been revoked." },
        };
      }

      if (new Date(codeRow.expires_at).getTime() <= serverDate.getTime()) {
        await this.ctx.db.query("ROLLBACK;");
        return {
          ok: false,
          status: 403,
          error: { code: "ACTIVATION_EXPIRED", message: "Activation code has expired." },
        };
      }

      if (codeRow.used_count >= codeRow.max_uses) {
        await this.ctx.db.query("ROLLBACK;");
        return {
          ok: false,
          status: 409,
          error: {
            code: "ACTIVATION_CODE_EXHAUSTED",
            message: "Activation code usage limit reached.",
          },
        };
      }

      // Lock license row to check max_installations quota
      const licRes = await this.ctx.db.query<DatabaseLicenseCustomerRow>(
        `select l.*, c.id as cust_id, c.name as cust_name, c.billing_email as cust_email, c.country as cust_country, c.status as cust_status
         from control_plane.licensing_licenses l
         join control_plane.licensing_customers c on c.id = l.customer_id
         where l.id = $1
         for update;`,
        [codeRow.license_id],
      );

      if (licRes.rows.length === 0) {
        await this.ctx.db.query("ROLLBACK;");
        return {
          ok: false,
          status: 403,
          error: { code: "ACTIVATION_INVALID", message: "Associated license not found." },
        };
      }

      const lic = licRes.rows[0]!;
      if (lic.cust_status === "DISABLED") {
        await this.ctx.db.query("ROLLBACK;");
        return {
          ok: false,
          status: 403,
          error: { code: "ACTIVATION_INVALID", message: "Activation could not be completed." },
        };
      }
      if (lic.product !== "clientix" || lic.deployment !== "self-hosted") {
        await this.ctx.db.query("ROLLBACK;");
        return {
          ok: false,
          status: 403,
          error: { code: "ACTIVATION_INVALID", message: "Activation could not be completed." },
        };
      }
      if (lic.status === "SUSPENDED") {
        await this.ctx.db.query("ROLLBACK;");
        return {
          ok: false,
          status: 403,
          error: { code: "LICENSE_SUSPENDED", message: "License is suspended." },
        };
      }

      if (lic.status === "REVOKED") {
        await this.ctx.db.query("ROLLBACK;");
        return {
          ok: false,
          status: 403,
          error: { code: "LICENSE_REVOKED", message: "License is revoked." },
        };
      }

      if (lic.status === "DRAFT" || lic.status === "EXPIRED") {
        await this.ctx.db.query("ROLLBACK;");
        return {
          ok: false,
          status: 403,
          error: { code: "LICENSE_EXPIRED", message: "License is not eligible for activation." },
        };
      }

      if (serverDate.getTime() > new Date(lic.expires_at).getTime()) {
        await this.ctx.db.query("ROLLBACK;");
        return {
          ok: false,
          status: 403,
          error: { code: "LICENSE_EXPIRED", message: "License expired. New activations denied." },
        };
      }

      // Check slot quota
      const slotRes = await this.ctx.db.query<{ count: string }>(
        `select count(*)::text as count from control_plane.licensing_installations
         where license_id = $1 and status = 'ACTIVE';`,
        [lic.id],
      );
      const currentSlots = parseInt(slotRes.rows[0]!.count, 10);
      if (currentSlots >= lic.max_installations) {
        await this.ctx.db.query("ROLLBACK;");
        return {
          ok: false,
          status: 409,
          error: {
            code: "ACTIVATION_LIMIT_REACHED",
            message: "Maximum installations limit reached for this license.",
          },
        };
      }

      // Check public key uniqueness across all installations
      const fpCheck = await this.ctx.db.query(
        `select id from control_plane.licensing_installations where public_key_fingerprint = $1;`,
        [pubKeyFingerprint],
      );
      if (fpCheck.rows.length > 0) {
        await this.ctx.db.query("ROLLBACK;");
        return {
          ok: false,
          status: 409,
          error: {
            code: "INSTALLATION_KEY_MISMATCH",
            message: "Public key is already associated with another installation.",
          },
        };
      }

      // Increment used_count atomically
      await this.ctx.db.query(
        `update control_plane.licensing_activation_codes
         set used_count = used_count + 1
         where id = $1;`,
        [codeRow.id],
      );

      // Insert installation
      await this.ctx.db.query(
        `insert into control_plane.licensing_installations
         (id, license_id, public_key, public_key_fingerprint, activation_code_id, status, environment, app_version, clientix_version,
          last_heartbeat_at, last_seen_at, last_validation_at, created_at, updated_at)
         values ($1, $2, $3, $4, $5, 'ACTIVE', 'production', $6, $6, now(), now(), now(), now(), now());`,
        [
          params.installation_id,
          lic.id,
          params.installation_public_key,
          pubKeyFingerprint,
          codeRow.id,
          params.app_version || null,
        ],
      );

      // Record audit event
      await this.recordEvent({
        licenseId: lic.id,
        installationId: params.installation_id,
        eventType: "LICENSE_ACTIVATED",
        payload: {
          app_version: params.app_version,
          fingerprint: pubKeyFingerprint,
        },
      });

      await this.ctx.db.query("COMMIT;");

      const signed = await this.licenseArtifacts.issueCurrentForInstallation({
        licenseId: lic.id,
        installationId: params.installation_id,
        source: "ACTIVATION",
      });

      // Verification before response parity check
      new LicenseIssuer(this.ctx.signerProvider, this.ctx.trustedPublicKeyMap).verifyIssuedLicense(
        signed,
        params.installation_id,
      );

      return {
        ok: true,
        status: 200,
        data: {
          signed_license: signed,
          license_status: "ACTIVE",
          installation_status: "ACTIVE",
          server_timestamp: serverTimestamp,
        },
      };
    } catch (err: unknown) {
      await this.ctx.db.query("ROLLBACK;").catch(() => {});
      throw err;
    }
  }

  // =========================================================================
  // 2. HEARTBEAT ENDPOINT (POST /api/v1/licensing/heartbeat)
  // =========================================================================
  async heartbeat(params: HeartbeatParams): Promise<ServiceResult<HeartbeatResponseData>> {
    const serverDate = this.now();
    const serverTimestamp = serverDate.toISOString();

    // 1. Rate Limiting Check for Heartbeat
    if (this.ctx.rateLimiter) {
      const keys = [
        { key: `hb:installation:${params.installation_id}`, maxHits: 60 },
        ...(params.clientIp ? [{ key: `hb:ip:${params.clientIp}`, maxHits: 240 }] : []),
      ];
      for (const policy of keys) {
        const limit = await this.ctx.rateLimiter.checkLimit(policy.key, policy.maxHits, 60);
        if (!limit.allowed) {
          return {
            ok: false,
            status: 429,
            error: {
              code: "RATE_LIMITED",
              message: "Too many heartbeat requests. Rate limit exceeded.",
            },
          };
        }
      }
    }

    // 2. Strict Privacy Filtering: Reject any sensitive payload fields
    const sensitiveKeys = [
      "message",
      "messages",
      "contact",
      "contacts",
      "conversation",
      "conversation_text",
      "customer_pii",
      "tenant_data",
      "tenants",
      "leads",
    ];
    if (params.rawBody) {
      try {
        const parsed = JSON.parse(params.rawBody);
        if (typeof parsed === "object" && parsed !== null) {
          for (const key of sensitiveKeys) {
            if (key in parsed) {
              return {
                ok: false,
                status: 400,
                error: {
                  code: "MALFORMED_REQUEST",
                  message: `Privacy violation: forbidden payload attribute "${key}" detected in heartbeat.`,
                },
              };
            }
          }
        }
      } catch {
        // Ignored if rawBody is not JSON
      }
    }

    // 3. Installation ID & Installation lookup
    const instRes = await this.ctx.db.query<{
      id: string;
      license_id: string;
      public_key: string;
      status: "ACTIVE" | "SUSPENDED" | "REVOKED" | "DEACTIVATED" | "TRANSFERRED" | "DISABLED";
      clone_status: CloneStatus;
    }>(
      `select id, license_id, public_key, status, clone_status from control_plane.licensing_installations where id = $1;`,
      [params.installation_id],
    );

    if (instRes.rows.length === 0) {
      return {
        ok: false,
        status: 404,
        error: { code: "UNAUTHORIZED", message: "Installation not found." },
      };
    }

    const inst = instRes.rows[0]!;
    const cloneStatus = inst.clone_status ?? "NORMAL";

    // 4. Proof-of-Possession (PoP) Authentication Check
    const bodyObject: Record<string, unknown> = {
      installation_id: params.installation_id,
      timestamp: params.timestamp,
      nonce: params.nonce,
    };
    if (params.license_id !== undefined) bodyObject.license_id = params.license_id;
    if (params.app_version !== undefined) bodyObject.app_version = params.app_version;
    if (params.schema_version !== undefined) bodyObject.schema_version = params.schema_version;
    if (params.release_version !== undefined) bodyObject.release_version = params.release_version;
    if (params.local_license_state !== undefined)
      bodyObject.local_license_state = params.local_license_state;

    const serializedBody =
      params.rawBody !== undefined ? params.rawBody : JSON.stringify(bodyObject);

    const authCheck = await verifyInstallationRequestSignature({
      installationId: params.installation_id,
      timestamp: params.timestamp,
      nonce: params.nonce,
      method: "POST",
      path: params.requestPath ?? "/api/v1/licensing/heartbeat",
      body: serializedBody,
      signatureBase64url: params.signatureBase64url,
      publicKeyPem: inst.public_key,
      nonceStore: this.ctx.nonceStore,
      currentTimestampUnixSeconds: Math.floor(serverDate.getTime() / 1000),
    });

    if (!authCheck.ok) {
      if (authCheck.code === "REPLAY_DETECTED") {
        return {
          ok: false,
          status: 409,
          error: { code: "REPLAY_DETECTED", message: "Replay attack detected." },
        };
      }
      if (authCheck.code === "INVALID_TIMESTAMP") {
        return {
          ok: false,
          status: 401,
          error: {
            code: "CLOCK_SKEW_EXCEEDED",
            message: "Timestamp outside allowable clock drift window.",
          },
        };
      }
      return {
        ok: false,
        status: 401,
        error: {
          code: "INVALID_INSTALLATION_SIGNATURE",
          message: "Invalid installation cryptographic signature.",
        },
      };
    }

    if (params.license_id && params.license_id !== inst.license_id) {
      return {
        ok: false,
        status: 401,
        error: { code: "UNAUTHORIZED", message: "Validation could not be completed." },
      };
    }

    // Read the authoritative commercial state and only the minimum customer fields
    // required to issue the installation-scoped signed document.
    const licRes = await this.ctx.db.query<DatabaseLicenseCustomerRow>(
      `select l.*, c.id as cust_id, c.name as cust_name, c.billing_email as cust_email, c.country as cust_country, c.status as cust_status
       from control_plane.licensing_licenses l
       join control_plane.licensing_customers c on c.id = l.customer_id
       where l.id = $1;`,
      [inst.license_id],
    );
    const lic = licRes.rows[0];
    if (!lic)
      return {
        ok: false,
        status: 401,
        error: { code: "UNAUTHORIZED", message: "Validation could not be completed." },
      };
    if (lic.status === "DRAFT" || lic.product !== "clientix" || lic.deployment !== "self-hosted") {
      return {
        ok: false,
        status: 401,
        error: { code: "UNAUTHORIZED", message: "Validation could not be completed." },
      };
    }

    const activeInstallationCount = await this.ctx.db.query<{ count: number | string }>(
      `select count(*)::int as count from control_plane.licensing_installations
       where license_id = $1 and status = 'ACTIVE';`,
      [lic.id],
    );
    if (
      Number(activeInstallationCount.rows[0]?.count ?? Number.MAX_SAFE_INTEGER) >
      lic.max_installations
    ) {
      return {
        ok: false,
        status: 403,
        error: { code: "UNAUTHORIZED", message: "Validation could not be completed." },
      };
    }

    // Compute temporal state
    const nowMs = serverDate.getTime();
    const validFromMs = new Date(lic.valid_from).getTime();
    const expiresAtMs = new Date(lic.expires_at).getTime();
    const graceMs = lic.grace_days * 24 * 60 * 60 * 1000;

    let temporalState: "NOT_YET_VALID" | "VALID" | "GRACE" | "EXPIRED" = "VALID";
    if (nowMs < validFromMs) {
      temporalState = "NOT_YET_VALID";
    } else if (nowMs < expiresAtMs) {
      temporalState = "VALID";
    } else if (nowMs < expiresAtMs + graceMs) {
      temporalState = "GRACE";
    } else {
      temporalState = "EXPIRED";
    }

    // 4. Update heartbeat info (without touching business or tenant data)
    await this.ctx.db.query(
      `update control_plane.licensing_installations
       set last_heartbeat_at = now(),
           last_seen_at = now(),
           last_validation_at = now(),
           app_version = coalesce($2, app_version),
           clientix_version = coalesce($2, clientix_version),
           updated_at = now()
       where id = $1;`,
      [params.installation_id, params.app_version || null],
    );

    await this.recordEvent({
      licenseId: lic.id,
      installationId: inst.id,
      eventType: "LICENSE_VALIDATED",
      payload: {
        app_version: params.app_version,
        schema_version: params.schema_version,
      },
    });

    const licenseStatus =
      cloneStatus === "CLONE_CONFIRMED" || cloneStatus === "TRANSFER_PENDING"
        ? "SUSPENDED"
        : inst.status === "SUSPENDED" || lic.cust_status === "DISABLED"
          ? "SUSPENDED"
          : inst.status !== "ACTIVE"
            ? "REVOKED"
            : lic.status === "ACTIVE" && temporalState === "EXPIRED"
              ? "EXPIRED"
              : lic.status;
    const signedStatus = licenseStatus;
    const payload: LicensePayload = {
      license_version: 1,
      license_revision: lic.license_revision ? Number(lic.license_revision) : 1,
      license_id: lic.id,
      serial: lic.serial,
      product: lic.product ?? "clientix",
      deployment: lic.deployment ?? "self-hosted",
      plan: lic.plan ?? "pro",
      status: signedStatus,
      customer: {
        id: lic.cust_id,
        name: lic.cust_name,
        email: lic.cust_email || undefined,
        country: lic.cust_country || undefined,
      },
      license_type: lic.license_type,
      installation_id: inst.id,
      entitlements: {
        max_installations: lic.max_installations,
        max_tenants: lic.max_tenants,
        resale_allowed: lic.resale_allowed,
        white_label: lic.white_label,
        features: lic.features,
      },
      grace_period_days: lic.grace_days,
      issued_at: lic.issued_at ? new Date(lic.issued_at).toISOString() : serverTimestamp,
      valid_from: new Date(lic.valid_from).toISOString(),
      expires_at: new Date(lic.expires_at).toISOString(),
      maintenance_until: lic.maintenance_until
        ? new Date(lic.maintenance_until).toISOString()
        : undefined,
    };
    const signedLicense =
      signedStatus === "ACTIVE" && inst.status === "ACTIVE" && cloneStatus === "NORMAL"
        ? await this.licenseArtifacts.issueCurrentForInstallation({
            licenseId: lic.id,
            installationId: inst.id,
            source: "ONLINE_VALIDATION",
          })
        : await this.signCurrentLicense(payload, lic.id, lic.signing_key_id);

    return {
      ok: true,
      status: 200,
      data: {
        license_id: lic.id,
        signed_license: signedLicense,
        license_status: licenseStatus,
        installation_status: inst.status,
        temporal_state: temporalState,
        server_timestamp: serverTimestamp,
        clone_status: cloneStatus,
        ...(params.instance_session_id ? { instance_session_id: params.instance_session_id } : {}),
      },
    };
  }

  // =========================================================================
  // 3. RENEWAL ENDPOINT (POST /api/v1/licensing/renew)
  // =========================================================================
  async renew(params: RenewalParams): Promise<ServiceResult<RenewalResponseData>> {
    const serverDate = this.now();
    const serverTimestamp = serverDate.toISOString();

    // Rate Limiting Check for Renewal
    if (this.ctx.rateLimiter) {
      const rateKey = `renew:${params.installation_id}`;
      const limit = await this.ctx.rateLimiter.checkLimit(rateKey, 20, 60);
      if (!limit.allowed) {
        return {
          ok: false,
          status: 429,
          error: {
            code: "RATE_LIMITED",
            message: "Too many renewal requests. Rate limit exceeded.",
          },
        };
      }
    }

    const instRes = await this.ctx.db.query<{
      id: string;
      license_id: string;
      public_key: string;
      status: "ACTIVE" | "SUSPENDED" | "REVOKED" | "DEACTIVATED";
    }>(
      `select id, license_id, public_key, status from control_plane.licensing_installations where id = $1;`,
      [params.installation_id],
    );

    if (instRes.rows.length === 0) {
      return {
        ok: false,
        status: 404,
        error: { code: "UNAUTHORIZED", message: "Installation not found." },
      };
    }

    const inst = instRes.rows[0]!;

    // PoP verification
    const authCheck = await verifyInstallationRequestSignature({
      installationId: params.installation_id,
      timestamp: params.timestamp,
      nonce: params.nonce,
      method: "POST",
      path: "/api/v1/licensing/renew",
      body: JSON.stringify({
        installation_id: params.installation_id,
        timestamp: params.timestamp,
        nonce: params.nonce,
      }),
      signatureBase64url: params.signatureBase64url,
      publicKeyPem: inst.public_key,
      nonceStore: this.ctx.nonceStore,
      currentTimestampUnixSeconds: Math.floor(serverDate.getTime() / 1000),
    });

    if (!authCheck.ok) {
      if (authCheck.code === "REPLAY_DETECTED") {
        return {
          ok: false,
          status: 409,
          error: { code: "REPLAY_DETECTED", message: "Replay attack detected." },
        };
      }
      if (authCheck.code === "INVALID_TIMESTAMP") {
        return {
          ok: false,
          status: 401,
          error: {
            code: "CLOCK_SKEW_EXCEEDED",
            message: "Timestamp outside allowable clock drift window.",
          },
        };
      }
      return {
        ok: false,
        status: 401,
        error: { code: "INVALID_INSTALLATION_SIGNATURE", message: "Invalid signature." },
      };
    }

    // Query license
    const licRes = await this.ctx.db.query<DatabaseLicenseCustomerRow>(
      `select l.*, c.id as cust_id, c.name as cust_name, c.billing_email as cust_email, c.country as cust_country
       from control_plane.licensing_licenses l
       join control_plane.licensing_customers c on c.id = l.customer_id
       where l.id = $1;`,
      [inst.license_id],
    );

    const lic = licRes.rows[0]!;

    if (lic.status === "DRAFT") {
      return {
        ok: false,
        status: 403,
        error: { code: "RENEWAL_NOT_ALLOWED", message: "License is not eligible for renewal." },
      };
    }
    if (lic.status === "REVOKED" || inst.status === "REVOKED") {
      return {
        ok: false,
        status: 403,
        error: {
          code: "LICENSE_REVOKED",
          message: "License or installation is revoked. Renewal denied.",
        },
      };
    }

    if (lic.status === "SUSPENDED" || inst.status === "SUSPENDED") {
      return {
        ok: false,
        status: 403,
        error: { code: "LICENSE_SUSPENDED", message: "License or installation is suspended." },
      };
    }

    // Temporal State Check:
    // Follow explicitly defined policy:
    // Client self-service renewal is permitted during VALID and GRACE periods.
    // If the license is fully EXPIRED (past grace period), self-service renewal is DENIED (requires admin recovery).
    const nowMs = serverDate.getTime();
    const expiresAtMs = new Date(lic.expires_at).getTime();
    const graceMs = (lic.grace_days ?? 7) * 24 * 60 * 60 * 1000;
    if (nowMs >= expiresAtMs + graceMs) {
      return {
        ok: false,
        status: 403,
        error: {
          code: "RENEWAL_NOT_ALLOWED",
          message: "License is expired past grace period. Contact vendor administrator.",
        },
      };
    }

    // Issue refreshed/renewed document
    const payload: LicensePayload = {
      license_version: 1,
      license_id: lic.id,
      serial: lic.serial,
      product: lic.product ?? "clientix",
      deployment: lic.deployment ?? "self-hosted",
      plan: lic.plan ?? "pro",
      status: lic.status,
      customer: {
        id: lic.cust_id,
        name: lic.cust_name,
        email: lic.cust_email || undefined,
        country: lic.cust_country || undefined,
      },
      license_type: lic.license_type,
      installation_id: params.installation_id,
      entitlements: {
        max_installations: lic.max_installations,
        max_tenants: lic.max_tenants,
        resale_allowed: lic.resale_allowed,
        white_label: lic.white_label,
        features: lic.features,
      },
      grace_period_days: lic.grace_days,
      issued_at: serverTimestamp,
      valid_from: new Date(lic.valid_from).toISOString(),
      expires_at: new Date(lic.expires_at).toISOString(),
      maintenance_until: lic.maintenance_until
        ? new Date(lic.maintenance_until).toISOString()
        : undefined,
    };

    const signed = await this.signCurrentLicense(payload, lic.id, lic.signing_key_id);

    await this.recordEvent({
      licenseId: lic.id,
      installationId: inst.id,
      eventType: "LICENSE_RENEWED",
      payload: { renewed_at: serverTimestamp },
    });

    return {
      ok: true,
      status: 200,
      data: {
        signed_license: signed,
        server_timestamp: serverTimestamp,
      },
    };
  }

  // =========================================================================
  // 4. DEACTIVATION ENDPOINT (POST /api/v1/licensing/deactivate)
  // =========================================================================
  async deactivate(params: DeactivationParams): Promise<ServiceResult<DeactivationResponseData>> {
    const serverDate = this.now();
    const serverTimestamp = serverDate.toISOString();

    // Rate Limiting Check for Deactivation
    if (this.ctx.rateLimiter) {
      const rateKey = `deact:${params.installation_id}`;
      const limit = await this.ctx.rateLimiter.checkLimit(rateKey, 10, 60);
      if (!limit.allowed) {
        return {
          ok: false,
          status: 429,
          error: {
            code: "RATE_LIMITED",
            message: "Too many deactivation requests. Rate limit exceeded.",
          },
        };
      }
    }

    const instRes = await this.ctx.db.query<{
      id: string;
      license_id: string;
      public_key: string;
      status: "ACTIVE" | "SUSPENDED" | "REVOKED" | "DEACTIVATED";
    }>(
      `select id, license_id, public_key, status from control_plane.licensing_installations where id = $1;`,
      [params.installation_id],
    );

    if (instRes.rows.length === 0) {
      return {
        ok: false,
        status: 404,
        error: { code: "UNAUTHORIZED", message: "Installation not found." },
      };
    }

    const inst = instRes.rows[0]!;

    // Idempotency: if already deactivated, return success without duplicate side-effects
    if (inst.status === "DEACTIVATED") {
      return {
        ok: true,
        status: 200,
        data: {
          installation_id: inst.id,
          status: "DEACTIVATED",
          message: "Installation is already deactivated.",
          server_timestamp: serverTimestamp,
        },
      };
    }

    if (inst.status === "REVOKED") {
      return {
        ok: false,
        status: 403,
        error: {
          code: "INSTALLATION_REVOKED",
          message: "Revoked installations cannot self-deactivate. Admin action required.",
        },
      };
    }

    // PoP verification
    const authCheck = await verifyInstallationRequestSignature({
      installationId: params.installation_id,
      timestamp: params.timestamp,
      nonce: params.nonce,
      method: "POST",
      path: "/api/v1/licensing/deactivate",
      body: JSON.stringify({
        installation_id: params.installation_id,
        timestamp: params.timestamp,
        nonce: params.nonce,
      }),
      signatureBase64url: params.signatureBase64url,
      publicKeyPem: inst.public_key,
      nonceStore: this.ctx.nonceStore,
      currentTimestampUnixSeconds: Math.floor(serverDate.getTime() / 1000),
    });

    if (!authCheck.ok) {
      if (authCheck.code === "REPLAY_DETECTED") {
        return {
          ok: false,
          status: 409,
          error: { code: "REPLAY_DETECTED", message: "Replay attack detected." },
        };
      }
      if (authCheck.code === "INVALID_TIMESTAMP") {
        return {
          ok: false,
          status: 401,
          error: {
            code: "CLOCK_SKEW_EXCEEDED",
            message: "Timestamp outside allowable clock drift window.",
          },
        };
      }
      return {
        ok: false,
        status: 401,
        error: { code: "INVALID_INSTALLATION_SIGNATURE", message: "Invalid signature." },
      };
    }

    // Atomic status transition
    await this.ctx.db.query(
      `update control_plane.licensing_installations
       set status = 'DEACTIVATED', updated_at = now()
       where id = $1;`,
      [params.installation_id],
    );

    await this.recordEvent({
      licenseId: inst.license_id,
      installationId: inst.id,
      eventType: "INSTALLATION_DEACTIVATED",
      payload: { deactivated_at: serverTimestamp },
    });

    return {
      ok: true,
      status: 200,
      data: {
        installation_id: inst.id,
        status: "DEACTIVATED",
        message: "Installation successfully deactivated and license slot released.",
        server_timestamp: serverTimestamp,
      },
    };
  }

  // =========================================================================
  // 5. ADMIN SERVICES (PROTECTED BY REQUIRE_PLATFORM_ADMIN)
  // =========================================================================

  /**
   * Admin: Creates a commercial license.
   */
  async adminCreateLicense(params: {
    customer_id: string;
    license_type: LicenseType;
    max_installations: number;
    max_tenants: number | null;
    resale_allowed: boolean;
    white_label: boolean;
    features: string[];
    valid_from?: string;
    expires_at: string;
    maintenance_until?: string;
    grace_days?: number;
    signing_key_id: string;
    actor?: string;
  }): Promise<{ id: string }> {
    const res = await this.ctx.db.query<{ id: string }>(
      `insert into control_plane.licensing_licenses
       (customer_id, license_type, status, signing_key_id, issued_at, valid_from, expires_at, maintenance_until, grace_days, max_installations, max_tenants, resale_allowed, white_label, features, created_at, updated_at)
       values ($1, $2, 'ACTIVE', $3, now(), coalesce($4, now()), $5, $6, coalesce($7, 7), $8, $9, $10, $11, $12, now(), now())
       returning id;`,
      [
        params.customer_id,
        params.license_type,
        params.signing_key_id,
        params.valid_from || null,
        params.expires_at,
        params.maintenance_until || null,
        params.grace_days ?? 7,
        params.max_installations,
        params.max_tenants,
        params.resale_allowed,
        params.white_label,
        params.features,
      ],
    );

    const licenseId = res.rows[0]!.id;
    await this.recordEvent({
      licenseId,
      eventType: "LICENSE_CREATED",
      actor: params.actor || "admin",
      payload: { license_type: params.license_type, max_installations: params.max_installations },
    });

    return { id: licenseId };
  }

  /**
   * Admin: Creates an activation code (Returns raw code ONLY once; persists only HMAC-SHA256).
   */
  async adminCreateActivationCode(params: {
    license_id: string;
    max_uses?: number;
    expires_at: string;
    actor?: string;
  }): Promise<{ raw_activation_code: string; id: string }> {
    const rawBytes = crypto.randomBytes(32);
    const b64url = rawBytes
      .toString("base64")
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=+$/, "");
    const rawCode = `ACT_${b64url}`;

    const codeHash = deriveActivationCodeDigest(rawCode, this.ctx.pepper);

    const res = await this.ctx.db.query<{ id: string }>(
      `insert into control_plane.licensing_activation_codes
       (license_id, code_hash, max_uses, used_count, expires_at, created_at)
       values ($1, $2, coalesce($3, 1), 0, $4, now())
       returning id;`,
      [params.license_id, codeHash, params.max_uses ?? 1, params.expires_at],
    );

    const codeId = res.rows[0]!.id;
    await this.recordEvent({
      licenseId: params.license_id,
      eventType: "CODE_CREATED",
      actor: params.actor || "admin",
      payload: { code_id: codeId, max_uses: params.max_uses ?? 1 },
    });

    return { raw_activation_code: rawCode, id: codeId };
  }

  /**
   * Admin: Revokes a license.
   */
  async adminRevokeLicense(licenseId: string, actor: string = "admin"): Promise<void> {
    await this.ctx.db.query(
      `update control_plane.licensing_licenses
       set status = 'REVOKED', updated_at = now()
       where id = $1;`,
      [licenseId],
    );

    await this.recordEvent({
      licenseId,
      eventType: "LICENSE_REVOKED",
      actor,
    });
  }

  /**
   * Admin: Suspends a license.
   */
  async adminSuspendLicense(licenseId: string, actor: string = "admin"): Promise<void> {
    await this.ctx.db.query(
      `update control_plane.licensing_licenses
       set status = 'SUSPENDED', updated_at = now()
       where id = $1;`,
      [licenseId],
    );

    await this.recordEvent({
      licenseId,
      eventType: "LICENSE_SUSPENDED",
      actor,
    });
  }

  /**
   * Admin: Revokes an installation.
   */
  async adminRevokeInstallation(installationId: string, actor: string = "admin"): Promise<void> {
    const res = await this.ctx.db.query<{ license_id: string }>(
      `update control_plane.licensing_installations
       set status = 'REVOKED', updated_at = now()
       where id = $1
       returning license_id;`,
      [installationId],
    );

    if (res.rows.length > 0) {
      await this.recordEvent({
        licenseId: res.rows[0]!.license_id,
        installationId,
        eventType: "INSTALLATION_REVOKED",
        actor,
      });
    }
  }
}
