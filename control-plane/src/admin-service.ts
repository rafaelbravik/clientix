import crypto from "crypto";
import type { DatabaseClient } from "../scripts/migrator";
import type { LicenseType } from "@/lib/licensing/types";
import { deriveActivationCodeDigest } from "@/lib/licensing/installation-auth";
import type { VendorSignerProvider } from "./signer";

export interface CustomerRecord {
  id: string;
  name: string;
  legal_name: string | null;
  billing_email: string;
  country: string | null;
  created_at: string;
  updated_at: string;
}

export interface LicenseRecord {
  id: string;
  customer_id: string;
  customer_name?: string;
  customer_email?: string;
  license_type: LicenseType;
  status: "ACTIVE" | "SUSPENDED" | "REVOKED";
  signing_key_id: string;
  issued_at: string;
  valid_from: string;
  expires_at: string;
  maintenance_until: string | null;
  grace_days: number;
  max_installations: number;
  max_tenants: number | null;
  resale_allowed: boolean;
  white_label: boolean;
  features: string[];
  metadata: Record<string, unknown>;
  created_at: string;
  updated_at: string;
  active_installations_count?: number;
  temporal_state?: "VALID" | "GRACE" | "EXPIRED" | "NOT_YET_VALID";
}

export interface ActivationCodeRecord {
  id: string;
  license_id: string;
  max_uses: number;
  used_count: number;
  expires_at: string;
  revoked_at: string | null;
  created_at: string;
  is_valid: boolean;
}

export interface InstallationRecord {
  id: string;
  license_id: string;
  customer_name?: string;
  license_type?: string;
  license_status?: string;
  public_key_fingerprint: string;
  status: "ACTIVE" | "SUSPENDED" | "REVOKED" | "DEACTIVATED";
  environment: string;
  app_version: string | null;
  last_heartbeat_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface AuditEventRecord {
  id: string;
  license_id: string | null;
  installation_id: string | null;
  event_type: string;
  payload: Record<string, unknown>;
  actor: string;
  created_at: string;
}

export interface AdminServiceContext {
  db: DatabaseClient;
  signerProvider?: VendorSignerProvider;
  pepper: string;
  clockNow?: () => Date;
}

export interface CreateCustomerInput {
  name: string;
  legal_name?: string | null;
  billing_email: string;
  country?: string | null;
}

export interface UpdateCustomerInput {
  name?: string;
  legal_name?: string | null;
  billing_email?: string;
  country?: string | null;
}

export interface CreateLicenseInput {
  customer_id: string;
  license_type: LicenseType;
  max_installations: number;
  max_tenants?: number | null;
  resale_allowed?: boolean;
  white_label?: boolean;
  features?: string[];
  valid_from?: string;
  expires_at: string;
  maintenance_until?: string | null;
  grace_days?: number;
  signing_key_id?: string;
  metadata?: Record<string, unknown>;
  actor: string;
}

export interface RenewLicenseInput {
  license_id: string;
  new_expires_at?: string;
  new_maintenance_until?: string | null;
  actor: string;
}

export interface CreateActivationCodeInput {
  license_id: string;
  max_uses?: number;
  expires_at: string;
  actor: string;
}

export class ControlPlaneAdminService {
  constructor(private readonly ctx: AdminServiceContext) {}

  private now(): Date {
    return this.ctx.clockNow ? this.ctx.clockNow() : new Date();
  }

  private sanitizePayload(payload: Record<string, unknown>): Record<string, unknown> {
    const sensitiveKeys = new Set([
      "raw_activation_code",
      "activation_code",
      "token",
      "secret",
      "private_key",
      "private_key_pem",
      "code",
      "password",
      "pepper",
      "key",
    ]);

    const sanitize = (obj: unknown): unknown => {
      if (!obj || typeof obj !== "object") return obj;
      if (Array.isArray(obj)) return obj.map(sanitize);
      const res: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
        if (sensitiveKeys.has(k.toLowerCase()) || k.toLowerCase().includes("secret") || k.toLowerCase().includes("token")) {
          res[k] = "[REDACTED]";
        } else if (typeof v === "object" && v !== null) {
          res[k] = sanitize(v);
        } else {
          res[k] = v;
        }
      }
      return res;
    };

    return sanitize(payload) as Record<string, unknown>;
  }

