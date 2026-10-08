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
import { verifyLicense } from "@/lib/licensing/verify";
import { signIssuedLicense, type VendorSignerProvider } from "./signer";
import type { RateLimiter } from "./rate-limiter";

export interface DatabaseLicenseCustomerRow {
  id: string;
  customer_id: string;
  cust_id: string;
  cust_name: string;
  cust_email: string | null;
  cust_country: string | null;
  license_type: LicenseType;
  status: "ACTIVE" | "SUSPENDED" | "REVOKED";
  signing_key_id: string;
  max_installations: number;
  max_tenants: number | null;
  resale_allowed: boolean;
  white_label: boolean;
  features: string[];
  issued_at: string;
  valid_from: string;
  expires_at: string;
  maintenance_until: string | null;
  grace_days: number;
}

export interface ControlPlaneServiceContext {
  db: DatabaseClient;
  signerProvider: VendorSignerProvider;
  trustedPublicKeyMap: Record<string, string>; // For verify-before-response parity check
  pepper: string;
  nonceStore: NonceStore;
  rateLimiter?: RateLimiter;
  clockNow?: () => Date;
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
  license_status: "ACTIVE" | "SUSPENDED" | "REVOKED";
  installation_status: "ACTIVE" | "SUSPENDED" | "REVOKED" | "DEACTIVATED";
  server_timestamp: string;
}

export interface HeartbeatParams {
  installation_id: string;
  app_version?: string;
  schema_version?: string;
  release_version?: string;
  local_license_state?: string;
  timestamp: number;
  nonce: string;
  signatureBase64url: string;
  rawBody?: string;
}

export interface HeartbeatResponseData {
  license_status: "ACTIVE" | "SUSPENDED" | "REVOKED";
  installation_status: "ACTIVE" | "SUSPENDED" | "REVOKED" | "DEACTIVATED";
  temporal_state: "NOT_YET_VALID" | "VALID" | "GRACE" | "EXPIRED";
  server_timestamp: string;
  revocation_artifact?: string; // Signed proof of status
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
  constructor(private readonly ctx: ControlPlaneServiceContext) {}

