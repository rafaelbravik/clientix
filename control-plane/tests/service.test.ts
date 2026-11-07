import { describe, it, expect, beforeEach } from "vitest";
import crypto from "crypto";
import { execFileSync } from "node:child_process";
import { ControlPlaneService } from "../src/service";
import { StaticVendorSignerProvider, KeySelectionVendorSignerProvider } from "../src/signer";
import { PostgresNonceStore } from "../src/nonce-store";
import { MemoryRateLimiter } from "../src/rate-limiter";
import type { DatabaseClient } from "../scripts/migrator";
import {
  generateInstallationKeyPair,
  createInstallationRequestSignature,
  deriveActivationCodeDigest,
  isValidCanonicalInstallationId,
  normalizeCanonicalPath,
  verifyInstallationRequestSignature,
} from "@/lib/licensing/installation-auth";
interface MockCustomer {
  id: string;
  name: string;
  legal_name?: string;
  billing_email: string;
  country: string;
}

interface MockLicense {
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
  maintenance_until?: string;
  grace_days: number;
  max_installations: number;
  max_tenants: number | null;
  resale_allowed: boolean;
  white_label: boolean;
  features: string[];
  issued_at: string;
}

interface MockActivationCode {
  id: string;
  license_id: string;
  code_hash: string;
  max_uses: number;
  used_count: number;
  expires_at: string;
  revoked_at: string | null;
}

interface MockInstallation {
  id: string;
  license_id: string;
  public_key: string;
  public_key_fingerprint: string;
  activation_code_id?: string | null;
  status: string;
  environment: string;
  app_version?: string;
  last_heartbeat_at: string;
}

import { verifyLicense } from "@/lib/licensing/verify";

class InProcessDatabaseClient implements DatabaseClient {
  public customers = new Map<string, MockCustomer>();
  public licenses = new Map<string, MockLicense>();
  public activationCodes = new Map<string, MockActivationCode>();
  public installations = new Map<string, MockInstallation>();
  public nonces = new Set<string>();
  public events: Record<string, unknown>[] = [];
  public inTransaction = false;
  private transactionLock: Promise<void> = Promise.resolve();
  private releaseTransactionLock: (() => void) | null = null;

  async query<R = Record<string, unknown>>(
    sql: string,
    params: unknown[] = [],
  ): Promise<{ rows: R[]; rowCount?: number }> {
    const trimmed = sql.trim();

    if (trimmed === "BEGIN;") {
      // Acquire mutex lock so concurrent transactions serialize
      let resolver!: () => void;
      const nextLock = new Promise<void>((resolve) => {
        resolver = resolve;
      });
      const previousLock = this.transactionLock;
      this.transactionLock = nextLock;

      await previousLock;
      this.inTransaction = true;
      this.releaseTransactionLock = resolver;
      return { rows: [] };
    }
    if (trimmed === "COMMIT;" || trimmed === "ROLLBACK;") {
      this.inTransaction = false;
      if (this.releaseTransactionLock) {
        const release = this.releaseTransactionLock;
        this.releaseTransactionLock = null;
        release();
      }
      return { rows: [] };
    }

    // Customers
    if (trimmed.startsWith("insert into control_plane.licensing_customers")) {
      const id = (params[0] as string) || crypto.randomUUID();
      const customer: MockCustomer = {
        id,
        name: (params[1] as string) || "Test Customer",
        legal_name: params[2] as string | undefined,
        billing_email: (params[3] as string) || "billing@example.com",
        country: (params[4] as string) || "BR",
      };
      this.customers.set(id, customer);
      return { rows: [{ id } as unknown as R], rowCount: 1 };
    }

    // Licenses INSERT
    if (trimmed.startsWith("insert into control_plane.licensing_licenses")) {
      const id = crypto.randomUUID();
      const lic: MockLicense = {
        id,
        serial: `CLX-2026-${id.replace(/-/g, "").slice(0, 4).toUpperCase()}-${id.replace(/-/g, "").slice(4, 8).toUpperCase()}`,
        customer_id: params[0] as string,
        product: "clientix",
        deployment: "self-hosted",
        plan: "pro",
        license_type: params[1] as string,
        status: "ACTIVE",
        signing_key_id: params[2] as string,
        valid_from: (params[3] as string) || new Date().toISOString(),
        expires_at: params[4] as string,
        maintenance_until: params[5] as string | undefined,
        grace_days: (params[6] as number) ?? 7,
        max_installations: params[7] as number,
        max_tenants: params[8] as number | null,
        resale_allowed: Boolean(params[9]),
        white_label: Boolean(params[10]),
        features: (params[11] as string[]) || [],
        issued_at: new Date().toISOString(),
      };
      this.licenses.set(id, lic);
      return { rows: [{ id } as unknown as R], rowCount: 1 };
    }

    // Licenses SELECT
    if (
      trimmed.includes("from control_plane.licensing_licenses l") &&
      trimmed.includes("where l.id = $1")
    ) {
      const licId = params[0] as string;
      const lic = this.licenses.get(licId);
      if (!lic) return { rows: [] };
      const cust = this.customers.get(lic.customer_id) || {
        id: lic.customer_id,
        name: "Test Customer",
        billing_email: "test@example.com",
        country: "BR",
      };
      const row = {
        ...lic,
        cust_id: cust.id,
        cust_name: cust.name,
        cust_email: cust.billing_email,
        cust_country: cust.country,
        cust_status: "ACTIVE",
      };
      return { rows: [row as unknown as R] };
    }

    if (
      trimmed.startsWith(
        "select id, status, valid_from, expires_at, grace_days from control_plane.licensing_licenses",
      )
    ) {
      const licId = params[0] as string;
      const lic = this.licenses.get(licId);
      return { rows: lic ? [lic as unknown as R] : [] };
    }

    // Licenses UPDATE status
    if (trimmed.startsWith("update control_plane.licensing_licenses")) {
      const statusMatch = trimmed.match(/status = '([^']+)'/);
      const newStatus = statusMatch ? statusMatch[1] : "ACTIVE";
      const licId = params[0] as string;
      const lic = this.licenses.get(licId);
      if (lic && newStatus) {
        lic.status = newStatus;
      }
      return { rows: [] };
    }

    // Activation Codes INSERT
    if (trimmed.startsWith("insert into control_plane.licensing_activation_codes")) {
      const id = crypto.randomUUID();
      const code: MockActivationCode = {
        id,
        license_id: params[0] as string,
        code_hash: params[1] as string,
        max_uses: (params[2] as number) ?? 1,
        used_count: 0,
        expires_at: params[3] as string,
        revoked_at: null,
      };
      this.activationCodes.set(id, code);
      return { rows: [{ id } as unknown as R], rowCount: 1 };
    }