  public async recordAdminEvent(params: {
    licenseId?: string | null;
    installationId?: string | null;
    eventType: string;
    payload?: Record<string, unknown>;
    actor: string;
  }): Promise<void> {
    const cleanPayload = this.sanitizePayload(params.payload ?? {});
    await this.ctx.db.query(
      `insert into control_plane.licensing_events (license_id, installation_id, event_type, payload, actor, created_at)
       values ($1, $2, $3, $4, $5, now());`,
      [
        params.licenseId ?? null,
        params.installationId ?? null,
        params.eventType,
        JSON.stringify(cleanPayload),
        params.actor,
      ]
    );
  }

  public computeTemporalState(
    validFrom: string,
    expiresAt: string,
    graceDays: number = 7
  ): "VALID" | "GRACE" | "EXPIRED" | "NOT_YET_VALID" {
    const nowMs = this.now().getTime();
    const validFromMs = new Date(validFrom).getTime();
    const expiresAtMs = new Date(expiresAt).getTime();
    const graceMs = graceDays * 24 * 60 * 60 * 1000;

    if (nowMs < validFromMs) return "NOT_YET_VALID";
    if (nowMs < expiresAtMs) return "VALID";
    if (nowMs < expiresAtMs + graceMs) return "GRACE";
    return "EXPIRED";
  }

  // =========================================================================
  // 1. CUSTOMERS
  // =========================================================================

  async listCustomers(params?: { search?: string; limit?: number; offset?: number }): Promise<CustomerRecord[]> {
    const limit = params?.limit ?? 50;
    const offset = params?.offset ?? 0;
    const search = params?.search?.trim();

    if (search) {
      const q = `%${search}%`;
      const res = await this.ctx.db.query<CustomerRecord>(
        `select id, name, legal_name, billing_email, country, created_at, updated_at
         from control_plane.licensing_customers
         where name ilike $1 or billing_email ilike $1 or coalesce(legal_name, '') ilike $1
         order by created_at desc
         limit $2 offset $3;`,
        [q, limit, offset]
      );
      return res.rows;
    }

    const res = await this.ctx.db.query<CustomerRecord>(
      `select id, name, legal_name, billing_email, country, created_at, updated_at
       from control_plane.licensing_customers
       order by created_at desc
       limit $1 offset $2;`,
      [limit, offset]
    );
    return res.rows;
  }

  async getCustomer(id: string): Promise<{ customer: CustomerRecord; licenses: LicenseRecord[] } | null> {
    const res = await this.ctx.db.query<CustomerRecord>(
      `select id, name, legal_name, billing_email, country, created_at, updated_at
       from control_plane.licensing_customers
       where id = $1;`,
      [id]
    );

    if (res.rows.length === 0) return null;
    const customer = res.rows[0]!;

    const licRes = await this.ctx.db.query<LicenseRecord>(
      `select l.*,
              (select count(*)::int from control_plane.licensing_installations i where i.license_id = l.id and i.status = 'ACTIVE') as active_installations_count
       from control_plane.licensing_licenses l
       where l.customer_id = $1
       order by l.created_at desc;`,
      [id]
    );

    const licenses = licRes.rows.map((l) => ({
      ...l,
      temporal_state: this.computeTemporalState(l.valid_from, l.expires_at, l.grace_days),
    }));

    return { customer, licenses };
  }

  async createCustomer(input: CreateCustomerInput, actor: string): Promise<CustomerRecord> {
    // Email format validation
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(input.billing_email)) {
      throw new Error("Invalid billing email format.");
    }

    // Country format: 2 uppercase letters or null
    const country = input.country ? input.country.trim().toUpperCase() : null;
    if (country && !/^[A-Z]{2}$/.test(country)) {
      throw new Error("Country must be a 2-letter uppercase ISO code (e.g. BR, US).");
    }

    const res = await this.ctx.db.query<CustomerRecord>(
      `insert into control_plane.licensing_customers
       (name, legal_name, billing_email, country, created_at, updated_at)
       values ($1, $2, $3, $4, now(), now())
       returning id, name, legal_name, billing_email, country, created_at, updated_at;`,
      [input.name.trim(), input.legal_name?.trim() || null, input.billing_email.trim().toLowerCase(), country]
    );

    const created = res.rows[0]!;
    await this.recordAdminEvent({
      eventType: "CUSTOMER_CREATED",
      actor,
      payload: { customer_id: created.id, name: created.name, billing_email: created.billing_email },
    });