  private now(): Date {
    return this.ctx.clockNow ? this.ctx.clockNow() : new Date();
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
      ]
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
      const rateKey = `act:${params.clientIp || "unknown"}:${params.installation_id}`;
      const limit = await this.ctx.rateLimiter.checkLimit(rateKey, 10, 60);
      if (!limit.allowed) {
        return {
          ok: false,
          status: 429,
          error: { code: "RATE_LIMITED", message: "Too many activation attempts. Rate limit exceeded." },
        };
      }
    }

    // 2. Validate format contracts
    if (!isValidCanonicalInstallationId(params.installation_id)) {
      return {
        ok: false,
        status: 400,
        error: { code: "MALFORMED_REQUEST", message: "Invalid installation_id format (expected inst_<UUIDv4>)." },
      };
    }

    if (!isValidInstallationPublicKey(params.installation_public_key)) {
      return {
        ok: false,
        status: 400,
        error: { code: "MALFORMED_REQUEST", message: "Invalid Ed25519 SPKI public key PEM." },
      };
    }

    if (!params.activation_code || typeof params.activation_code !== "string" || !params.activation_code.startsWith("ACT_")) {
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
      public_key: string;
      public_key_fingerprint: string;
      status: "ACTIVE" | "SUSPENDED" | "REVOKED" | "DEACTIVATED";
    }>(
      `select id, license_id, public_key, public_key_fingerprint, status from control_plane.licensing_installations where id = $1;`,
      [params.installation_id]
    );

    if (existingInstRes.rows.length > 0) {
      const existingInst = existingInstRes.rows[0]!;
      // Key mismatch: Deny with INSTALLATION_KEY_MISMATCH
      if (existingInst.public_key_fingerprint !== pubKeyFingerprint) {
        await this.recordEvent({
          installationId: params.installation_id,
          eventType: "ACTIVATION_FAILED",
          payload: { reason: "KEY_MISMATCH" },
        });
        return {
          ok: false,
          status: 409,
          error: { code: "INSTALLATION_KEY_MISMATCH", message: "Installation already registered with a different public key." },
        };
      }

      // Idempotent recovery of existing license
      const licRes = await this.ctx.db.query<DatabaseLicenseCustomerRow>(
        `select l.*, c.id as cust_id, c.name as cust_name, c.billing_email as cust_email, c.country as cust_country
         from control_plane.licensing_licenses l
         join control_plane.licensing_customers c on c.id = l.customer_id
         where l.id = $1;`,
        [existingInst.license_id]
      );
      if (licRes.rows.length > 0) {
        const lic = licRes.rows[0]!;
        const payload: LicensePayload = {
          license_version: 1,
          license_id: lic.id,
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
          issued_at: new Date(lic.issued_at).toISOString(),
          valid_from: new Date(lic.valid_from).toISOString(),
          expires_at: new Date(lic.expires_at).toISOString(),
          maintenance_until: lic.maintenance_until ? new Date(lic.maintenance_until).toISOString() : undefined,
        };

        const signed = await signIssuedLicense(payload, this.ctx.signerProvider, lic.signing_key_id);
        return {
          ok: true,
          status: 200,
          data: {
            signed_license: signed,
            license_status: lic.status,
            installation_status: existingInst.status,
            server_timestamp: serverTimestamp,
          },
        };
      }
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
        [codeHash]
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
          error: { code: "ACTIVATION_CODE_EXHAUSTED", message: "Activation code usage limit reached." },
        };
      }

      // Lock license row to check max_installations quota
      const licRes = await this.ctx.db.query<DatabaseLicenseCustomerRow>(
        `select l.*, c.id as cust_id, c.name as cust_name, c.billing_email as cust_email, c.country as cust_country
         from control_plane.licensing_licenses l
         join control_plane.licensing_customers c on c.id = l.customer_id
         where l.id = $1
         for update;`,
        [codeRow.license_id]
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
         where license_id = $1 and status in ('ACTIVE', 'SUSPENDED', 'REVOKED');`,
        [lic.id]
      );
      const currentSlots = parseInt(slotRes.rows[0]!.count, 10);
      if (currentSlots >= lic.max_installations) {
        await this.ctx.db.query("ROLLBACK;");
        return {
          ok: false,
          status: 409,
          error: { code: "ACTIVATION_LIMIT_REACHED", message: "Maximum installations limit reached for this license." },
        };
      }

      // Check public key uniqueness across all installations
      const fpCheck = await this.ctx.db.query(
        `select id from control_plane.licensing_installations where public_key_fingerprint = $1;`,
        [pubKeyFingerprint]
      );
      if (fpCheck.rows.length > 0) {
        await this.ctx.db.query("ROLLBACK;");
        return {
          ok: false,
          status: 409,
          error: { code: "INSTALLATION_KEY_MISMATCH", message: "Public key is already associated with another installation." },
        };
      }

      // Increment used_count atomically
      await this.ctx.db.query(
        `update control_plane.licensing_activation_codes
         set used_count = used_count + 1
         where id = $1;`,
        [codeRow.id]
      );

      // Insert installation
      await this.ctx.db.query(
        `insert into control_plane.licensing_installations
         (id, license_id, public_key, public_key_fingerprint, status, environment, app_version, last_heartbeat_at, created_at, updated_at)
         values ($1, $2, $3, $4, 'ACTIVE', 'production', $5, now(), now(), now());`,
        [params.installation_id, lic.id, params.installation_public_key, pubKeyFingerprint, params.app_version || null]
      );

      // Record audit event
      await this.recordEvent({
        licenseId: lic.id,
        installationId: params.installation_id,
        eventType: "INSTALLATION_ACTIVATED",
        payload: {
          app_version: params.app_version,
          fingerprint: pubKeyFingerprint,
        },
      });

      await this.ctx.db.query("COMMIT;");

      // Build & sign license document
      const payload: LicensePayload = {
        license_version: 1,
        license_id: lic.id,
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
        issued_at: new Date(lic.issued_at).toISOString(),
        valid_from: new Date(lic.valid_from).toISOString(),
        expires_at: new Date(lic.expires_at).toISOString(),
        maintenance_until: lic.maintenance_until ? new Date(lic.maintenance_until).toISOString() : undefined,
      };

      const signed = await signIssuedLicense(payload, this.ctx.signerProvider, lic.signing_key_id);

      // Verification before response parity check
      const verification = verifyLicense(signed, {
        now: serverDate,
        expectedInstallationId: params.installation_id,
        trustedKeys: this.ctx.trustedPublicKeyMap,
      });

      if (!verification.usable) {
        throw new Error(`Self-issued license failed client verification: ${verification.reason}`);
      }

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
      const rateKey = `hb:${params.installation_id}`;
      const limit = await this.ctx.rateLimiter.checkLimit(rateKey, 60, 60);
      if (!limit.allowed) {
        return {
          ok: false,
          status: 429,
          error: { code: "RATE_LIMITED", message: "Too many heartbeat requests. Rate limit exceeded." },
        };
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
      status: "ACTIVE" | "SUSPENDED" | "REVOKED" | "DEACTIVATED";
    }>(
      `select id, license_id, public_key, status from control_plane.licensing_installations where id = $1;`,
      [params.installation_id]
    );

    if (instRes.rows.length === 0) {
      return {
        ok: false,
        status: 404,
        error: { code: "UNAUTHORIZED", message: "Installation not found." },
      };
    }

    const inst = instRes.rows[0]!;

    // 4. Proof-of-Possession (PoP) Authentication Check
    const bodyObject: Record<string, unknown> = {
      installation_id: params.installation_id,
      timestamp: params.timestamp,
      nonce: params.nonce,
    };
    if (params.app_version !== undefined) bodyObject.app_version = params.app_version;
    if (params.schema_version !== undefined) bodyObject.schema_version = params.schema_version;
    if (params.release_version !== undefined) bodyObject.release_version = params.release_version;
    if (params.local_license_state !== undefined) bodyObject.local_license_state = params.local_license_state;

    const serializedBody =
      params.rawBody !== undefined
        ? params.rawBody
        : JSON.stringify(bodyObject);

    const authCheck = await verifyInstallationRequestSignature({
      installationId: params.installation_id,
      timestamp: params.timestamp,
      nonce: params.nonce,
      method: "POST",
      path: "/api/v1/licensing/heartbeat",
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
          error: { code: "CLOCK_SKEW_EXCEEDED", message: "Timestamp outside allowable clock drift window." },
        };
      }
      return {
        ok: false,
        status: 401,
        error: { code: "INVALID_INSTALLATION_SIGNATURE", message: "Invalid installation cryptographic signature." },
      };
    }

    // 3. Query license status
    const licRes = await this.ctx.db.query<{
      id: string;
      status: "ACTIVE" | "SUSPENDED" | "REVOKED";
      valid_from: string;
      expires_at: string;
      grace_days: number;
    }>(
      `select id, status, valid_from, expires_at, grace_days from control_plane.licensing_licenses where id = $1;`,
      [inst.license_id]
    );

    const lic = licRes.rows[0]!;

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
           app_version = coalesce($2, app_version),
           updated_at = now()
       where id = $1;`,
      [params.installation_id, params.app_version || null]
    );

    await this.recordEvent({
      licenseId: lic.id,
      installationId: inst.id,
      eventType: "HEARTBEAT_RECORDED",
      payload: {
        app_version: params.app_version,
        schema_version: params.schema_version,
      },
    });

    return {
      ok: true,
      status: 200,
      data: {
        license_status: lic.status,
        installation_status: inst.status,
        temporal_state: temporalState,
        server_timestamp: serverTimestamp,
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
          error: { code: "RATE_LIMITED", message: "Too many renewal requests. Rate limit exceeded." },
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
      [params.installation_id]
    );

    if (instRes.rows.length === 0) {
      return { ok: false, status: 404, error: { code: "UNAUTHORIZED", message: "Installation not found." } };
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
        return { ok: false, status: 409, error: { code: "REPLAY_DETECTED", message: "Replay attack detected." } };
      }
      if (authCheck.code === "INVALID_TIMESTAMP") {
        return { ok: false, status: 401, error: { code: "CLOCK_SKEW_EXCEEDED", message: "Timestamp outside allowable clock drift window." } };
      }
      return { ok: false, status: 401, error: { code: "INVALID_INSTALLATION_SIGNATURE", message: "Invalid signature." } };
    }

    // Query license
    const licRes = await this.ctx.db.query<DatabaseLicenseCustomerRow>(
      `select l.*, c.id as cust_id, c.name as cust_name, c.billing_email as cust_email, c.country as cust_country
       from control_plane.licensing_licenses l
       join control_plane.licensing_customers c on c.id = l.customer_id
       where l.id = $1;`,
      [inst.license_id]
    );

    const lic = licRes.rows[0]!;

    if (lic.status === "REVOKED" || inst.status === "REVOKED") {
      return { ok: false, status: 403, error: { code: "LICENSE_REVOKED", message: "License or installation is revoked. Renewal denied." } };
    }

    if (lic.status === "SUSPENDED" || inst.status === "SUSPENDED") {
      return { ok: false, status: 403, error: { code: "LICENSE_SUSPENDED", message: "License or installation is suspended." } };
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
        error: { code: "RENEWAL_NOT_ALLOWED", message: "License is expired past grace period. Contact vendor administrator." },
      };
    }

    // Issue refreshed/renewed document
    const payload: LicensePayload = {
      license_version: 1,
      license_id: lic.id,
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
      issued_at: serverTimestamp,
      valid_from: new Date(lic.valid_from).toISOString(),
      expires_at: new Date(lic.expires_at).toISOString(),
      maintenance_until: lic.maintenance_until ? new Date(lic.maintenance_until).toISOString() : undefined,
    };

    const signed = await signIssuedLicense(payload, this.ctx.signerProvider, lic.signing_key_id);

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
          error: { code: "RATE_LIMITED", message: "Too many deactivation requests. Rate limit exceeded." },
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
      [params.installation_id]
    );

    if (instRes.rows.length === 0) {
      return { ok: false, status: 404, error: { code: "UNAUTHORIZED", message: "Installation not found." } };
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
        error: { code: "INSTALLATION_REVOKED", message: "Revoked installations cannot self-deactivate. Admin action required." },
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
        return { ok: false, status: 409, error: { code: "REPLAY_DETECTED", message: "Replay attack detected." } };
      }
      if (authCheck.code === "INVALID_TIMESTAMP") {
        return { ok: false, status: 401, error: { code: "CLOCK_SKEW_EXCEEDED", message: "Timestamp outside allowable clock drift window." } };
      }
      return { ok: false, status: 401, error: { code: "INVALID_INSTALLATION_SIGNATURE", message: "Invalid signature." } };
    }

    // Atomic status transition
    await this.ctx.db.query(
      `update control_plane.licensing_installations
       set status = 'DEACTIVATED', updated_at = now()
       where id = $1;`,
      [params.installation_id]
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
      ]
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
    const b64url = rawBytes.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
    const rawCode = `ACT_${b64url}`;

    const codeHash = deriveActivationCodeDigest(rawCode, this.ctx.pepper);

    const res = await this.ctx.db.query<{ id: string }>(
      `insert into control_plane.licensing_activation_codes
       (license_id, code_hash, max_uses, used_count, expires_at, created_at)
       values ($1, $2, coalesce($3, 1), 0, $4, now())
       returning id;`,
      [params.license_id, codeHash, params.max_uses ?? 1, params.expires_at]
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
      [licenseId]
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
      [licenseId]
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
      [installationId]
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