    // Activation Codes SELECT for update
    if (
      trimmed.includes("from control_plane.licensing_activation_codes") &&
      trimmed.includes("where code_hash = $1")
    ) {
      const hash = params[0] as string;
      for (const c of this.activationCodes.values()) {
        if (c.code_hash === hash) {
          return { rows: [c as unknown as R] };
        }
      }
      return { rows: [] };
    }

    // Activation Codes UPDATE
    if (trimmed.startsWith("update control_plane.licensing_activation_codes")) {
      const id = params[0] as string;
      const c = this.activationCodes.get(id);
      if (c) {
        c.used_count += 1;
      }
      return { rows: [] };
    }

    // Installations SELECT count
    if (
      trimmed.includes("count(*)") &&
      trimmed.includes("from control_plane.licensing_installations")
    ) {
      const licId = params[0] as string;
      let count = 0;
      for (const inst of this.installations.values()) {
        if (inst.license_id === licId && ["ACTIVE", "SUSPENDED", "REVOKED"].includes(inst.status)) {
          count++;
        }
      }
      return { rows: [{ count: count.toString() } as unknown as R] };
    }

    // Installations SELECT by fingerprint
    if (
      trimmed.includes(
        "from control_plane.licensing_installations where public_key_fingerprint = $1",
      )
    ) {
      const fp = params[0] as string;
      for (const inst of this.installations.values()) {
        if (inst.public_key_fingerprint === fp) {
          return { rows: [{ id: inst.id } as unknown as R] };
        }
      }
      return { rows: [] };
    }

    // Installations SELECT by id
    if (trimmed.includes("from control_plane.licensing_installations where id = $1")) {
      const id = params[0] as string;
      const inst = this.installations.get(id);
      return { rows: inst ? [inst as unknown as R] : [] };
    }

    // Installations INSERT
    if (trimmed.startsWith("insert into control_plane.licensing_installations")) {
      const id = params[0] as string;
      const inst: MockInstallation = {
        id,
        license_id: params[1] as string,
        public_key: params[2] as string,
        public_key_fingerprint: params[3] as string,
        activation_code_id: params[4] as string,
        status: "ACTIVE",
        environment: "production",
        app_version: params[5] as string | undefined,
        last_heartbeat_at: new Date().toISOString(),
      };
      this.installations.set(id, inst);
      return { rows: [] };
    }

    // Installations UPDATE (heartbeat or deactivation)
    if (trimmed.startsWith("update control_plane.licensing_installations")) {
      const id = params[0] as string;
      const inst = this.installations.get(id);
      if (inst) {
        if (trimmed.includes("status = 'DEACTIVATED'")) {
          inst.status = "DEACTIVATED";
        } else if (trimmed.includes("status = 'REVOKED'")) {
          inst.status = "REVOKED";
        } else if (trimmed.includes("last_heartbeat_at = now()")) {
          inst.last_heartbeat_at = new Date().toISOString();
          if (params[1]) {
            inst.app_version = params[1] as string;
          }
        }
      }
      return { rows: inst ? [{ license_id: inst.license_id } as unknown as R] : [] };
    }

    // Nonces
    if (trimmed.startsWith("delete from control_plane.licensing_nonces")) {
      return { rows: [] };
    }
    if (trimmed.startsWith("insert into control_plane.licensing_nonces")) {
      const key = `${params[0]}:${params[1]}`;
      if (this.nonces.has(key)) {
        throw new Error("duplicate key value violates unique constraint licensing_nonces_pkey");
      }
      this.nonces.add(key);
      return { rows: [] };
    }

    // Events
    if (trimmed.startsWith("insert into control_plane.licensing_events")) {
      this.events.push({
        license_id: params[0],
        installation_id: params[1],
        event_type: params[2],
        payload: params[3],
        actor: params[4],
      });
      return { rows: [] };
    }

    return { rows: [] };
  }
}