    return created;
  }

  async updateCustomer(id: string, input: UpdateCustomerInput, actor: string): Promise<CustomerRecord> {
    const existing = await this.getCustomer(id);
    if (!existing) throw new Error("Customer not found.");

    const email = input.billing_email ? input.billing_email.trim().toLowerCase() : existing.customer.billing_email;
    if (input.billing_email) {
      const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
      if (!emailRegex.test(email)) throw new Error("Invalid billing email format.");
    }

    const country = input.country !== undefined ? (input.country ? input.country.trim().toUpperCase() : null) : existing.customer.country;
    if (country && !/^[A-Z]{2}$/.test(country)) {
      throw new Error("Country must be a 2-letter uppercase ISO code (e.g. BR, US).");
    }

    const name = input.name !== undefined ? input.name.trim() : existing.customer.name;
    const legalName = input.legal_name !== undefined ? (input.legal_name ? input.legal_name.trim() : null) : existing.customer.legal_name;

    const res = await this.ctx.db.query<CustomerRecord>(
      `update control_plane.licensing_customers
       set name = $2,
           legal_name = $3,
           billing_email = $4,
           country = $5,
           updated_at = now()
       where id = $1
       returning id, name, legal_name, billing_email, country, created_at, updated_at;`,
      [id, name, legalName, email, country]
    );

    const updated = res.rows[0]!;
    await this.recordAdminEvent({
      eventType: "CUSTOMER_UPDATED",
      actor,
      payload: { customer_id: id, changes: { name, legal_name: legalName, billing_email: email, country } },
    });

    return updated;
  }

  // =========================================================================
  // 2. LICENSES
  // =========================================================================

  async listLicenses(params?: {
    status?: "ACTIVE" | "SUSPENDED" | "REVOKED";
    license_type?: LicenseType;
    customer_id?: string;
    search?: string;
    limit?: number;
    offset?: number;
  }): Promise<LicenseRecord[]> {
    const limit = params?.limit ?? 50;
    const offset = params?.offset ?? 0;

    let sql = `
      select l.*,
             c.name as customer_name,
             c.billing_email as customer_email,
             (select count(*)::int from control_plane.licensing_installations i where i.license_id = l.id and i.status = 'ACTIVE') as active_installations_count
      from control_plane.licensing_licenses l
      join control_plane.licensing_customers c on c.id = l.customer_id
      where 1=1
    `;
    const queryParams: unknown[] = [];

    if (params?.status) {
      queryParams.push(params.status);
      sql += ` and l.status = $${queryParams.length}`;
    }
    if (params?.license_type) {
      queryParams.push(params.license_type);
      sql += ` and l.license_type = $${queryParams.length}`;
    }
    if (params?.customer_id) {
      queryParams.push(params.customer_id);
      sql += ` and l.customer_id = $${queryParams.length}`;
    }
    if (params?.search) {
      queryParams.push(`%${params.search.trim()}%`);
      sql += ` and (c.name ilike $${queryParams.length} or l.id::text ilike $${queryParams.length})`;
    }

    queryParams.push(limit);
    sql += ` order by l.created_at desc limit $${queryParams.length}`;

    queryParams.push(offset);
    sql += ` offset $${queryParams.length};`;

    const res = await this.ctx.db.query<LicenseRecord>(sql, queryParams);
    return res.rows.map((row) => ({
      ...row,
      temporal_state: this.computeTemporalState(row.valid_from, row.expires_at, row.grace_days),
    }));
  }

  async getLicenseDetail(id: string): Promise<{
    license: LicenseRecord;
    customer: CustomerRecord;
    installations: InstallationRecord[];
    activationCodes: ActivationCodeRecord[];
    events: AuditEventRecord[];
  } | null> {
    const res = await this.ctx.db.query<LicenseRecord & { cust_name: string; cust_legal: string | null; cust_email: string; cust_country: string | null }>(
      `select l.*,
              c.name as cust_name,
              c.legal_name as cust_legal,
              c.billing_email as cust_email,
              c.country as cust_country,
              (select count(*)::int from control_plane.licensing_installations i where i.license_id = l.id and i.status = 'ACTIVE') as active_installations_count
       from control_plane.licensing_licenses l
       join control_plane.licensing_customers c on c.id = l.customer_id
       where l.id = $1;`,
      [id]
    );

    if (res.rows.length === 0) return null;
    const row = res.rows[0]!;

    const customer: CustomerRecord = {
      id: row.customer_id,
      name: row.cust_name,
      legal_name: row.cust_legal,
      billing_email: row.cust_email,
      country: row.cust_country,
      created_at: row.created_at,
      updated_at: row.updated_at,
    };

    const license: LicenseRecord = {
      ...row,
      customer_name: customer.name,
      customer_email: customer.billing_email,
      temporal_state: this.computeTemporalState(row.valid_from, row.expires_at, row.grace_days),
    };

    const instRes = await this.ctx.db.query<InstallationRecord>(
      `select id, license_id, public_key_fingerprint, status, environment, app_version, last_heartbeat_at, created_at, updated_at
       from control_plane.licensing_installations
       where license_id = $1
       order by created_at desc;`,
      [id]
    );

    const codesRes = await this.ctx.db.query<ActivationCodeRecord>(
      `select id, license_id, max_uses, used_count, expires_at, revoked_at, created_at
       from control_plane.licensing_activation_codes
       where license_id = $1
       order by created_at desc;`,
      [id]
    );

    const now = this.now();
    const activationCodes = codesRes.rows.map((c) => ({
      ...c,
      is_valid: c.revoked_at === null && c.used_count < c.max_uses && new Date(c.expires_at) > now,
    }));

    const eventsRes = await this.ctx.db.query<AuditEventRecord>(
      `select id, license_id, installation_id, event_type, payload, actor, created_at
       from control_plane.licensing_events
       where license_id = $1
       order by created_at desc
       limit 50;`,
      [id]
    );

    return {
      license,
      customer,
      installations: instRes.rows,
      activationCodes,
      events: eventsRes.rows,
    };
  }

  async createLicense(input: CreateLicenseInput): Promise<LicenseRecord> {
    if (input.max_installations <= 0) {
      throw new Error("max_installations must be greater than 0.");
    }

    const validFrom = input.valid_from ? new Date(input.valid_from) : this.now();
    const expiresAt = new Date(input.expires_at);

    if (isNaN(validFrom.getTime()) || isNaN(expiresAt.getTime())) {
      throw new Error("Invalid date format for valid_from or expires_at.");
    }

    if (validFrom >= expiresAt) {
      throw new Error("valid_from must precede expires_at.");
    }

    const graceDays = input.grace_days ?? 7;
    if (graceDays < 0 || graceDays > 90) {
      throw new Error("grace_days must be between 0 and 90.");
    }

    // Resolve or validate active signing key
    let keyId = input.signing_key_id;
    if (!keyId) {
      const activeKeys = await this.ctx.db.query<{ key_id: string }>(
        `select key_id from control_plane.licensing_signer_keys where is_active = true limit 2;`
      );
      if (activeKeys.rows.length === 0) {
        throw new Error("No active signing keys configured in control_plane.licensing_signer_keys.");
      }
      if (activeKeys.rows.length > 1) {
        throw new Error("Multiple active signing keys exist. Explicit signing_key_id is required.");
      }
      keyId = activeKeys.rows[0]!.key_id;
    }

    const res = await this.ctx.db.query<LicenseRecord>(
      `insert into control_plane.licensing_licenses
       (customer_id, license_type, status, signing_key_id, issued_at, valid_from, expires_at, maintenance_until, grace_days, max_installations, max_tenants, resale_allowed, white_label, features, metadata, created_at, updated_at)
       values ($1, $2, 'ACTIVE', $3, now(), $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, now(), now())
       returning *;`,
      [
        input.customer_id,
        input.license_type,
        keyId,
        validFrom.toISOString(),
        expiresAt.toISOString(),
        input.maintenance_until || null,
        graceDays,
        input.max_installations,
        input.max_tenants ?? null,
        Boolean(input.resale_allowed),
        Boolean(input.white_label),
        input.features ?? [],
        JSON.stringify(input.metadata ?? {}),
      ]
    );

    const created = res.rows[0]!;
    await this.recordAdminEvent({
      licenseId: created.id,
      eventType: "LICENSE_CREATED",
      actor: input.actor,
      payload: {
        customer_id: input.customer_id,
        license_type: input.license_type,
        max_installations: input.max_installations,
        expires_at: created.expires_at,
      },
    });

    return {
      ...created,
      temporal_state: this.computeTemporalState(created.valid_from, created.expires_at, created.grace_days),
    };
  }

  async renewLicense(input: RenewLicenseInput): Promise<LicenseRecord> {
    const detail = await this.getLicenseDetail(input.license_id);
    if (!detail) throw new Error("License not found.");

    if (detail.license.status === "REVOKED") {
      throw new Error("Cannot renew a REVOKED license.");
    }

    let newExpiresAtIso = input.new_expires_at;
    if (!newExpiresAtIso) {
      // Default: extend by 1 year from current expires_at or now (whichever is later)
      const currentExp = new Date(detail.license.expires_at).getTime();
      const baseMs = Math.max(currentExp, this.now().getTime());
      newExpiresAtIso = new Date(baseMs + 365 * 24 * 60 * 60 * 1000).toISOString();
    }

    const newExp = new Date(newExpiresAtIso);
    if (isNaN(newExp.getTime()) || newExp <= new Date(detail.license.valid_from)) {
      throw new Error("New expiration date must be valid and after valid_from.");
    }

    const maintenanceUntil = input.new_maintenance_until !== undefined ? input.new_maintenance_until : detail.license.maintenance_until;

    const res = await this.ctx.db.query<LicenseRecord>(
      `update control_plane.licensing_licenses
       set expires_at = $2,
           maintenance_until = $3,
           updated_at = now()
       where id = $1
       returning *;`,
      [input.license_id, newExpiresAtIso, maintenanceUntil || null]
    );

    const updated = res.rows[0]!;

    await this.recordAdminEvent({
      licenseId: updated.id,
      eventType: "ADMIN_LICENSE_RENEWED",
      actor: input.actor,
      payload: {
        previous_expires_at: detail.license.expires_at,
        new_expires_at: updated.expires_at,
        maintenance_until: updated.maintenance_until,
      },
    });

    return {
      ...updated,
      temporal_state: this.computeTemporalState(updated.valid_from, updated.expires_at, updated.grace_days),
    };
  }

  async suspendLicense(licenseId: string, actor: string): Promise<LicenseRecord> {
    const detail = await this.getLicenseDetail(licenseId);
    if (!detail) throw new Error("License not found.");
    if (detail.license.status === "REVOKED") {
      throw new Error("Cannot suspend a REVOKED license.");
    }

    const res = await this.ctx.db.query<LicenseRecord>(
      `update control_plane.licensing_licenses
       set status = 'SUSPENDED', updated_at = now()
       where id = $1
       returning *;`,
      [licenseId]
    );

    const updated = res.rows[0]!;
    await this.recordAdminEvent({
      licenseId,
      eventType: "LICENSE_SUSPENDED",
      actor,
      payload: { previous_status: detail.license.status },
    });

    return {
      ...updated,
      temporal_state: this.computeTemporalState(updated.valid_from, updated.expires_at, updated.grace_days),
    };
  }

  async reactivateLicense(licenseId: string, actor: string): Promise<LicenseRecord> {
    const detail = await this.getLicenseDetail(licenseId);
    if (!detail) throw new Error("License not found.");
    if (detail.license.status === "REVOKED") {
      throw new Error("Cannot reactivate a REVOKED license. Revocation is permanent.");
    }

    const res = await this.ctx.db.query<LicenseRecord>(
      `update control_plane.licensing_licenses
       set status = 'ACTIVE', updated_at = now()
       where id = $1
       returning *;`,
      [licenseId]
    );

    const updated = res.rows[0]!;
    await this.recordAdminEvent({
      licenseId,
      eventType: "LICENSE_REACTIVATED",
      actor,
      payload: { previous_status: detail.license.status },
    });

    return {
      ...updated,
      temporal_state: this.computeTemporalState(updated.valid_from, updated.expires_at, updated.grace_days),
    };
  }

  async revokeLicense(licenseId: string, actor: string): Promise<LicenseRecord> {
    const detail = await this.getLicenseDetail(licenseId);
    if (!detail) throw new Error("License not found.");

    const res = await this.ctx.db.query<LicenseRecord>(
      `update control_plane.licensing_licenses
       set status = 'REVOKED', updated_at = now()
       where id = $1
       returning *;`,
      [licenseId]
    );

    const updated = res.rows[0]!;
    await this.recordAdminEvent({
      licenseId,
      eventType: "LICENSE_REVOKED",
      actor,
      payload: { previous_status: detail.license.status },
    });

    return {
      ...updated,
      temporal_state: this.computeTemporalState(updated.valid_from, updated.expires_at, updated.grace_days),
    };
  }

  // =========================================================================
  // 3. ACTIVATION CODES
  // =========================================================================

  async createActivationCode(input: CreateActivationCodeInput): Promise<{
    raw_activation_code: string;
    code: ActivationCodeRecord;
  }> {
    const detail = await this.getLicenseDetail(input.license_id);
    if (!detail) throw new Error("License not found.");
    if (detail.license.status === "REVOKED") {
      throw new Error("Cannot create activation code for a REVOKED license.");
    }

    const maxUses = input.max_uses ?? 1;
    if (maxUses <= 0) throw new Error("max_uses must be greater than 0.");

    const exp = new Date(input.expires_at);
    if (isNaN(exp.getTime()) || exp <= this.now()) {
      throw new Error("expires_at must be a valid future date.");
    }

    // Generate 32 cryptographically secure random bytes
    const randomBytes = crypto.randomBytes(32);
    const b64url = randomBytes.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
    const rawActivationCode = `ACT_${b64url}`;

    // Compute HMAC-SHA256 with pepper
    const codeHash = deriveActivationCodeDigest(rawActivationCode, this.ctx.pepper);

    const res = await this.ctx.db.query<ActivationCodeRecord>(
      `insert into control_plane.licensing_activation_codes
       (license_id, code_hash, max_uses, used_count, expires_at, created_at)
       values ($1, $2, $3, 0, $4, now())
       returning id, license_id, max_uses, used_count, expires_at, revoked_at, created_at;`,
      [input.license_id, codeHash, maxUses, exp.toISOString()]
    );

    const code = res.rows[0]!;

    await this.recordAdminEvent({
      licenseId: input.license_id,
      eventType: "ACTIVATION_CODE_CREATED",
      actor: input.actor,
      payload: { code_id: code.id, max_uses: maxUses, expires_at: code.expires_at },
    });

    return {
      raw_activation_code: rawActivationCode,
      code: { ...code, is_valid: true },
    };
  }

  async revokeActivationCode(codeId: string, actor: string): Promise<ActivationCodeRecord> {
    const res = await this.ctx.db.query<ActivationCodeRecord>(
      `update control_plane.licensing_activation_codes
       set revoked_at = now()
       where id = $1
       returning id, license_id, max_uses, used_count, expires_at, revoked_at, created_at;`,
      [codeId]
    );

    if (res.rows.length === 0) throw new Error("Activation code not found.");
    const code = res.rows[0]!;

    await this.recordAdminEvent({
      licenseId: code.license_id,
      eventType: "ACTIVATION_CODE_REVOKED",
      actor,
      payload: { code_id: code.id },
    });

    return { ...code, is_valid: false };
  }

  async listActivationCodes(licenseId: string): Promise<ActivationCodeRecord[]> {
    const res = await this.ctx.db.query<ActivationCodeRecord>(
      `select id, license_id, max_uses, used_count, expires_at, revoked_at, created_at
       from control_plane.licensing_activation_codes
       where license_id = $1
       order by created_at desc;`,
      [licenseId]
    );

    const now = this.now();
    return res.rows.map((c) => ({
      ...c,
      is_valid: c.revoked_at === null && c.used_count < c.max_uses && new Date(c.expires_at) > now,
    }));
  }

  // =========================================================================
  // 4. INSTALLATIONS
  // =========================================================================

  async listInstallations(params?: {
    license_id?: string;
    status?: string;
    search?: string;
    limit?: number;
    offset?: number;
  }): Promise<InstallationRecord[]> {
    const limit = params?.limit ?? 50;
    const offset = params?.offset ?? 0;

    let sql = `
      select i.id, i.license_id, i.public_key_fingerprint, i.status, i.environment, i.app_version, i.last_heartbeat_at, i.created_at, i.updated_at,
             c.name as customer_name,
             l.license_type,
             l.status as license_status
      from control_plane.licensing_installations i
      join control_plane.licensing_licenses l on l.id = i.license_id
      join control_plane.licensing_customers c on c.id = l.customer_id
      where 1=1
    `;
    const queryParams: unknown[] = [];

    if (params?.license_id) {
      queryParams.push(params.license_id);
      sql += ` and i.license_id = $${queryParams.length}`;
    }
    if (params?.status) {
      queryParams.push(params.status);
      sql += ` and i.status = $${queryParams.length}`;
    }
    if (params?.search) {
      queryParams.push(`%${params.search.trim()}%`);
      sql += ` and (i.id ilike $${queryParams.length} or i.public_key_fingerprint ilike $${queryParams.length} or c.name ilike $${queryParams.length})`;
    }

    queryParams.push(limit);
    sql += ` order by i.created_at desc limit $${queryParams.length}`;

    queryParams.push(offset);
    sql += ` offset $${queryParams.length};`;

    const res = await this.ctx.db.query<InstallationRecord>(sql, queryParams);
    return res.rows;
  }

  async getInstallationDetail(id: string): Promise<{
    installation: InstallationRecord & { public_key: string };
    license: LicenseRecord;
    customer: CustomerRecord;
    events: AuditEventRecord[];
  } | null> {
    const res = await this.ctx.db.query<
      InstallationRecord & {
        public_key: string;
        cust_id: string;
        cust_name: string;
        cust_legal: string | null;
        cust_email: string;
        cust_country: string | null;
        lic_type: LicenseType;
        lic_status: "ACTIVE" | "SUSPENDED" | "REVOKED";
        signing_key_id: string;
        issued_at: string;
        valid_from: string;
        expires_at: string;
        maintenance_until: string | null;
        grace_days: number;
        max_installations: number;
        max_tenants: number | null;
        resale_allowed: boolean;
        white_label: boolean;
        features: string[];
      }
    >(
      `select i.*,
              l.customer_id as cust_id,
              c.name as cust_name,
              c.legal_name as cust_legal,
              c.billing_email as cust_email,
              c.country as cust_country,
              l.license_type as lic_type,
              l.status as lic_status,
              l.signing_key_id,
              l.issued_at,
              l.valid_from,
              l.expires_at,
              l.maintenance_until,
              l.grace_days,
              l.max_installations,
              l.max_tenants,
              l.resale_allowed,
              l.white_label,
              l.features
       from control_plane.licensing_installations i
       join control_plane.licensing_licenses l on l.id = i.license_id
       join control_plane.licensing_customers c on c.id = l.customer_id
       where i.id = $1;`,
      [id]
    );

    if (res.rows.length === 0) return null;
    const row = res.rows[0]!;

    const customer: CustomerRecord = {
      id: row.cust_id,
      name: row.cust_name,
      legal_name: row.cust_legal,
      billing_email: row.cust_email,
      country: row.cust_country,
      created_at: row.created_at,
      updated_at: row.updated_at,
    };

    const license: LicenseRecord = {
      id: row.license_id,
      customer_id: customer.id,
      customer_name: customer.name,
      customer_email: customer.billing_email,
      license_type: row.lic_type,
      status: row.lic_status,
      signing_key_id: row.signing_key_id,
      issued_at: row.issued_at,
      valid_from: row.valid_from,
      expires_at: row.expires_at,
      maintenance_until: row.maintenance_until,
      grace_days: row.grace_days,
      max_installations: row.max_installations,
      max_tenants: row.max_tenants,
      resale_allowed: row.resale_allowed,
      white_label: row.white_label,
      features: row.features,
      metadata: {},
      created_at: row.created_at,
      updated_at: row.updated_at,
      temporal_state: this.computeTemporalState(row.valid_from, row.expires_at, row.grace_days),
    };

    const eventsRes = await this.ctx.db.query<AuditEventRecord>(
      `select id, license_id, installation_id, event_type, payload, actor, created_at
       from control_plane.licensing_events
       where installation_id = $1
       order by created_at desc
       limit 50;`,
      [id]
    );

    return {
      installation: {
        id: row.id,
        license_id: row.license_id,
        customer_name: customer.name,
        license_type: license.license_type,
        license_status: license.status,
        public_key: row.public_key,
        public_key_fingerprint: row.public_key_fingerprint,
        status: row.status,
        environment: row.environment,
        app_version: row.app_version,
        last_heartbeat_at: row.last_heartbeat_at,
        created_at: row.created_at,
        updated_at: row.updated_at,
      },
      license,
      customer,
      events: eventsRes.rows,
    };
  }

  async suspendInstallation(installationId: string, actor: string): Promise<InstallationRecord> {
    const detail = await this.getInstallationDetail(installationId);
    if (!detail) throw new Error("Installation not found.");
    if (detail.installation.status === "REVOKED") {
      throw new Error("Cannot suspend a REVOKED installation.");
    }

    const res = await this.ctx.db.query<InstallationRecord>(
      `update control_plane.licensing_installations
       set status = 'SUSPENDED', updated_at = now()
       where id = $1
       returning id, license_id, public_key_fingerprint, status, environment, app_version, last_heartbeat_at, created_at, updated_at;`,
      [installationId]
    );

    const updated = res.rows[0]!;
    await this.recordAdminEvent({
      licenseId: updated.license_id,
      installationId,
      eventType: "INSTALLATION_SUSPENDED",
      actor,
      payload: { previous_status: detail.installation.status },
    });

    return updated;
  }

  async reactivateInstallation(installationId: string, actor: string): Promise<InstallationRecord> {
    const detail = await this.getInstallationDetail(installationId);
    if (!detail) throw new Error("Installation not found.");
    if (detail.installation.status === "REVOKED") {
      throw new Error("Cannot reactivate a REVOKED installation.");
    }

    const res = await this.ctx.db.query<InstallationRecord>(
      `update control_plane.licensing_installations
       set status = 'ACTIVE', updated_at = now()
       where id = $1
       returning id, license_id, public_key_fingerprint, status, environment, app_version, last_heartbeat_at, created_at, updated_at;`,
      [installationId]
    );

    const updated = res.rows[0]!;
    await this.recordAdminEvent({
      licenseId: updated.license_id,
      installationId,
      eventType: "INSTALLATION_REACTIVATED",
      actor,
      payload: { previous_status: detail.installation.status },
    });

    return updated;
  }

  async revokeInstallation(installationId: string, actor: string): Promise<InstallationRecord> {
    const detail = await this.getInstallationDetail(installationId);
    if (!detail) throw new Error("Installation not found.");

    const res = await this.ctx.db.query<InstallationRecord>(
      `update control_plane.licensing_installations
       set status = 'REVOKED', updated_at = now()
       where id = $1
       returning id, license_id, public_key_fingerprint, status, environment, app_version, last_heartbeat_at, created_at, updated_at;`,
      [installationId]
    );

    const updated = res.rows[0]!;
    await this.recordAdminEvent({
      licenseId: updated.license_id,
      installationId,
      eventType: "INSTALLATION_REVOKED",
      actor,
      payload: { previous_status: detail.installation.status },
    });

    return updated;
  }

  async forceDeactivateInstallation(installationId: string, actor: string): Promise<InstallationRecord> {
    const detail = await this.getInstallationDetail(installationId);
    if (!detail) throw new Error("Installation not found.");
    if (detail.installation.status === "REVOKED") {
      throw new Error("Cannot deactivate a REVOKED installation.");
    }

    const res = await this.ctx.db.query<InstallationRecord>(
      `update control_plane.licensing_installations
       set status = 'DEACTIVATED', updated_at = now()
       where id = $1
       returning id, license_id, public_key_fingerprint, status, environment, app_version, last_heartbeat_at, created_at, updated_at;`,
      [installationId]
    );

    const updated = res.rows[0]!;
    await this.recordAdminEvent({
      licenseId: updated.license_id,
      installationId,
      eventType: "ADMIN_FORCE_DEACTIVATED",
      actor,
      payload: { previous_status: detail.installation.status },
    });

    return updated;
  }

  // =========================================================================
  // 5. AUDIT LOGS
  // =========================================================================

  async listAuditEvents(params?: {
    license_id?: string;
    installation_id?: string;
    event_type?: string;
    from_date?: string;
    to_date?: string;
    limit?: number;
    offset?: number;
  }): Promise<AuditEventRecord[]> {
    const limit = params?.limit ?? 50;
    const offset = params?.offset ?? 0;

    let sql = `
      select id, license_id, installation_id, event_type, payload, actor, created_at
      from control_plane.licensing_events
      where 1=1
    `;
    const queryParams: unknown[] = [];

    if (params?.license_id) {
      queryParams.push(params.license_id);
      sql += ` and license_id = $${queryParams.length}`;
    }
    if (params?.installation_id) {
      queryParams.push(params.installation_id);
      sql += ` and installation_id = $${queryParams.length}`;
    }
    if (params?.event_type) {
      queryParams.push(params.event_type);
      sql += ` and event_type = $${queryParams.length}`;
    }
    if (params?.from_date) {
      queryParams.push(params.from_date);
      sql += ` and created_at >= $${queryParams.length}`;
    }
    if (params?.to_date) {
      queryParams.push(params.to_date);
      sql += ` and created_at <= $${queryParams.length}`;
    }

    queryParams.push(limit);
    sql += ` order by created_at desc limit $${queryParams.length}`;

    queryParams.push(offset);
    sql += ` offset $${queryParams.length};`;

    const res = await this.ctx.db.query<AuditEventRecord>(sql, queryParams);
    return res.rows;
  }
}