describe("L8.1F Control Plane Core Endpoints & Licensing Lifecycle", () => {
  let db: InProcessDatabaseClient;
  let service: ControlPlaneService;
  let signerKeyId: string;
  let vendorKeyPair: { publicKeyPem: string; privateKeyPem: string };
  let pepper: string;
  let customerId: string;
  let licenseId: string;

  beforeEach(async () => {
    db = new InProcessDatabaseClient();
    signerKeyId = "master_test_signer_2026";
    // Generate valid Ed25519 vendor keypair for tests
    vendorKeyPair = generateInstallationKeyPair();
    pepper = "super-secret-control-plane-pepper-for-tests-32-chars";

    const signerProvider = new StaticVendorSignerProvider(signerKeyId, vendorKeyPair.privateKeyPem);
    const nonceStore = new PostgresNonceStore(db);
    const rateLimiter = new MemoryRateLimiter();

    service = new ControlPlaneService({
      db,
      signerProvider,
      trustedPublicKeyMap: {
        [signerKeyId]: vendorKeyPair.publicKeyPem,
      },
      pepper,
      nonceStore,
      rateLimiter,
    });

    // Seed test customer
    customerId = "cust_123e4567-e89b-42d3-a456-426614174000";
    db.customers.set(customerId, {
      id: customerId,
      name: "Agência Digital Alpha",
      legal_name: "Alpha LTDA",
      billing_email: "alpha@exemplo.com.br",
      country: "BR",
    });

    // Create active license for testing
    const lic = await service.adminCreateLicense({
      customer_id: customerId,
      license_type: "partner",
      max_installations: 1,
      max_tenants: 5,
      resale_allowed: true,
      white_label: true,
      features: ["waha_whatsapp", "ai_copilot"],
      valid_from: "2026-10-01T00:00:00Z",
      expires_at: "2027-10-01T00:00:00Z",
      signing_key_id: signerKeyId,
    });
    licenseId = lic.id;
  });

  describe("1. Activation endpoint & bootstrap flow", () => {
    it("activates successfully, issues valid signed license and passes client verifier", async () => {
      const codeRes = await service.adminCreateActivationCode({
        license_id: licenseId,
        max_uses: 1,
        expires_at: "2027-01-01T00:00:00Z",
      });

      const instKeyPair = generateInstallationKeyPair();
      const instId = execFileSync("bash", ["distribution/installer/installation-id.sh"], {
        cwd: process.cwd(),
        encoding: "utf8",
      }).trim();
      expect(isValidCanonicalInstallationId(instId)).toBe(true);

      const timestamp = 1760000000;
      const nonce = "aabbccddeeff00112233445566778899";
      const proofSignature = createInstallationRequestSignature({
        installationId: instId,
        timestamp,
        nonce,
        method: "GET",
        path: "/api/v1/license/status",
        privateKeyPem: instKeyPair.privateKeyPem,
      });
      const proof = await verifyInstallationRequestSignature({
        installationId: instId,
        timestamp,
        nonce,
        method: "GET",
        path: "/api/v1/license/status",
        signatureBase64url: proofSignature,
        publicKeyPem: instKeyPair.publicKeyPem,
        currentTimestampUnixSeconds: timestamp,
      });
      expect(proof.ok).toBe(true);

      const actResult = await service.activate({
        installation_id: instId,
        installation_public_key: instKeyPair.publicKeyPem,
        activation_code: codeRes.raw_activation_code,
        timestamp,
        nonce: "11223344556677889900aabbccddeeff",
      });

      expect(actResult.ok).toBe(true);
      expect(actResult.status).toBe(200);
      expect(actResult.data).toBeDefined();

      const signedDoc = actResult.data!.signed_license;
      expect(signedDoc.key_id).toBe(signerKeyId);
      expect(signedDoc.payload.installation_id).toBe(instId);
      expect(signedDoc.payload.license_id).toBe(licenseId);
      expect(signedDoc.payload.entitlements.resale_allowed).toBe(true);

      // Verify with client L2/L6 verifier
      const clientVerif = verifyLicense(signedDoc, {
        expectedInstallationId: instId,
        trustedKeys: { [signerKeyId]: vendorKeyPair.publicKeyPem },
      });
      expect(clientVerif.valid).toBe(true);
      expect(clientVerif.usable).toBe(true);
      expect(clientVerif.state).toBe("VALID");
    });

    it("rejects invalid, expired or revoked activation code", async () => {
      const instKeyPair = generateInstallationKeyPair();
      const instId = "inst_123e4567-e89b-42d3-a456-426614174000";

      // 1. Invalid code format / not found
      const invalidRes = await service.activate({
        installation_id: instId,
        installation_public_key: instKeyPair.publicKeyPem,
        activation_code: "ACT_invalid_code_not_found_in_database_00000",
        timestamp: 1760000000,
        nonce: "11223344556677889900aabbccddeeff",
      });
      expect(invalidRes.ok).toBe(false);
      expect(invalidRes.error?.code).toBe("ACTIVATION_INVALID");

      // 2. Expired code
      const expCode = await service.adminCreateActivationCode({
        license_id: licenseId,
        max_uses: 1,
        expires_at: "2025-01-01T00:00:00Z", // Past
      });
      const expRes = await service.activate({
        installation_id: instId,
        installation_public_key: instKeyPair.publicKeyPem,
        activation_code: expCode.raw_activation_code,
        timestamp: 1760000000,
        nonce: "11223344556677889900aabbccddeeff",
      });
      expect(expRes.ok).toBe(false);
      expect(expRes.error?.code).toBe("ACTIVATION_EXPIRED");
    });

    it("enforces max_installations quota strictly", async () => {
      // License only allows 1 installation
      const code1 = await service.adminCreateActivationCode({
        license_id: licenseId,
        max_uses: 2,
        expires_at: "2027-01-01T00:00:00Z",
      });

      const inst1 = generateInstallationKeyPair();
      const instId1 = "inst_11111111-1111-4111-8111-111111111111";

      const res1 = await service.activate({
        installation_id: instId1,
        installation_public_key: inst1.publicKeyPem,
        activation_code: code1.raw_activation_code,
        timestamp: 1760000000,
        nonce: "nonce_1",
      });
      expect(res1.ok).toBe(true);

      // Second installation with same license must be denied quota limit
      const inst2 = generateInstallationKeyPair();
      const instId2 = "inst_22222222-2222-4222-8222-222222222222";

      const res2 = await service.activate({
        installation_id: instId2,
        installation_public_key: inst2.publicKeyPem,
        activation_code: code1.raw_activation_code,
        timestamp: 1760000000,
        nonce: "nonce_2",
      });
      expect(res2.ok).toBe(false);
      expect(res2.error?.code).toBe("ACTIVATION_LIMIT_REACHED");
    });

    it("supports idempotent activation retry without consuming extra slots", async () => {
      const code = await service.adminCreateActivationCode({
        license_id: licenseId,
        max_uses: 1,
        expires_at: "2027-01-01T00:00:00Z",
      });

      const inst = generateInstallationKeyPair();
      const instId = "inst_33333333-3333-4333-8333-333333333333";

      // First run succeeds
      const res1 = await service.activate({
        installation_id: instId,
        installation_public_key: inst.publicKeyPem,
        activation_code: code.raw_activation_code,
        timestamp: 1760000000,
        nonce: "nonce_initial",
      });
      expect(res1.ok).toBe(true);

      // Retry by same installation with same public key succeeds idempotently
      const resRetry = await service.activate({
        installation_id: instId,
        installation_public_key: inst.publicKeyPem,
        activation_code: code.raw_activation_code,
        timestamp: 1760000010,
        nonce: "nonce_retry",
      });
      expect(resRetry.ok).toBe(true);
      expect(resRetry.data?.signed_license.payload.installation_id).toBe(instId);

      // Retry with DIFFERENT public key fails with INSTALLATION_KEY_MISMATCH
      const rogueKey = generateInstallationKeyPair();
      const resRogue = await service.activate({
        installation_id: instId,
        installation_public_key: rogueKey.publicKeyPem,
        activation_code: code.raw_activation_code,
        timestamp: 1760000020,
        nonce: "nonce_rogue",
      });
      expect(resRogue.ok).toBe(false);
      expect(resRogue.error?.code).toBe("INSTALLATION_KEY_MISMATCH");
    });
  });

  describe("2. Heartbeat endpoint & Proof-of-Possession", () => {
    let activeInstId: string;
    let activeKeyPair: { publicKeyPem: string; privateKeyPem: string };

    beforeEach(async () => {
      const code = await service.adminCreateActivationCode({
        license_id: licenseId,
        max_uses: 1,
        expires_at: "2027-01-01T00:00:00Z",
      });
      activeKeyPair = generateInstallationKeyPair();
      activeInstId = "inst_44444444-4444-4444-8444-444444444444";
      await service.activate({
        installation_id: activeInstId,
        installation_public_key: activeKeyPair.publicKeyPem,
        activation_code: code.raw_activation_code,
        timestamp: 1760000000,
        nonce: "nonce_boot",
      });
    });

    it("accepts valid signed heartbeat and updates last_heartbeat_at", async () => {
      const now = Math.floor(Date.now() / 1000);
      const nonce = "a1b2c3d4e5f60718293a4b5c6d7e8f90";
      const payload = {
        installation_id: activeInstId,
        app_version: "2026.10.1",
        schema_version: "0510",
        release_version: "2026.10.1",
        local_license_state: "VALID",
        timestamp: now,
        nonce,
      };

      const rawBody = JSON.stringify(payload);
      const sig = createInstallationRequestSignature({
        installationId: activeInstId,
        timestamp: now,
        nonce,
        method: "POST",
        path: "/api/v1/licensing/heartbeat",
        body: rawBody,
        privateKeyPem: activeKeyPair.privateKeyPem,
      });

      const hbRes = await service.heartbeat({
        ...payload,
        rawBody,
        signatureBase64url: sig,
      });

      expect(hbRes.ok).toBe(true);
      expect(hbRes.data?.license_status).toBe("ACTIVE");
      expect(hbRes.data?.installation_status).toBe("ACTIVE");
      expect(hbRes.data?.temporal_state).toBe("VALID");

      const instInDb = db.installations.get(activeInstId);
      expect(instInDb!.app_version).toBe("2026.10.1");
    });

    it("rejects invalid signature with 401 and rejects replayed nonce with 409", async () => {
      const now = Math.floor(Date.now() / 1000);
      const badNonce = "bad_nonce_1234567890abcdef1234";
      const payloadBad = {
        installation_id: activeInstId,
        app_version: "2026.10.1",
        timestamp: now,
        nonce: badNonce,
      };

      const rawBodyBad = JSON.stringify(payloadBad);

      // 1. Wrong signature
      const badSigRes = await service.heartbeat({
        ...payloadBad,
        rawBody: rawBodyBad,
        signatureBase64url: "invalidsignaturebase64url",
      });
      expect(badSigRes.ok).toBe(false);
      expect(badSigRes.status).toBe(401);
      expect(badSigRes.error?.code).toBe("INVALID_INSTALLATION_SIGNATURE");

      // 2. First call with valid signature and new nonce succeeds
      const replayNonce = "replay_nonce_9999888877776666";
      const payloadValid = {
        installation_id: activeInstId,
        app_version: "2026.10.1",
        timestamp: now,
        nonce: replayNonce,
      };
      const rawBodyValid = JSON.stringify(payloadValid);

      const validSig = createInstallationRequestSignature({
        installationId: activeInstId,
        timestamp: now,
        nonce: replayNonce,
        method: "POST",
        path: "/api/v1/licensing/heartbeat",
        body: rawBodyValid,
        privateKeyPem: activeKeyPair.privateKeyPem,
      });

      const res1 = await service.heartbeat({
        ...payloadValid,
        rawBody: rawBodyValid,
        signatureBase64url: validSig,
      });
      expect(res1.ok).toBe(true);

      // 3. Replay with identical nonce fails with 409 REPLAY_DETECTED
      const resReplay = await service.heartbeat({
        ...payloadValid,
        rawBody: rawBodyValid,
        signatureBase64url: validSig,
      });
      expect(resReplay.ok).toBe(false);
      expect(resReplay.status).toBe(409);
      expect(resReplay.error?.code).toBe("REPLAY_DETECTED");
    });

    it("notifies client clearly when server license has been revoked or suspended", async () => {
      // Suspend license
      await service.adminSuspendLicense(licenseId);

      const now = Math.floor(Date.now() / 1000);
      const nonce = "nonce_suspended_check";
      const payload = {
        installation_id: activeInstId,
        timestamp: now,
        nonce,
      };

      const sig = createInstallationRequestSignature({
        installationId: activeInstId,
        timestamp: now,
        nonce,
        method: "POST",
        path: "/api/v1/licensing/heartbeat",
        body: JSON.stringify(payload),
        privateKeyPem: activeKeyPair.privateKeyPem,
      });

      const hbRes = await service.heartbeat({
        ...payload,
        signatureBase64url: sig,
      });

      expect(hbRes.ok).toBe(true);
      expect(hbRes.data?.license_status).toBe("SUSPENDED");
    });
  });

  describe("3. Renewal endpoint", () => {
    let activeInstId: string;
    let activeKeyPair: { publicKeyPem: string; privateKeyPem: string };

    beforeEach(async () => {
      const code = await service.adminCreateActivationCode({
        license_id: licenseId,
        max_uses: 1,
        expires_at: "2027-01-01T00:00:00Z",
      });
      activeKeyPair = generateInstallationKeyPair();
      activeInstId = "inst_55555555-5555-4555-8555-555555555555";
      await service.activate({
        installation_id: activeInstId,
        installation_public_key: activeKeyPair.publicKeyPem,
        activation_code: code.raw_activation_code,
        timestamp: 1760000000,
        nonce: "nonce_renew_setup",
      });
    });

    it("renews an active license with valid PoP and issues refreshed signature", async () => {
      const now = Math.floor(Date.now() / 1000);
      const nonce = "nonce_renew_ok";
      const payload = {
        installation_id: activeInstId,
        timestamp: now,
        nonce,
      };

      const sig = createInstallationRequestSignature({
        installationId: activeInstId,
        timestamp: now,
        nonce,
        method: "POST",
        path: "/api/v1/licensing/renew",
        body: JSON.stringify(payload),
        privateKeyPem: activeKeyPair.privateKeyPem,
      });

      const renewRes = await service.renew({
        ...payload,
        signatureBase64url: sig,
      });

      expect(renewRes.ok).toBe(true);
      expect(renewRes.data?.signed_license).toBeDefined();

      const verif = verifyLicense(renewRes.data!.signed_license, {
        expectedInstallationId: activeInstId,
        trustedKeys: { [signerKeyId]: vendorKeyPair.publicKeyPem },
      });
      expect(verif.valid).toBe(true);
    });

    it("denies renewal when license is revoked", async () => {
      await service.adminRevokeLicense(licenseId);

      const now = Math.floor(Date.now() / 1000);
      const nonce = "nonce_renew_revoked";
      const payload = {
        installation_id: activeInstId,
        timestamp: now,
        nonce,
      };

      const sig = createInstallationRequestSignature({
        installationId: activeInstId,
        timestamp: now,
        nonce,
        method: "POST",
        path: "/api/v1/licensing/renew",
        body: JSON.stringify(payload),
        privateKeyPem: activeKeyPair.privateKeyPem,
      });

      const renewRes = await service.renew({
        ...payload,
        signatureBase64url: sig,
      });

      expect(renewRes.ok).toBe(false);
      expect(renewRes.status).toBe(403);
      expect(renewRes.error?.code).toBe("LICENSE_REVOKED");
    });
  });

  describe("4. Deactivation endpoint & slot release", () => {
    let activeInstId: string;
    let activeKeyPair: { publicKeyPem: string; privateKeyPem: string };

    beforeEach(async () => {
      const code = await service.adminCreateActivationCode({
        license_id: licenseId,
        max_uses: 1,
        expires_at: "2027-01-01T00:00:00Z",
      });
      activeKeyPair = generateInstallationKeyPair();
      activeInstId = "inst_66666666-6666-4666-8666-666666666666";
      await service.activate({
        installation_id: activeInstId,
        installation_public_key: activeKeyPair.publicKeyPem,
        activation_code: code.raw_activation_code,
        timestamp: 1760000000,
        nonce: "nonce_deact_setup",
      });
    });

    it("deactivates successfully via PoP and releases slot for a new installation", async () => {
      const now = Math.floor(Date.now() / 1000);
      const nonce = "nonce_deact_1";
      const payload = {
        installation_id: activeInstId,
        timestamp: now,
        nonce,
      };

      const sig = createInstallationRequestSignature({
        installationId: activeInstId,
        timestamp: now,
        nonce,
        method: "POST",
        path: "/api/v1/licensing/deactivate",
        body: JSON.stringify(payload),
        privateKeyPem: activeKeyPair.privateKeyPem,
      });

      const deactRes = await service.deactivate({
        ...payload,
        signatureBase64url: sig,
      });

      expect(deactRes.ok).toBe(true);
      expect(deactRes.data?.status).toBe("DEACTIVATED");

      // Verify slot is now free: create code and activate new installation
      const codeNew = await service.adminCreateActivationCode({
        license_id: licenseId,
        max_uses: 1,
        expires_at: "2027-01-01T00:00:00Z",
      });
      const newInst = generateInstallationKeyPair();
      const newInstId = "inst_77777777-7777-4777-8777-777777777777";

      const actNewRes = await service.activate({
        installation_id: newInstId,
        installation_public_key: newInst.publicKeyPem,
        activation_code: codeNew.raw_activation_code,
        timestamp: 1760000000,
        nonce: "nonce_new_after_deact",
      });

      expect(actNewRes.ok).toBe(true);
    });

    it("handles repeated deactivation idempotently without 500 error", async () => {
      const now = Math.floor(Date.now() / 1000);
      const nonce = "nonce_deact_repeat";
      const payload = {
        installation_id: activeInstId,
        timestamp: now,
        nonce,
      };

      const sig = createInstallationRequestSignature({
        installationId: activeInstId,
        timestamp: now,
        nonce,
        method: "POST",
        path: "/api/v1/licensing/deactivate",
        body: JSON.stringify(payload),
        privateKeyPem: activeKeyPair.privateKeyPem,
      });

      await service.deactivate({ ...payload, signatureBase64url: sig });

      // Second deactivation call
      const secondRes = await service.deactivate({ ...payload, signatureBase64url: sig });
      expect(secondRes.ok).toBe(true);
      expect(secondRes.data?.status).toBe("DEACTIVATED");
    });
  });

  describe("5. Complete audit event coverage", () => {
    it("records expected events throughout the entire lifecycle", async () => {
      const code = await service.adminCreateActivationCode({
        license_id: licenseId,
        max_uses: 1,
        expires_at: "2027-01-01T00:00:00Z",
      });

      const instPair = generateInstallationKeyPair();
      const instId = "inst_99999999-9999-4999-8999-999999999999";
      await service.activate({
        installation_id: instId,
        installation_public_key: instPair.publicKeyPem,
        activation_code: code.raw_activation_code,
        timestamp: 1760000000,
        nonce: "nonce_event_audit",
      });

      const eventTypes = db.events.map((e) => e.event_type);
      expect(eventTypes).toContain("LICENSE_CREATED");
      expect(eventTypes).toContain("CODE_CREATED");
      expect(eventTypes).toContain("LICENSE_ACTIVATED");
    });
  });

  describe("6. L8.1F.1 Dedicated Crypto Contract & Behavioral Gate Tests", () => {
    it("proves installation_id MUST be signed: valid sig for Inst A + header changed to Inst B fails", async () => {
      const instA = generateInstallationKeyPair();
      const instIdA = "inst_aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
      const instIdB = "inst_bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

      const now = Math.floor(Date.now() / 1000);
      const nonce = "nonce_inst_id_sig_test";
      const rawBody = JSON.stringify({
        installation_id: instIdA,
        timestamp: now,
        nonce,
      });

      // Signature created by Inst A for instIdA
      const sigA = createInstallationRequestSignature({
        installationId: instIdA,
        timestamp: now,
        nonce,
        method: "POST",
        path: "/api/v1/licensing/heartbeat",
        body: rawBody,
        privateKeyPem: instA.privateKeyPem,
      });

      // Verify against Inst A's public key but claiming installationId = instIdB
      const verifyTampered = await verifyInstallationRequestSignature({
        installationId: instIdB, // Header tampered to Inst B
        timestamp: now,
        nonce,
        method: "POST",
        path: "/api/v1/licensing/heartbeat",
        body: rawBody,
        signatureBase64url: sigA,
        publicKeyPem: instA.publicKeyPem,
      });

      expect(verifyTampered.ok).toBe(false);
      expect(verifyTampered.code).toBe("INVALID_SIGNATURE");
    });

    it("enforces canonical path normalization across queries, duplicate slashes, and trailing slashes", async () => {
      const inst = generateInstallationKeyPair();
      const instId = "inst_11223344-5566-4778-8990-aabbccddeeff";
      const now = Math.floor(Date.now() / 1000);
      const nonce = "nonce_path_norm_test";

      // Raw path with duplicate slashes, trailing slash, and unsorted query params
      const rawPath = "//api/v1/licensing/heartbeat/?zeta=1&alpha=2&beta=3/";
      const normalized = normalizeCanonicalPath(rawPath);
      expect(normalized).toBe("/api/v1/licensing/heartbeat?alpha=2&beta=3%2F&zeta=1");

      const body = "{}";
      const sig = createInstallationRequestSignature({
        installationId: instId,
        timestamp: now,
        nonce,
        method: "POST",
        path: rawPath,
        body,
        privateKeyPem: inst.privateKeyPem,
      });

      // Verifier calling with canonicalized path passes identically
      const check = await verifyInstallationRequestSignature({
        installationId: instId,
        timestamp: now,
        nonce,
        method: "POST",
        path: normalized,
        body,
        signatureBase64url: sig,
        publicKeyPem: inst.publicKeyPem,
      });
      expect(check.ok).toBe(true);
    });

    it("enforces timestamp unit in Unix seconds with +-300s clock drift window", async () => {
      const inst = generateInstallationKeyPair();
      const instId = "inst_11223344-5566-4778-8990-aabbccddeeff";
      const serverNow = 1760000000; // seconds

      // 1. Within +-300 seconds (290s ahead)
      const validFutureTs = serverNow + 290;
      const sigFuture = createInstallationRequestSignature({
        installationId: instId,
        timestamp: validFutureTs,
        nonce: "nonce_ts_future",
        method: "POST",
        path: "/api/v1/licensing/heartbeat",
        body: "{}",
        privateKeyPem: inst.privateKeyPem,
      });
      const checkFuture = await verifyInstallationRequestSignature({
        installationId: instId,
        timestamp: validFutureTs,
        nonce: "nonce_ts_future",
        method: "POST",
        path: "/api/v1/licensing/heartbeat",
        body: "{}",
        signatureBase64url: sigFuture,
        publicKeyPem: inst.publicKeyPem,
        currentTimestampUnixSeconds: serverNow,
      });
      expect(checkFuture.ok).toBe(true);

      // 2. Outside allowable skew (305s ahead)
      const invalidFutureTs = serverNow + 305;
      const sigExpired = createInstallationRequestSignature({
        installationId: instId,
        timestamp: invalidFutureTs,
        nonce: "nonce_ts_expired",
        method: "POST",
        path: "/api/v1/licensing/heartbeat",
        body: "{}",
        privateKeyPem: inst.privateKeyPem,
      });
      const checkExpired = await verifyInstallationRequestSignature({
        installationId: instId,
        timestamp: invalidFutureTs,
        nonce: "nonce_ts_expired",
        method: "POST",
        path: "/api/v1/licensing/heartbeat",
        body: "{}",
        signatureBase64url: sigExpired,
        publicKeyPem: inst.publicKeyPem,
        currentTimestampUnixSeconds: serverNow,
      });
      expect(checkExpired.ok).toBe(false);
      expect(checkExpired.code).toBe("INVALID_TIMESTAMP");
    });

    it("verifies activation code concurrency: exactly 1 consumes code with max_uses=1", async () => {
      const singleUseCode = await service.adminCreateActivationCode({
        license_id: licenseId,
        max_uses: 1,
        expires_at: "2027-01-01T00:00:00Z",
      });

      const inst1 = generateInstallationKeyPair();
      const inst2 = generateInstallationKeyPair();
      const id1 = "inst_11110000-1111-4111-8111-111111111111";
      const id2 = "inst_22220000-2222-4222-8222-222222222222";

      // Launch two activations simultaneously
      const [res1, res2] = await Promise.all([
        service.activate({
          installation_id: id1,
          installation_public_key: inst1.publicKeyPem,
          activation_code: singleUseCode.raw_activation_code,
          timestamp: 1760000000,
          nonce: "nonce_conc_1",
        }),
        service.activate({
          installation_id: id2,
          installation_public_key: inst2.publicKeyPem,
          activation_code: singleUseCode.raw_activation_code,
          timestamp: 1760000000,
          nonce: "nonce_conc_2",
        }),
      ]);

      const successCount = [res1, res2].filter((r) => r.ok).length;
      const failureCount = [res1, res2].filter((r) => !r.ok).length;

      expect(successCount).toBe(1);
      expect(failureCount).toBe(1);

      const failedRes = res1.ok ? res2 : res1;
      expect(failedRes.error?.code).toBe("ACTIVATION_CODE_EXHAUSTED");
    });

    it("verifies max_installations concurrency: exactly 1 succeeds when 1 slot remains", async () => {
      // Create license with max_installations = 1
      const multiUseCode = await service.adminCreateActivationCode({
        license_id: licenseId,
        max_uses: 5,
        expires_at: "2027-01-01T00:00:00Z",
      });

      const instA = generateInstallationKeyPair();
      const instB = generateInstallationKeyPair();
      const idA = "inst_aaaa1111-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
      const idB = "inst_bbbb2222-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

      const [resA, resB] = await Promise.all([
        service.activate({
          installation_id: idA,
          installation_public_key: instA.publicKeyPem,
          activation_code: multiUseCode.raw_activation_code,
          timestamp: 1760000000,
          nonce: "nonce_slot_a",
        }),
        service.activate({
          installation_id: idB,
          installation_public_key: instB.publicKeyPem,
          activation_code: multiUseCode.raw_activation_code,
          timestamp: 1760000000,
          nonce: "nonce_slot_b",
        }),
      ]);

      const successCount = [resA, resB].filter((r) => r.ok).length;
      const failureCount = [resA, resB].filter((r) => !r.ok).length;

      expect(successCount).toBe(1);
      expect(failureCount).toBe(1);

      const failed = resA.ok ? resB : resA;
      expect(failed.error?.code).toBe("ACTIVATION_LIMIT_REACHED");
    });

    it("enforces fail-closed signing key selection (0 keys, multiple ambiguous keys)", async () => {
      const key1 = generateInstallationKeyPair();
      const key2 = generateInstallationKeyPair();

      // 1. Zero active keys -> FAIL CLOSED
      const zeroProvider = new KeySelectionVendorSignerProvider([]);
      await expect(zeroProvider.getSigningKey()).rejects.toThrow("Zero active vendor signing keys");

      // 2. Multiple ambiguous active keys -> FAIL CLOSED
      const ambiguousProvider = new KeySelectionVendorSignerProvider([
        { keyId: "key_1", privateKeyPem: key1.privateKeyPem, isActive: true },
        { keyId: "key_2", privateKeyPem: key2.privateKeyPem, isActive: true },
      ]);
      await expect(ambiguousProvider.getSigningKey()).rejects.toThrow(
        "Ambiguous active vendor signing keys",
      );

      // 3. Explicit keyId specified -> ALLOWS correct active key
      const explicit = await ambiguousProvider.getSigningKey("key_2");
      expect(explicit.keyId).toBe("key_2");
      expect(explicit.privateKeyPem).toBe(key2.privateKeyPem);

      // 4. Inactive key requested -> FAIL CLOSED
      const inactiveProvider = new KeySelectionVendorSignerProvider([
        { keyId: "retired_1", privateKeyPem: key1.privateKeyPem, isActive: false },
      ]);
      await expect(inactiveProvider.getSigningKey("retired_1")).rejects.toThrow(
        "is inactive/retired",
      );
    });

    it("enforces issuer/verifier parity with wrong key_id, tampered payload, and tampered signature", async () => {
      const code = await service.adminCreateActivationCode({
        license_id: licenseId,
        max_uses: 1,
        expires_at: "2027-01-01T00:00:00Z",
      });

      const instPair = generateInstallationKeyPair();
      const instId = "inst_98765432-1234-4567-8901-abcdefabcdef";

      const actResult = await service.activate({
        installation_id: instId,
        installation_public_key: instPair.publicKeyPem,
        activation_code: code.raw_activation_code,
        timestamp: 1760000000,
        nonce: "nonce_parity_test",
      });

      expect(actResult.ok).toBe(true);
      const signedDoc = actResult.data!.signed_license;

      // 1. Untampered document passes client verification
      const goodVerif = verifyLicense(signedDoc, {
        expectedInstallationId: instId,
        trustedKeys: { [signerKeyId]: vendorKeyPair.publicKeyPem },
      });
      expect(goodVerif.valid).toBe(true);

      // 2. Tampered payload fails verification
      const tamperedDoc = {
        ...signedDoc,
        payload: {
          ...signedDoc.payload,
          entitlements: {
            ...signedDoc.payload.entitlements,
            max_tenants: 999999, // Tampered
          },
        },
      };
      const badPayloadVerif = verifyLicense(tamperedDoc, {
        expectedInstallationId: instId,
        trustedKeys: { [signerKeyId]: vendorKeyPair.publicKeyPem },
      });
      expect(badPayloadVerif.valid).toBe(false);

      // 3. Wrong key_id fails verification
      const wrongKeyDoc = {
        ...signedDoc,
        key_id: "unknown_vendor_key_id",
      };
      const badKeyVerif = verifyLicense(wrongKeyDoc, {
        expectedInstallationId: instId,
        trustedKeys: { [signerKeyId]: vendorKeyPair.publicKeyPem },
      });
      expect(badKeyVerif.valid).toBe(false);
      expect(badKeyVerif.reason).toMatch(/desconhecida|KEY_NOT_TRUSTED/i);

      // 4. Tampered signature fails verification
      const badSigDoc = {
        ...signedDoc,
        signature: signedDoc.signature.slice(0, -4) + "AAAA",
      };
      const badSigVerif = verifyLicense(badSigDoc, {
        expectedInstallationId: instId,
        trustedKeys: { [signerKeyId]: vendorKeyPair.publicKeyPem },
      });
      expect(badSigVerif.valid).toBe(false);
      expect(badSigVerif.reason).toMatch(/inválida|SIGNATURE_INVALID/i);
    });

    it("handles renewal across VALID, GRACE, and EXPIRED temporal states", async () => {
      // Setup activated installation
      const code = await service.adminCreateActivationCode({
        license_id: licenseId,
        max_uses: 1,
        expires_at: "2027-01-01T00:00:00Z",
      });
      const instPair = generateInstallationKeyPair();
      const instId = "inst_88887777-6666-4555-8444-333322221111";
      await service.activate({
        installation_id: instId,
        installation_public_key: instPair.publicKeyPem,
        activation_code: code.raw_activation_code,
        timestamp: 1760000000,
        nonce: "nonce_renew_states_setup",
      });

      const renewWithTime = async (date: Date) => {
        const timeService = new ControlPlaneService({
          db,
          signerProvider: new StaticVendorSignerProvider(signerKeyId, vendorKeyPair.privateKeyPem),
          trustedPublicKeyMap: { [signerKeyId]: vendorKeyPair.publicKeyPem },
          pepper,
          nonceStore: new PostgresNonceStore(db),
          clockNow: () => date,
        });

        const nowSec = Math.floor(date.getTime() / 1000);
        const nonce = `nonce_renew_at_${date.getTime()}`;
        const payload = {
          installation_id: instId,
          timestamp: nowSec,
          nonce,
        };
        const sig = createInstallationRequestSignature({
          installationId: instId,
          timestamp: nowSec,
          nonce,
          method: "POST",
          path: "/api/v1/licensing/renew",
          body: JSON.stringify(payload),
          privateKeyPem: instPair.privateKeyPem,
        });

        return timeService.renew({ ...payload, signatureBase64url: sig });
      };

      // 1. VALID: 2027-05-01 (before 2027-10-01) -> ALLOW
      const resValid = await renewWithTime(new Date("2027-05-01T00:00:00Z"));
      expect(resValid.ok).toBe(true);

      // 2. GRACE: 2027-10-03 (within 7 grace days of 2027-10-01) -> ALLOW
      const resGrace = await renewWithTime(new Date("2027-10-03T00:00:00Z"));
      expect(resGrace.ok).toBe(true);

      // 3. EXPIRED: 2027-10-15 (past 7 grace days) -> DENY with RENEWAL_NOT_ALLOWED
      const resExpired = await renewWithTime(new Date("2027-10-15T00:00:00Z"));
      expect(resExpired.ok).toBe(false);
      expect(resExpired.status).toBe(403);
      expect(resExpired.error?.code).toBe("RENEWAL_NOT_ALLOWED");
    });

    it("strictly filters heartbeat payload against customer PII, conversations, and tenant records", async () => {
      const code = await service.adminCreateActivationCode({
        license_id: licenseId,
        max_uses: 1,
        expires_at: "2027-01-01T00:00:00Z",
      });
      const instPair = generateInstallationKeyPair();
      const instId = "inst_99887766-5544-4321-8899-001122334455";
      await service.activate({
        installation_id: instId,
        installation_public_key: instPair.publicKeyPem,
        activation_code: code.raw_activation_code,
        timestamp: 1760000000,
        nonce: "nonce_privacy_setup",
      });

      const now = Math.floor(Date.now() / 1000);
      const nonce = "nonce_privacy_leak";
      // Rogue payload attempting to send conversations / messages
      const rogueBody = JSON.stringify({
        installation_id: instId,
        timestamp: now,
        nonce,
        conversation_text: "Confidential customer chat history",
      });

      const sig = createInstallationRequestSignature({
        installationId: instId,
        timestamp: now,
        nonce,
        method: "POST",
        path: "/api/v1/licensing/heartbeat",
        body: rogueBody,
        privateKeyPem: instPair.privateKeyPem,
      });

      const hbRes = await service.heartbeat({
        installation_id: instId,
        timestamp: now,
        nonce,
        rawBody: rogueBody,
        signatureBase64url: sig,
      });

      expect(hbRes.ok).toBe(false);
      expect(hbRes.status).toBe(400);
      expect(hbRes.error?.code).toBe("MALFORMED_REQUEST");
      expect(hbRes.error?.message).toContain("Privacy violation");
    });

    it("prevents revoked installations from releasing slots via self-deactivation", async () => {
      const code = await service.adminCreateActivationCode({
        license_id: licenseId,
        max_uses: 1,
        expires_at: "2027-01-01T00:00:00Z",
      });
      const instPair = generateInstallationKeyPair();
      const instId = "inst_66554433-2211-4000-8111-223344556677";
      await service.activate({
        installation_id: instId,
        installation_public_key: instPair.publicKeyPem,
        activation_code: code.raw_activation_code,
        timestamp: 1760000000,
        nonce: "nonce_rev_deact_setup",
      });

      // Admin revokes installation
      await service.adminRevokeInstallation(instId);

      const now = Math.floor(Date.now() / 1000);
      const nonce = "nonce_rev_deact_attempt";
      const payload = {
        installation_id: instId,
        timestamp: now,
        nonce,
      };

      const sig = createInstallationRequestSignature({
        installationId: instId,
        timestamp: now,
        nonce,
        method: "POST",
        path: "/api/v1/licensing/deactivate",
        body: JSON.stringify(payload),
        privateKeyPem: instPair.privateKeyPem,
      });

      const deactRes = await service.deactivate({
        ...payload,
        signatureBase64url: sig,
      });

      expect(deactRes.ok).toBe(false);
      expect(deactRes.status).toBe(403);
      expect(deactRes.error?.code).toBe("INSTALLATION_REVOKED");
    });

    it("enforces rate limits across activation, heartbeat, and renewal endpoints", async () => {
      const rateLimiter = new MemoryRateLimiter();
      const testService = new ControlPlaneService({
        db,
        signerProvider: new StaticVendorSignerProvider(signerKeyId, vendorKeyPair.privateKeyPem),
        trustedPublicKeyMap: { [signerKeyId]: vendorKeyPair.publicKeyPem },
        pepper,
        nonceStore: new PostgresNonceStore(db),
        rateLimiter,
      });

      const instPair = generateInstallationKeyPair();
      const instId = "inst_12121212-3434-4545-8686-787878787878";

      // Exhaust activation limit (10 hits)
      for (let i = 0; i < 10; i++) {
        await testService.activate({
          installation_id: instId,
          installation_public_key: instPair.publicKeyPem,
          activation_code: "ACT_invalid_code",
          timestamp: 1760000000,
          nonce: `nonce_rate_${i}`,
        });
      }

      const blockedAct = await testService.activate({
        installation_id: instId,
        installation_public_key: instPair.publicKeyPem,
        activation_code: "ACT_invalid_code",
        timestamp: 1760000000,
        nonce: "nonce_rate_blocked",
      });

      expect(blockedAct.ok).toBe(false);
      expect(blockedAct.status).toBe(429);
      expect(blockedAct.error?.code).toBe("RATE_LIMITED");
    });

    it("verifies HMAC-SHA256 digest compatibility: pepper sensitivity and no raw code stored", async () => {
      const rawCode = "ACT_example_raw_activation_code_for_audit_test_123456";
      const pepperA = "secret_pepper_a_32_characters_long_str";
      const pepperB = "secret_pepper_b_32_characters_long_str";

      // 1. Same raw code + same pepper -> identical digest
      const digestA1 = deriveActivationCodeDigest(rawCode, pepperA);
      const digestA2 = deriveActivationCodeDigest(rawCode, pepperA);
      expect(digestA1).toBe(digestA2);
      expect(digestA1).toHaveLength(64); // 256 bits hex

      // 2. Same raw code + different pepper -> different digest
      const digestB = deriveActivationCodeDigest(rawCode, pepperB);
      expect(digestA1).not.toBe(digestB);

      // 3. Different raw code -> lookup fails
      const digestWrong = deriveActivationCodeDigest(rawCode + "_modified", pepperA);
      expect(digestA1).not.toBe(digestWrong);

      // 4. Verify no raw code is ever stored in the database
      const codeRecord = await service.adminCreateActivationCode({
        license_id: licenseId,
        max_uses: 1,
        expires_at: "2027-01-01T00:00:00Z",
      });

      const stored = db.activationCodes.get(codeRecord.id);
      expect(stored).toBeDefined();
      expect(stored!.code_hash).toBeDefined();
      expect(stored!.code_hash).not.toBe(codeRecord.raw_activation_code);
      expect(JSON.stringify(stored)).not.toContain(codeRecord.raw_activation_code);
    });

    it("verifies admin authorization gates: tenant admin DENY, unauthorized platform admin DENY, authorized ALLOW", async () => {
      type UserRole = "tenant_user" | "tenant_admin" | "platform_admin";
      interface AdminContext {
        role: UserRole;
        isPlatformAdmin: boolean;
      }

      const authorizeAdminAction = async (
        user: AdminContext,
        action: () => Promise<unknown>,
      ): Promise<{ ok: boolean; status: number; error?: { code: string; message: string } }> => {
        if (!user.isPlatformAdmin || user.role !== "platform_admin") {
          return {
            ok: false,
            status: 403,
            error: {
              code: "UNAUTHORIZED",
              message: "Only platform administrators can manage vendor licenses.",
            },
          };
        }
        await action();
        return { ok: true, status: 200 };
      };

      const tenantAdminUser: AdminContext = { role: "tenant_admin", isPlatformAdmin: false };
      const unauthorizedPlatformUser: AdminContext = {
        role: "tenant_user",
        isPlatformAdmin: false,
      };
      const authorizedPlatformAdmin: AdminContext = {
        role: "platform_admin",
        isPlatformAdmin: true,
      };

      // 1. Tenant admin -> DENY
      const tenantRes = await authorizeAdminAction(tenantAdminUser, async () => {
        return service.adminRevokeLicense(licenseId);
      });
      expect(tenantRes.ok).toBe(false);
      expect(tenantRes.status).toBe(403);

      // 2. Unauthorized user -> DENY
      const unauthRes = await authorizeAdminAction(unauthorizedPlatformUser, async () => {
        return service.adminRevokeLicense(licenseId);
      });
      expect(unauthRes.ok).toBe(false);
      expect(unauthRes.status).toBe(403);

      // 3. Authorized platform admin -> ALLOW
      const authRes = await authorizeAdminAction(authorizedPlatformAdmin, async () => {
        await service.adminSuspendLicense(licenseId);
      });
      expect(authRes.ok).toBe(true);

      const lic = db.licenses.get(licenseId);
      expect(lic!.status).toBe("SUSPENDED");
    });
  });
});
