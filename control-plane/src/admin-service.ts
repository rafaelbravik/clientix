import crypto from "crypto";
import type { DatabaseClient } from "../scripts/migrator";
import type { LicenseType } from "@/lib/licensing/types";
import {
  computePublicKeyFingerprint,
  deriveActivationCodeDigest,
  isValidCanonicalInstallationId,
  isValidInstallationPublicKey,
} from "@/lib/licensing/installation-auth";
import type { VendorSignerProvider } from "./signer";
import { generateLicenseSerial } from "./license-serial";

export interface CustomerRecord {
  id: string;
  name: string;
  legal_name: string | null;
  billing_email: string;
  phone: string | null;
  internal_notes: string | null;
  country: string | null;
  status: "ACTIVE" | "DISABLED";
  created_at: string;
  updated_at: string;
}

export interface LicenseRecord {
  id: string;
  serial: string;
  customer_id: string;
  customer_name?: string;
  customer_email?: string;
  license_type: LicenseType;
  product: "clientix";
  deployment: "self-hosted";
  plan: "standard" | "pro" | "enterprise";
  status: "DRAFT" | "ACTIVE" | "EXPIRED" | "SUSPENDED" | "REVOKED";
  signing_key_id: string;
  issued_at: string | null;
  valid_from: string;
  expires_at: string;
  maintenance_until: string | null;
  grace_days: number;
  max_installations: number;
  max_tenants: number | null;
  resale_allowed: boolean;
  white_label: boolean;
  features: string[];
  revoked_at: string | null;
  revocation_reason: string | null;
  offline_validation_tolerance_days: number;
  next_check_hours: number;
  metadata: Record<string, unknown>;
  created_at: string;
  updated_at: string;
  active_installations_count?: number;
  last_validation_at?: string | null;
  temporal_state?: "VALID" | "GRACE" | "EXPIRED" | "NOT_YET_VALID";
  days_remaining?: number;
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
  serial?: string;
  customer_name?: string;
  license_type?: string;
  license_status?: string;
  public_key_fingerprint: string;
  status: "ACTIVE" | "SUSPENDED" | "REVOKED" | "DEACTIVATED" | "TRANSFERRED" | "DISABLED";
  environment: string;
  app_version: string | null;
  last_heartbeat_at: string | null;
  last_validation_at?: string | null;
  clientix_version?: string | null;
  active_session_id?: string | null;
  clone_status?: "NORMAL" | "SUSPECTED_CLONE" | "CLONE_CONFIRMED" | "TRANSFER_PENDING";
  clone_conflict_count?: number;
  last_clone_conflict_at?: string | null;
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
  actor_type?: string;
  actor_id?: string | null;
  request_id?: string | null;
  created_at: string;
}

export interface PageResult<T> {
  items: T[];
  total: number;
  limit: number;
  offset: number;
}

export interface CommercialDashboardSummary {
  total_customers: number;
  active_licenses: number;
  grace_licenses: number;
  expired_licenses: number;
  suspended_licenses: number;
  revoked_licenses: number;
  expiring_30_days: number;
  expiring_15_days: number;
  expiring_7_days: number;
  expiring_1_day: number;
  active_installations: number;
  suspicious_clones: number;
  upcoming_expirations: Array<{
    id: string;
    serial: string;
    customer_name: string;
    plan: LicenseRecord["plan"];
    status: LicenseRecord["status"];
    expires_at: string;
    days_remaining: number;
  }>;
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
  document?: string | null;
  billing_email: string;
  phone?: string | null;
  internal_notes?: string | null;
  country?: string | null;
}

export interface UpdateCustomerInput {
  name?: string;
  legal_name?: string | null;
  billing_email?: string;
  document?: string | null;
  phone?: string | null;
  internal_notes?: string | null;
  country?: string | null;
}

export interface CreateLicenseInput {
  customer_id: string;
  license_type: LicenseType;
  plan?: "standard" | "pro" | "enterprise";
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
  offline_validation_tolerance_days?: number;
  next_check_hours?: number;
  status?: "DRAFT" | "ACTIVE";
  metadata?: Record<string, unknown>;
  idempotency_key?: string;
  request_id?: string;
  actor: string;
}

export interface RenewLicenseInput {
  license_id: string;
  duration_months?: number;
  duration_days?: 30 | 90;
  new_expires_at?: string;
  new_maintenance_until?: string | null;
  idempotency_key: string;
  active_signing_key_id?: string;
  renewal_basis?: "previous_expiration" | "today";
  request_id?: string;
  actor: string;
}

export interface RevokeLicenseInput {
  license_id: string;
  reason: string;
  actor: string;
  request_id?: string;
}

export interface TransferLicenseInput {
  license_id: string;
  from_installation_id: string;
  to_installation_id: string;
  to_public_key: string;
  clientix_version?: string;
  reason: string;
  actor: string;
  request_id?: string;
}

export interface CreateActivationCodeInput {
  license_id: string;
  max_uses?: number;
  expires_at: string;
  actor: string;
  request_id?: string;
}

export interface InstanceSessionRecord {
  session_id: string;
  status: "ACTIVE" | "ENDED";
  boot_started_at: string;
  started_at: string;
  last_heartbeat_at: string;
  ended_at: string | null;
  clientix_version: string | null;
  heartbeat_fresh: boolean;
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
      "credential",
      "signing_key",
      "pepper",
      "key",
    ]);

    const sanitize = (obj: unknown): unknown => {
      if (!obj || typeof obj !== "object") return obj;
      if (Array.isArray(obj)) return obj.map(sanitize);
      const res: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
        if (
          sensitiveKeys.has(k.toLowerCase()) ||
          k.toLowerCase().includes("secret") ||
          k.toLowerCase().includes("token") ||
          k.toLowerCase().includes("password") ||
          k.toLowerCase().includes("credential") ||
          k.toLowerCase().includes("private")
        ) {
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
    requestId?: string;
  }): Promise<void> {
    const cleanPayload = this.sanitizePayload(params.payload ?? {});
    await this.ctx.db.query(
      `insert into control_plane.licensing_events (license_id, installation_id, event_type, payload, actor, actor_type, actor_id, request_id, created_at)
       values ($1, $2, $3, $4, 'admin', 'ADMIN', $5, $6, now());`,
      [
        params.licenseId ?? null,
        params.installationId ?? null,
        params.eventType,
        JSON.stringify(cleanPayload),
        params.actor,
        params.requestId ?? null,
      ],
    );
  }

  public computeTemporalState(
    validFrom: string,
    expiresAt: string,
    graceDays: number = 7,
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

  private normalizedDocumentHash(value: string | undefined | null): string | null {
    const normalized = value?.replace(/[^\p{L}\p{N}]/gu, "").toUpperCase() ?? "";
    if (normalized.length < 8 || normalized.length > 32) return null;
    return crypto.createHmac("sha256", this.ctx.pepper).update(normalized).digest("hex");
  }

  private boundedPage(limit = 25, offset = 0): { limit: number; offset: number } {
    return {
      limit: Math.min(100, Math.max(1, Math.trunc(limit))),
      offset: Math.min(100_000, Math.max(0, Math.trunc(offset))),
    };
  }

  async getCommercialDashboardSummary(): Promise<CommercialDashboardSummary> {
    const counts = await this.ctx.db.query<{
      total_customers: number;
      active_licenses: number;
      grace_licenses: number;
      expired_licenses: number;
      suspended_licenses: number;
      revoked_licenses: number;
      expiring_30_days: number;
      expiring_15_days: number;
      expiring_7_days: number;
      expiring_1_day: number;
      active_installations: number;
      suspicious_clones: number;
    }>(`
      select
        (select count(*)::int from control_plane.licensing_customers) as total_customers,
        count(*) filter (where l.status = 'ACTIVE' and l.valid_from <= now() and l.expires_at > now())::int as active_licenses,
        count(*) filter (where l.status in ('ACTIVE', 'EXPIRED') and l.expires_at <= now()
          and l.expires_at + make_interval(days => l.grace_days) > now())::int as grace_licenses,
        count(*) filter (where l.status in ('ACTIVE', 'EXPIRED')
          and l.expires_at + make_interval(days => l.grace_days) <= now())::int as expired_licenses,
        count(*) filter (where l.status = 'SUSPENDED')::int as suspended_licenses,
        count(*) filter (where l.status = 'REVOKED')::int as revoked_licenses,
        count(*) filter (where l.status = 'ACTIVE' and l.expires_at >= now()
          and l.expires_at < now() + interval '30 days')::int as expiring_30_days,
        count(*) filter (where l.status = 'ACTIVE' and l.expires_at >= now()
          and l.expires_at < now() + interval '15 days')::int as expiring_15_days,
        count(*) filter (where l.status = 'ACTIVE' and l.expires_at >= now()
          and l.expires_at < now() + interval '7 days')::int as expiring_7_days,
        count(*) filter (where l.status = 'ACTIVE' and l.expires_at >= now()
          and l.expires_at < now() + interval '1 day')::int as expiring_1_day,
        (select count(*)::int from control_plane.licensing_installations i where i.status = 'ACTIVE') as active_installations,
        (select count(*)::int from control_plane.licensing_installations i
          where i.clone_status in ('SUSPECTED_CLONE', 'CLONE_CONFIRMED')) as suspicious_clones
      from control_plane.licensing_licenses l;`);
    const row = counts.rows[0];
    if (!row) throw new Error("Commercial dashboard is unavailable.");
    const upcoming = await this.ctx.db.query<
      CommercialDashboardSummary["upcoming_expirations"][number]
    >(`
      select l.id, l.serial, c.name as customer_name, l.plan, l.status, l.expires_at,
             greatest(0, ceil(extract(epoch from (l.expires_at - now())) / 86400))::int as days_remaining
        from control_plane.licensing_licenses l
        join control_plane.licensing_customers c on c.id = l.customer_id
       where l.status = 'ACTIVE' and l.expires_at >= now() and l.expires_at < now() + interval '30 days'
       order by l.expires_at asc, l.id asc
       limit 12;`);
    return { ...row, upcoming_expirations: upcoming.rows };
  }

  async listCommercialCustomers(params?: {
    search?: string;
    status?: CustomerRecord["status"];
    sort?: "name" | "created_at";
    direction?: "asc" | "desc";
    limit?: number;
    offset?: number;
  }): Promise<PageResult<CustomerRecord>> {
    const { limit, offset } = this.boundedPage(params?.limit, params?.offset);
    const values: unknown[] = [];
    const conditions: string[] = [];
    const search = params?.search?.trim();
    if (search) {
      const escaped = `%${search.replace(/[\\%_]/g, "\\$&")}%`;
      values.push(escaped);
      const ix = values.length;
      const documentHash = this.normalizedDocumentHash(search);
      conditions.push(
        `(name ilike $${ix} escape E'\\\\' or coalesce(legal_name, '') ilike $${ix} escape E'\\\\'
        or billing_email ilike $${ix} escape E'\\\\' or id::text ilike $${ix}` +
          (documentHash ? ` or document_hash = $${values.push(documentHash)}` : "") +
          ")",
      );
    }
    if (params?.status) {
      values.push(params.status);
      conditions.push(`status = $${values.length}`);
    }
    const where = conditions.length ? `where ${conditions.join(" and ")}` : "";
    const countResult = await this.ctx.db.query<{ total: number }>(
      `select count(*)::int as total from control_plane.licensing_customers ${where};`,
      values,
    );
    const sortColumn = params?.sort === "name" ? "lower(name)" : "created_at";
    const direction = params?.direction === "asc" ? "asc" : "desc";
    const pageValues = [...values, limit, offset];
    const result = await this.ctx.db.query<CustomerRecord>(
      `select id, name, legal_name, billing_email, phone, internal_notes, country, status, created_at, updated_at
         from control_plane.licensing_customers ${where}
        order by ${sortColumn} ${direction}, id asc
        limit $${pageValues.length - 1} offset $${pageValues.length};`,
      pageValues,
    );
    return { items: result.rows, total: countResult.rows[0]?.total ?? 0, limit, offset };
  }

  async listCommercialLicenses(params?: {
    status?: LicenseRecord["status"];
    license_type?: LicenseType;
    plan?: LicenseRecord["plan"];
    customer_id?: string;
    expires_in_days?: number;
    validity?: "VALID" | "GRACE" | "EXPIRED" | "NOT_YET_VALID";
    installation_status?: "ACTIVE" | "INACTIVE";
    clone_status?: InstallationRecord["clone_status"];
    search?: string;
    sort?: "customer" | "status" | "expires_at" | "created_at" | "last_validation";
    direction?: "asc" | "desc";
    limit?: number;
    offset?: number;
  }): Promise<PageResult<LicenseRecord>> {
    const { limit, offset } = this.boundedPage(params?.limit, params?.offset);
    const values: unknown[] = [];
    const conditions: string[] = [];
    const add = (condition: (index: number) => string, value: unknown) => {
      values.push(value);
      conditions.push(condition(values.length));
    };
    if (params?.status) add((i) => `l.status = $${i}`, params.status);
    if (params?.license_type) add((i) => `l.license_type = $${i}`, params.license_type);
    if (params?.plan) add((i) => `l.plan = $${i}`, params.plan);
    if (params?.customer_id) add((i) => `l.customer_id = $${i}`, params.customer_id);
    if (params?.expires_in_days !== undefined)
      add(
        (i) =>
          `l.status = 'ACTIVE' and l.expires_at >= now() and l.expires_at < now() + make_interval(days => $${i})`,
        params.expires_in_days,
      );
    if (params?.validity === "VALID")
      conditions.push(`l.status = 'ACTIVE' and l.valid_from <= now() and l.expires_at > now()`);
    if (params?.validity === "GRACE")
      conditions.push(
        `l.status in ('ACTIVE', 'EXPIRED') and l.expires_at <= now() and l.expires_at + make_interval(days => l.grace_days) > now()`,
      );
    if (params?.validity === "EXPIRED")
      conditions.push(
        `(l.status = 'EXPIRED' or (l.status = 'ACTIVE' and l.expires_at + make_interval(days => l.grace_days) <= now()))`,
      );
    if (params?.validity === "NOT_YET_VALID") conditions.push(`l.valid_from > now()`);
    if (params?.installation_status === "ACTIVE")
      conditions.push(
        `exists (select 1 from control_plane.licensing_installations i where i.license_id = l.id and i.status = 'ACTIVE')`,
      );
    if (params?.installation_status === "INACTIVE")
      conditions.push(
        `not exists (select 1 from control_plane.licensing_installations i where i.license_id = l.id and i.status = 'ACTIVE')`,
      );
    if (params?.clone_status)
      add(
        (i) =>
          `exists (select 1 from control_plane.licensing_installations i where i.license_id = l.id and i.clone_status = $${i})`,
        params.clone_status,
      );
    if (params?.search?.trim()) {
      const search = params.search.trim();
      const escaped = `%${search.replace(/[\\%_]/g, "\\$&")}%`;
      add(
        (i) =>
          `(c.name ilike $${i} escape E'\\\\' or c.legal_name ilike $${i} escape E'\\\\'
          or c.billing_email ilike $${i} escape E'\\\\' or l.serial ilike $${i} escape E'\\\\'
          or l.id::text ilike $${i} or exists (select 1 from control_plane.licensing_installations si
            where si.license_id = l.id and si.id ilike $${i} escape E'\\\\')` +
          (this.normalizedDocumentHash(search)
            ? ` or c.document_hash = $${values.push(this.normalizedDocumentHash(search))}`
            : "") +
          ")",
        escaped,
      );
    }
    const where = conditions.length ? `where ${conditions.join(" and ")}` : "";
    const countResult = await this.ctx.db.query<{ total: number }>(
      `select count(*)::int as total from control_plane.licensing_licenses l
         join control_plane.licensing_customers c on c.id = l.customer_id ${where};`,
      values,
    );
    const sortColumns = {
      customer: "lower(c.name)",
      status: "l.status",
      expires_at: "l.expires_at",
      created_at: "l.created_at",
      last_validation: "last_validation_at",
    } as const;
    const sortColumn = sortColumns[params?.sort ?? "created_at"];
    const direction = params?.direction === "asc" ? "asc" : "desc";
    const pageValues = [...values, limit, offset];
    const result = await this.ctx.db.query<LicenseRecord>(
      `select l.*, c.name as customer_name, c.billing_email as customer_email,
              (select count(*)::int from control_plane.licensing_installations i where i.license_id = l.id and i.status = 'ACTIVE') as active_installations_count,
              (select max(i.last_validation_at) from control_plane.licensing_installations i where i.license_id = l.id) as last_validation_at,
              (select max(i.clone_status) from control_plane.licensing_installations i where i.license_id = l.id
                and i.clone_status in ('SUSPECTED_CLONE', 'CLONE_CONFIRMED', 'TRANSFER_PENDING')) as clone_status
         from control_plane.licensing_licenses l
         join control_plane.licensing_customers c on c.id = l.customer_id ${where}
        order by ${sortColumn} ${direction}, l.id asc
        limit $${pageValues.length - 1} offset $${pageValues.length};`,
      pageValues,
    );
    return {
      items: result.rows.map((row) => ({
        ...row,
        temporal_state: this.computeTemporalState(row.valid_from, row.expires_at, row.grace_days),
        days_remaining: Math.ceil(
          (new Date(row.expires_at).getTime() - this.now().getTime()) / 86_400_000,
        ),
      })),
      total: countResult.rows[0]?.total ?? 0,
      limit,
      offset,
    };
  }

  async listCommercialInstallations(params?: {
    search?: string;
    status?: InstallationRecord["status"];
    clone_status?: InstallationRecord["clone_status"];
    plan?: LicenseRecord["plan"];
    sort?: "customer" | "status" | "last_validation" | "created_at";
    direction?: "asc" | "desc";
    limit?: number;
    offset?: number;
  }): Promise<PageResult<InstallationRecord>> {
    const { limit, offset } = this.boundedPage(params?.limit, params?.offset);
    const values: unknown[] = [];
    const conditions: string[] = [];
    if (params?.status) {
      values.push(params.status);
      conditions.push(`i.status = $${values.length}`);
    }
    if (params?.clone_status) {
      values.push(params.clone_status);
      conditions.push(`i.clone_status = $${values.length}`);
    }
    if (params?.plan) {
      values.push(params.plan);
      conditions.push(`l.plan = $${values.length}`);
    }
    if (params?.search?.trim()) {
      values.push(`%${params.search.trim().replace(/[\\%_]/g, "\\$&")}%`);
      const ix = values.length;
      conditions.push(`(i.id ilike $${ix} escape E'\\\\' or l.serial ilike $${ix} escape E'\\\\'
        or c.name ilike $${ix} escape E'\\\\' or l.id::text ilike $${ix})`);
    }
    const where = conditions.length ? `where ${conditions.join(" and ")}` : "";
    const count = await this.ctx.db.query<{ total: number }>(
      `select count(*)::int as total from control_plane.licensing_installations i
        join control_plane.licensing_licenses l on l.id = i.license_id
        join control_plane.licensing_customers c on c.id = l.customer_id ${where};`,
      values,
    );
    const sortColumns = {
      customer: "lower(c.name)",
      status: "i.status",
      last_validation: "i.last_validation_at",
      created_at: "i.created_at",
    } as const;
    const pageValues = [...values, limit, offset];
    const rows = await this.ctx.db.query<InstallationRecord>(
      `select i.id, i.license_id, i.public_key_fingerprint, i.status, i.environment,
              i.app_version, i.last_heartbeat_at, i.last_seen_at, i.last_validation_at,
              i.clientix_version, i.clone_status, i.clone_conflict_count, i.last_clone_conflict_at,
              i.created_at, i.updated_at, c.name as customer_name, l.license_type, l.plan, l.status as license_status,
              l.serial,
              (select s.session_id from control_plane.licensing_instance_sessions s
                where s.installation_id = i.id and s.status = 'ACTIVE'
                order by s.last_heartbeat_at desc limit 1) as active_session_id
         from control_plane.licensing_installations i
         join control_plane.licensing_licenses l on l.id = i.license_id
         join control_plane.licensing_customers c on c.id = l.customer_id ${where}
        order by ${sortColumns[params?.sort ?? "created_at"]} ${params?.direction === "asc" ? "asc" : "desc"}, i.id asc
        limit $${pageValues.length - 1} offset $${pageValues.length};`,
      pageValues,
    );
    return { items: rows.rows, total: count.rows[0]?.total ?? 0, limit, offset };
  }

  // =========================================================================
  // 1. CUSTOMERS
  // =========================================================================

  async listCustomers(params?: {
    search?: string;
    limit?: number;
    offset?: number;
  }): Promise<CustomerRecord[]> {
    const limit = params?.limit ?? 50;
    const offset = params?.offset ?? 0;
    const search = params?.search?.trim();

    if (search) {
      const q = `%${search}%`;
      const res = await this.ctx.db.query<CustomerRecord>(
        `select id, name, legal_name, billing_email, phone, internal_notes, country, status, created_at, updated_at
         from control_plane.licensing_customers
         where name ilike $1 or billing_email ilike $1 or coalesce(legal_name, '') ilike $1
         order by created_at desc
         limit $2 offset $3;`,
        [q, limit, offset],
      );
      return res.rows;
    }

    const res = await this.ctx.db.query<CustomerRecord>(
      `select id, name, legal_name, billing_email, phone, internal_notes, country, status, created_at, updated_at
       from control_plane.licensing_customers
       order by created_at desc
       limit $1 offset $2;`,
      [limit, offset],
    );
    return res.rows;
  }

  async getCustomer(
    id: string,
  ): Promise<{ customer: CustomerRecord; licenses: LicenseRecord[] } | null> {
    const res = await this.ctx.db.query<CustomerRecord>(
      `select id, name, legal_name, billing_email, phone, internal_notes, country, status, created_at, updated_at
       from control_plane.licensing_customers
       where id = $1;`,
      [id],
    );

    if (res.rows.length === 0) return null;
    const customer = res.rows[0]!;

    const licRes = await this.ctx.db.query<LicenseRecord>(
      `select l.*,
              (select count(*)::int from control_plane.licensing_installations i where i.license_id = l.id and i.status = 'ACTIVE') as active_installations_count
       from control_plane.licensing_licenses l
       where l.customer_id = $1
       order by l.created_at desc;`,
      [id],
    );

    const licenses = licRes.rows.map((l) => ({
      ...l,
      temporal_state: this.computeTemporalState(l.valid_from, l.expires_at, l.grace_days),
    }));

    return { customer, licenses };
  }

  async createCustomer(
    input: CreateCustomerInput,
    actor: string,
    requestId?: string,
  ): Promise<CustomerRecord> {
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

    const normalizedDocument = input.document?.replace(/[^\p{L}\p{N}]/gu, "").toUpperCase() ?? "";
    if (normalizedDocument && (normalizedDocument.length < 8 || normalizedDocument.length > 32)) {
      throw new Error("Customer document format is invalid.");
    }
    const documentHash = normalizedDocument
      ? crypto.createHmac("sha256", this.ctx.pepper).update(normalizedDocument).digest("hex")
      : null;

    const res = await this.ctx.db.query<CustomerRecord>(
      `with created as (
         insert into control_plane.licensing_customers
           (name, legal_name, document_hash, billing_email, phone, internal_notes, country, status, created_at, updated_at)
         values ($1, $2, $3, $4, $5, $6, $7, 'ACTIVE', now(), now())
         returning id, name, legal_name, billing_email, phone, internal_notes, country, status, created_at, updated_at
       ), event as (
         insert into control_plane.licensing_events (event_type, payload, actor, actor_type, actor_id, request_id, created_at)
         select 'CUSTOMER_CREATED', jsonb_build_object('customer_id', id), 'admin', 'ADMIN', $8, $9, now()
         from created
       ) select * from created;`,
      [
        input.name.trim(),
        input.legal_name?.trim() || null,
        documentHash,
        input.billing_email.trim().toLowerCase(),
        input.phone?.trim() || null,
        input.internal_notes?.trim() || null,
        country,
        actor,
        requestId ?? null,
      ],
    );

    return res.rows[0]!;
  }

  async updateCustomer(
    id: string,
    input: UpdateCustomerInput,
    actor: string,
    requestId?: string,
  ): Promise<CustomerRecord> {
    const existing = await this.getCustomer(id);
    if (!existing) throw new Error("Customer not found.");

    const email = input.billing_email
      ? input.billing_email.trim().toLowerCase()
      : existing.customer.billing_email;
    if (input.billing_email) {
      const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
      if (!emailRegex.test(email)) throw new Error("Invalid billing email format.");
    }

    const country =
      input.country !== undefined
        ? input.country
          ? input.country.trim().toUpperCase()
          : null
        : existing.customer.country;
    if (country && !/^[A-Z]{2}$/.test(country)) {
      throw new Error("Country must be a 2-letter uppercase ISO code (e.g. BR, US).");
    }

    const name = input.name !== undefined ? input.name.trim() : existing.customer.name;
    const legalName =
      input.legal_name !== undefined
        ? input.legal_name
          ? input.legal_name.trim()
          : null
        : existing.customer.legal_name;

    const normalizedDocument = input.document?.replace(/[^\p{L}\p{N}]/gu, "").toUpperCase() ?? "";
    if (
      input.document !== undefined &&
      normalizedDocument &&
      (normalizedDocument.length < 8 || normalizedDocument.length > 32)
    ) {
      throw new Error("Customer document format is invalid.");
    }
    const documentHash =
      input.document === undefined
        ? null
        : normalizedDocument
          ? crypto.createHmac("sha256", this.ctx.pepper).update(normalizedDocument).digest("hex")
          : null;
    const phone = input.phone !== undefined ? input.phone?.trim() || null : existing.customer.phone;
    const internalNotes =
      input.internal_notes !== undefined
        ? input.internal_notes?.trim() || null
        : existing.customer.internal_notes;

    const res = await this.ctx.db.query<CustomerRecord>(
      `with changed as (
         update control_plane.licensing_customers
         set name = $2,
             legal_name = $3,
             billing_email = $4,
             country = $5,
             document_hash = case when $6 then $7 else document_hash end,
             phone = $8,
             internal_notes = $9,
             updated_at = now()
         where id = $1
         returning id, name, legal_name, billing_email, phone, internal_notes, country, status, created_at, updated_at
       ), event as (
         insert into control_plane.licensing_events
           (event_type, payload, actor, actor_type, actor_id, request_id, created_at)
         select 'CUSTOMER_UPDATED',
                jsonb_build_object('customer_id', id, 'changed_fields', $10::jsonb),
                'admin', 'ADMIN', $11, $12, now()
         from changed
       ) select * from changed;`,
      [
        id,
        name,
        legalName,
        email,
        country,
        input.document !== undefined,
        documentHash,
        phone,
        internalNotes,
        JSON.stringify(Object.keys(input).sort()),
        actor,
        requestId ?? null,
      ],
    );

    const updated = res.rows[0];
    if (!updated) throw new Error("Customer not found.");
    return updated;
  }

  // =========================================================================
  // 2. LICENSES
  // =========================================================================

  async listLicenses(params?: {
    status?: LicenseRecord["status"];
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
             (select count(*)::int from control_plane.licensing_installations i where i.license_id = l.id and i.status = 'ACTIVE') as active_installations_count,
             (select max(i.last_validation_at) from control_plane.licensing_installations i where i.license_id = l.id) as last_validation_at
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
      sql += ` and (c.name ilike $${queryParams.length} or l.id::text ilike $${queryParams.length} or l.serial ilike $${queryParams.length})`;
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
    const res = await this.ctx.db.query<
      LicenseRecord & {
        cust_name: string;
        cust_legal: string | null;
        cust_email: string;
        cust_phone: string | null;
        cust_internal_notes: string | null;
        cust_country: string | null;
        cust_status: "ACTIVE" | "DISABLED";
      }
    >(
      `select l.*,
              c.name as cust_name,
              c.legal_name as cust_legal,
              c.billing_email as cust_email,
              c.phone as cust_phone,
              c.internal_notes as cust_internal_notes,
              c.country as cust_country,
              c.status as cust_status,
              (select count(*)::int from control_plane.licensing_installations i where i.license_id = l.id and i.status = 'ACTIVE') as active_installations_count,
              (select max(i.last_validation_at) from control_plane.licensing_installations i where i.license_id = l.id) as last_validation_at
       from control_plane.licensing_licenses l
       join control_plane.licensing_customers c on c.id = l.customer_id
       where l.id = $1;`,
      [id],
    );

    if (res.rows.length === 0) return null;
    const row = res.rows[0]!;

    const customer: CustomerRecord = {
      id: row.customer_id,
      name: row.cust_name,
      legal_name: row.cust_legal,
      billing_email: row.cust_email,
      phone: row.cust_phone,
      internal_notes: row.cust_internal_notes,
      country: row.cust_country,
      status: row.cust_status,
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
      `select id, license_id, public_key_fingerprint, status, environment, app_version, last_heartbeat_at, last_seen_at, last_validation_at, clientix_version, created_at, updated_at
       from control_plane.licensing_installations
       where license_id = $1
       order by created_at desc;`,
      [id],
    );

    const codesRes = await this.ctx.db.query<ActivationCodeRecord>(
      `select id, license_id, max_uses, used_count, expires_at, revoked_at, created_at
       from control_plane.licensing_activation_codes
       where license_id = $1
       order by created_at desc;`,
      [id],
    );

    const now = this.now();
    const activationCodes = codesRes.rows.map((c) => ({
      ...c,
      is_valid: c.revoked_at === null && c.used_count < c.max_uses && new Date(c.expires_at) > now,
    }));

    const eventsRes = await this.ctx.db.query<AuditEventRecord>(
      `select id, license_id, installation_id, event_type, payload, actor, actor_type, actor_id, request_id, created_at
       from control_plane.licensing_events
       where license_id = $1
       order by created_at desc
       limit 50;`,
      [id],
    );

    return {
      license,
      customer,
      installations: instRes.rows,
      activationCodes,
      events: eventsRes.rows,
    };
  }

  async listLicenseEvents(licenseId: string, limit = 100): Promise<AuditEventRecord[]> {
    const boundedLimit = Math.min(200, Math.max(1, Math.trunc(limit)));
    const result = await this.ctx.db.query<AuditEventRecord>(
      `select id, license_id, installation_id, event_type, payload, actor, actor_type, actor_id, request_id, created_at
       from control_plane.licensing_events
       where license_id = $1
       order by created_at desc, id desc
       limit $2;`,
      [licenseId, boundedLimit],
    );
    return result.rows;
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
    const offlineTolerance = input.offline_validation_tolerance_days ?? 7;
    const nextCheckHours = input.next_check_hours ?? 24;
    if (
      offlineTolerance < 0 ||
      offlineTolerance > 30 ||
      nextCheckHours < 1 ||
      nextCheckHours > 720
    ) {
      throw new Error("Invalid online validation policy.");
    }
    const status = input.status ?? "DRAFT";
    const plan = input.plan ?? "pro";

    // Resolve or validate active signing key
    let keyId = input.signing_key_id;
    if (!keyId) {
      const activeKeys = await this.ctx.db.query<{ key_id: string }>(
        `select key_id from control_plane.licensing_signer_keys where is_active = true limit 2;`,
      );
      if (activeKeys.rows.length === 0) {
        throw new Error(
          "No active signing keys configured in control_plane.licensing_signer_keys.",
        );
      }
      if (activeKeys.rows.length > 1) {
        throw new Error("Multiple active signing keys exist. Explicit signing_key_id is required.");
      }
      keyId = activeKeys.rows[0]!.key_id;
    }

    const idempotencyKey = input.idempotency_key ?? crypto.randomUUID();
    const requestId = input.request_id ?? crypto.randomUUID();
    if (idempotencyKey.length < 16 || idempotencyKey.length > 200) {
      throw new Error("A valid Idempotency-Key is required for license creation.");
    }
    const features = input.features ?? [];
    const metadata = this.sanitizePayload(input.metadata ?? {});
    const requestFingerprint = crypto
      .createHash("sha256")
      .update(
        JSON.stringify([
          input.customer_id,
          input.license_type,
          plan,
          status,
          input.max_installations,
          input.max_tenants ?? null,
          Boolean(input.resale_allowed),
          Boolean(input.white_label),
          features,
          validFrom.toISOString(),
          expiresAt.toISOString(),
          input.maintenance_until ?? null,
          graceDays,
          keyId,
          offlineTolerance,
          nextCheckHours,
          metadata,
        ]),
      )
      .digest("hex");

    for (let attempt = 0; attempt < 4; attempt += 1) {
      const serial = generateLicenseSerial(this.now());
      try {
        const res = await this.ctx.db.query<LicenseRecord>(
          `select * from control_plane.create_license_draft(
             $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11,
             $12, $13, $14, $15, $16, $17, $18::jsonb, $19, $20, $21, $22
           );`,
          [
            input.customer_id,
            serial,
            input.license_type,
            plan,
            status,
            input.max_installations,
            input.max_tenants ?? null,
            Boolean(input.resale_allowed),
            Boolean(input.white_label),
            features,
            validFrom.toISOString(),
            expiresAt.toISOString(),
            input.maintenance_until || null,
            graceDays,
            keyId,
            offlineTolerance,
            nextCheckHours,
            JSON.stringify(metadata),
            input.actor,
            requestId,
            idempotencyKey,
            requestFingerprint,
          ],
        );
        const created = res.rows[0];
        if (!created) throw new Error("License creation did not return a license.");
        return {
          ...created,
          temporal_state: this.computeTemporalState(
            created.valid_from,
            created.expires_at,
            created.grace_days,
          ),
        };
      } catch (error) {
        if ((error as { code?: string }).code !== "23505" || attempt === 3) throw error;
      }
    }
    throw new Error("Unable to allocate a unique license serial.");
  }

  async issueLicense(licenseId: string, actor: string, requestId?: string): Promise<LicenseRecord> {
    const res = await this.ctx.db.query<LicenseRecord>(
      `with changed as (
         update control_plane.licensing_licenses l
         set status = 'ACTIVE', issued_at = coalesce(issued_at, now()), updated_at = now()
         where l.id = $1 and l.status = 'DRAFT'
           and exists (select 1 from control_plane.licensing_customers c where c.id = l.customer_id and c.status = 'ACTIVE')
         returning l.*
       ), event as (
         insert into control_plane.licensing_events (license_id, event_type, payload, actor, actor_type, actor_id, request_id, created_at)
         select id, 'LICENSE_ISSUED', jsonb_build_object('serial', serial), 'admin', 'ADMIN', $2, $3, now()
         from changed
       ) select * from changed;`,
      [licenseId, actor, requestId ?? null],
    );
    if (res.rows[0]) {
      const license = res.rows[0];
      return {
        ...license,
        temporal_state: this.computeTemporalState(
          license.valid_from,
          license.expires_at,
          license.grace_days,
        ),
      };
    }
    const detail = await this.getLicenseDetail(licenseId);
    if (!detail) throw new Error("License not found.");
    if (detail.license.status === "ACTIVE") return detail.license;
    throw new Error(
      "License cannot be issued until its customer is active and the license is in DRAFT.",
    );
  }

  async renewLicense(input: RenewLicenseInput): Promise<LicenseRecord> {
    const durationMonths =
      input.new_expires_at || input.duration_days !== undefined
        ? null
        : (input.duration_months ?? 12);
    const durationDays = input.new_expires_at ? null : (input.duration_days ?? null);
    const durationChoices = [
      input.new_expires_at !== undefined,
      input.duration_days !== undefined,
      input.duration_months !== undefined,
    ].filter(Boolean).length;
    if (durationChoices > 1) {
      throw new Error("Choose exactly one renewal duration or a custom expiration date.");
    }
    if (
      durationMonths !== null &&
      (!Number.isInteger(durationMonths) || durationMonths < 1 || durationMonths > 120)
    ) {
      throw new Error("duration_months must be between 1 and 120.");
    }
    if (input.idempotency_key.length < 16 || input.idempotency_key.length > 200) {
      throw new Error("A valid Idempotency-Key is required for renewal.");
    }

    let activeKeyId = input.active_signing_key_id;
    if (!activeKeyId) {
      const activeKeys = await this.ctx.db.query<{ key_id: string }>(
        `select key_id from control_plane.licensing_signer_keys where is_active = true order by key_id limit 2;`,
      );
      if (activeKeys.rows.length !== 1)
        throw new Error("The Control Plane must have exactly one active signing key.");
      activeKeyId = activeKeys.rows[0]!.key_id;
    }

    const detail = await this.getLicenseDetail(input.license_id);
    if (!detail) throw new Error("License not found.");
    const previousExpiration = new Date(detail.license.expires_at);
    const isPastExpiration = previousExpiration <= this.now();
    if (isPastExpiration && !input.renewal_basis) {
      throw new Error("Choose whether the renewed term starts from the prior expiration or today.");
    }
    if (input.renewal_basis && !["previous_expiration", "today"].includes(input.renewal_basis)) {
      throw new Error("Invalid renewal basis.");
    }
    const newExpiresAt = input.new_expires_at ? new Date(input.new_expires_at) : null;
    if (newExpiresAt && (!Number.isFinite(newExpiresAt.getTime()) || newExpiresAt <= this.now())) {
      throw new Error("new_expires_at must be a valid future timestamp.");
    }
    const maintenance = input.new_maintenance_until ?? null;
    const requestFingerprint = crypto
      .createHash("sha256")
      .update(
        JSON.stringify([
          input.license_id,
          durationMonths,
          durationDays,
          newExpiresAt?.toISOString() ?? null,
          input.new_maintenance_until !== undefined,
          maintenance,
          activeKeyId,
          input.renewal_basis ?? null,
        ]),
      )
      .digest("hex");
    const res = await this.ctx.db.query<LicenseRecord>(
      `select * from control_plane.renew_license_with_request_id($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12);`,
      [
        input.license_id,
        durationMonths,
        durationDays,
        newExpiresAt?.toISOString() ?? null,
        maintenance,
        input.new_maintenance_until !== undefined,
        activeKeyId,
        input.actor,
        input.idempotency_key,
        requestFingerprint,
        input.request_id ?? crypto.randomUUID(),
        input.renewal_basis ?? null,
      ],
    );
    const updated = res.rows[0];
    if (!updated) throw new Error("License renewal did not return a license.");
    return {
      ...updated,
      temporal_state: this.computeTemporalState(
        updated.valid_from,
        updated.expires_at,
        updated.grace_days,
      ),
    };
  }

  async suspendLicense(
    licenseId: string,
    actor: string,
    reason: string,
    note?: string,
    requestId?: string,
  ): Promise<LicenseRecord> {
    const detail = await this.getLicenseDetail(licenseId);
    if (!detail) throw new Error("License not found.");
    if (detail.license.status === "REVOKED") throw new Error("Cannot suspend a REVOKED license.");
    if (detail.license.status === "SUSPENDED") return detail.license;
    if (detail.license.status === "DRAFT") throw new Error("A draft license cannot be suspended.");
    const normalizedReason = reason.trim().slice(0, 500);
    if (!normalizedReason) throw new Error("A suspension reason is required.");

    const res = await this.ctx.db.query<LicenseRecord>(
      `with prior as (
         select status from control_plane.licensing_licenses where id = $1 for update
       ), changed as (
         update control_plane.licensing_licenses l
         set status = 'SUSPENDED', updated_at = now()
         where l.id = $1 and (select status from prior) in ('ACTIVE', 'EXPIRED')
         returning l.*
       ), event as (
         insert into control_plane.licensing_events (license_id, event_type, payload, actor, actor_type, actor_id, request_id, created_at)
         select id, 'LICENSE_SUSPENDED', jsonb_build_object('previous_status', (select status from prior), 'reason', $2::text, 'note', $3::text), 'admin', 'ADMIN', $4, $5, now()
         from changed
       ) select * from changed;`,
      [licenseId, normalizedReason, note?.trim().slice(0, 1000) ?? null, actor, requestId ?? null],
    );
    const updated = res.rows[0] ?? (await this.getLicenseDetail(licenseId))?.license;
    if (!updated) throw new Error("License not found.");

    return {
      ...updated,
      temporal_state: this.computeTemporalState(
        updated.valid_from,
        updated.expires_at,
        updated.grace_days,
      ),
    };
  }

  async reactivateLicense(
    licenseId: string,
    actor: string,
    requestId?: string,
  ): Promise<LicenseRecord> {
    const detail = await this.getLicenseDetail(licenseId);
    if (!detail) throw new Error("License not found.");
    if (detail.license.status === "REVOKED")
      throw new Error("Cannot reactivate a REVOKED license. Revocation is permanent.");
    if (detail.license.status === "ACTIVE") return detail.license;
    if (detail.license.status !== "SUSPENDED")
      throw new Error("Only a SUSPENDED license can be reactivated.");

    const res = await this.ctx.db.query<LicenseRecord>(
      `with changed as (
         update control_plane.licensing_licenses
         set status = 'ACTIVE', updated_at = now()
         where id = $1 and status = 'SUSPENDED'
         returning *
       ), event as (
         insert into control_plane.licensing_events (license_id, event_type, payload, actor, actor_type, actor_id, request_id, created_at)
         select id, 'LICENSE_REACTIVATED', jsonb_build_object('previous_status', 'SUSPENDED'), 'admin', 'ADMIN', $2, $3, now()
         from changed
       ) select * from changed;`,
      [licenseId, actor, requestId ?? null],
    );
    const updated = res.rows[0] ?? (await this.getLicenseDetail(licenseId))?.license;
    if (!updated) throw new Error("License not found.");

    return {
      ...updated,
      temporal_state: this.computeTemporalState(
        updated.valid_from,
        updated.expires_at,
        updated.grace_days,
      ),
    };
  }

  async revokeLicense(
    licenseId: string,
    actor: string,
    reason: string,
    requestId?: string,
  ): Promise<LicenseRecord> {
    const detail = await this.getLicenseDetail(licenseId);
    if (!detail) throw new Error("License not found.");
    const normalizedReason = reason.trim().slice(0, 500);
    if (!normalizedReason) throw new Error("A revocation reason is required.");
    if (detail.license.status === "REVOKED") return detail.license;

    const res = await this.ctx.db.query<LicenseRecord>(
      `with changed as (
         update control_plane.licensing_licenses
         set status = 'REVOKED', revoked_at = now(), revocation_reason = $2, updated_at = now()
         where id = $1 and status <> 'REVOKED'
         returning *
       ), event as (
         insert into control_plane.licensing_events (license_id, event_type, payload, actor, actor_type, actor_id, request_id, created_at)
         select id, 'LICENSE_REVOKED', jsonb_build_object('reason', $2::text, 'previous_status', $3::text), 'admin', 'ADMIN', $4, $5, now()
         from changed
       ) select * from changed;`,
      [licenseId, normalizedReason, detail.license.status, actor, requestId ?? null],
    );
    const updated = res.rows[0] ?? (await this.getLicenseDetail(licenseId))?.license;
    if (!updated) throw new Error("License not found.");

    return {
      ...updated,
      temporal_state: this.computeTemporalState(
        updated.valid_from,
        updated.expires_at,
        updated.grace_days,
      ),
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
    if (detail.license.status !== "ACTIVE")
      throw new Error("Activation codes require an ACTIVE issued license.");

    const maxUses = input.max_uses ?? 1;
    if (maxUses <= 0) throw new Error("max_uses must be greater than 0.");

    const exp = new Date(input.expires_at);
    if (isNaN(exp.getTime()) || exp <= this.now()) {
      throw new Error("expires_at must be a valid future date.");
    }

    // Generate 32 cryptographically secure random bytes
    const randomBytes = crypto.randomBytes(32);
    const b64url = randomBytes
      .toString("base64")
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=+$/, "");
    const rawActivationCode = `ACT_${b64url}`;

    // Compute HMAC-SHA256 with pepper
    const codeHash = deriveActivationCodeDigest(rawActivationCode, this.ctx.pepper);

    const res = await this.ctx.db.query<ActivationCodeRecord>(
      `insert into control_plane.licensing_activation_codes
       (license_id, code_hash, max_uses, used_count, expires_at, created_at)
       values ($1, $2, $3, 0, $4, now())
       returning id, license_id, max_uses, used_count, expires_at, revoked_at, created_at;`,
      [input.license_id, codeHash, maxUses, exp.toISOString()],
    );

    const code = res.rows[0]!;

    await this.recordAdminEvent({
      licenseId: input.license_id,
      eventType: "ACTIVATION_CODE_CREATED",
      actor: input.actor,
      requestId: input.request_id,
      payload: { code_id: code.id, max_uses: maxUses, expires_at: code.expires_at },
    });

    return {
      raw_activation_code: rawActivationCode,
      code: { ...code, is_valid: true },
    };
  }

  async transferInstallation(input: TransferLicenseInput): Promise<{
    license_id: string;
    from_installation_id: string;
    to_installation_id: string;
  }> {
    if (
      !isValidCanonicalInstallationId(input.from_installation_id) ||
      !isValidCanonicalInstallationId(input.to_installation_id)
    ) {
      throw new Error("Installation identifiers are invalid.");
    }
    if (!isValidInstallationPublicKey(input.to_public_key))
      throw new Error("Target installation key is invalid.");
    const reason = input.reason.trim().slice(0, 500);
    if (!reason) throw new Error("A transfer reason is required.");
    const fingerprint = computePublicKeyFingerprint(input.to_public_key);
    const result = await this.ctx.db.query<{
      license_id: string;
      from_installation_id: string;
      to_installation_id: string;
    }>(
      `select * from control_plane.transfer_license_installation_with_request_id($1, $2, $3, $4, $5, $6, $7, $8, $9);`,
      [
        input.license_id,
        input.from_installation_id,
        input.to_installation_id,
        input.to_public_key,
        fingerprint,
        input.clientix_version?.slice(0, 80) ?? null,
        reason,
        input.actor,
        input.request_id ?? crypto.randomUUID(),
      ],
    );
    const transfer = result.rows[0];
    if (!transfer) throw new Error("Installation transfer did not return a result.");
    return transfer;
  }

  async revokeActivationCode(
    codeId: string,
    actor: string,
    requestId?: string,
  ): Promise<ActivationCodeRecord> {
    const res = await this.ctx.db.query<ActivationCodeRecord>(
      `update control_plane.licensing_activation_codes
       set revoked_at = now()
       where id = $1
       returning id, license_id, max_uses, used_count, expires_at, revoked_at, created_at;`,
      [codeId],
    );

    if (res.rows.length === 0) throw new Error("Activation code not found.");
    const code = res.rows[0]!;

    await this.recordAdminEvent({
      licenseId: code.license_id,
      eventType: "ACTIVATION_CODE_REVOKED",
      actor,
      requestId,
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
      [licenseId],
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
    sessions: InstanceSessionRecord[];
  } | null> {
    const res = await this.ctx.db.query<
      InstallationRecord & {
        public_key: string;
        cust_id: string;
        cust_name: string;
        cust_legal: string | null;
        cust_email: string;
        cust_phone: string | null;
        cust_internal_notes: string | null;
        cust_country: string | null;
        lic_type: LicenseType;
        lic_status: LicenseRecord["status"];
        cust_status: CustomerRecord["status"];
        serial: string;
        product: "clientix";
        deployment: "self-hosted";
        plan: LicenseRecord["plan"];
        signing_key_id: string;
        issued_at: string | null;
        valid_from: string;
        expires_at: string;
        maintenance_until: string | null;
        grace_days: number;
        max_installations: number;
        max_tenants: number | null;
        resale_allowed: boolean;
        white_label: boolean;
        features: string[];
        revoked_at: string | null;
        revocation_reason: string | null;
        offline_validation_tolerance_days: number;
        next_check_hours: number;
        metadata: Record<string, unknown>;
      }
    >(
      `select i.*,
              l.customer_id as cust_id,
              c.name as cust_name,
              c.legal_name as cust_legal,
              c.billing_email as cust_email,
              c.phone as cust_phone,
              c.internal_notes as cust_internal_notes,
              c.country as cust_country,
              c.status as cust_status,
              l.license_type as lic_type,
              l.status as lic_status,
              l.serial,
              l.product,
              l.deployment,
              l.plan,
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
              l.features,
              l.revoked_at,
              l.revocation_reason,
              l.offline_validation_tolerance_days,
              l.next_check_hours,
              l.metadata
       from control_plane.licensing_installations i
       join control_plane.licensing_licenses l on l.id = i.license_id
       join control_plane.licensing_customers c on c.id = l.customer_id
       where i.id = $1;`,
      [id],
    );

    if (res.rows.length === 0) return null;
    const row = res.rows[0]!;

    const customer: CustomerRecord = {
      id: row.cust_id,
      name: row.cust_name,
      legal_name: row.cust_legal,
      billing_email: row.cust_email,
      phone: row.cust_phone,
      internal_notes: row.cust_internal_notes,
      country: row.cust_country,
      status: row.cust_status,
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
      serial: row.serial,
      product: row.product,
      deployment: row.deployment,
      plan: row.plan,
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
      revoked_at: row.revoked_at,
      revocation_reason: row.revocation_reason,
      offline_validation_tolerance_days: row.offline_validation_tolerance_days,
      next_check_hours: row.next_check_hours,
      metadata: row.metadata,
      created_at: row.created_at,
      updated_at: row.updated_at,
      temporal_state: this.computeTemporalState(row.valid_from, row.expires_at, row.grace_days),
    };

    const eventsRes = await this.ctx.db.query<AuditEventRecord>(
      `select id, license_id, installation_id, event_type, payload, actor, actor_type, actor_id, request_id, created_at
       from control_plane.licensing_events
       where installation_id = $1
       order by created_at desc
       limit 50;`,
      [id],
    );
    const sessionsRes = await this.ctx.db.query<InstanceSessionRecord>(
      `select session_id, status, boot_started_at, started_at, last_heartbeat_at, ended_at, clientix_version,
              (status = 'ACTIVE' and last_heartbeat_at >= now() - interval '15 minutes') as heartbeat_fresh
         from control_plane.licensing_instance_sessions
        where installation_id = $1 order by last_heartbeat_at desc limit 25;`,
      [id],
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
        clone_status: row.clone_status ?? "NORMAL",
        clone_conflict_count: row.clone_conflict_count ?? 0,
        last_clone_conflict_at: row.last_clone_conflict_at ?? null,
        created_at: row.created_at,
        updated_at: row.updated_at,
      },
      license,
      customer,
      events: eventsRes.rows,
      sessions: sessionsRes.rows,
    };
  }

  async authorizeInstallationRecovery(input: {
    installation_id: string;
    reason: string;
    actor: string;
    request_id?: string;
  }): Promise<{ recovery_code: string; expires_at: string }> {
    const recoveryCode = `REC_${crypto.randomBytes(32).toString("base64url")}`;
    const digest = crypto
      .createHmac("sha256", this.ctx.pepper)
      .update(`installation-recovery:${recoveryCode}`, "utf8")
      .digest("hex");
    const expiresAt = new Date(this.now().getTime() + 24 * 60 * 60 * 1000).toISOString();
    const result = await this.ctx.db.query<{ recovery_expires_at: string }>(
      `select recovery_expires_at
         from control_plane.authorize_installation_recovery_with_request_id($1, $2, $3, $4, $5, $6);`,
      [
        input.installation_id,
        digest,
        input.reason.trim(),
        input.actor,
        expiresAt,
        input.request_id ?? crypto.randomUUID(),
      ],
    );
    const row = result.rows[0];
    if (!row) throw new Error("Installation recovery could not be authorized.");
    return { recovery_code: recoveryCode, expires_at: row.recovery_expires_at };
  }

  async endInstallationSession(
    installationId: string,
    sessionId: string,
    actor: string,
    requestId?: string,
  ): Promise<boolean> {
    const result = await this.ctx.db.query<{ license_id: string }>(
      `update control_plane.licensing_instance_sessions
          set status = 'ENDED', ended_at = now(), updated_at = now()
        where installation_id = $1 and session_id = $2 and status = 'ACTIVE'
        returning license_id;`,
      [installationId, sessionId],
    );
    const row = result.rows[0];
    if (!row) return false;
    await this.recordAdminEvent({
      licenseId: row.license_id,
      installationId,
      eventType: "INSTANCE_SESSION_ENDED",
      actor,
      requestId,
      payload: { session_id: sessionId, reason: "vendor_admin_action" },
    });
    return true;
  }

  async suspendInstallation(
    installationId: string,
    actor: string,
    requestId?: string,
  ): Promise<InstallationRecord> {
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
      [installationId],
    );

    const updated = res.rows[0]!;
    await this.recordAdminEvent({
      licenseId: updated.license_id,
      installationId,
      eventType: "INSTALLATION_SUSPENDED",
      actor,
      requestId,
      payload: { previous_status: detail.installation.status },
    });

    return updated;
  }

  async reactivateInstallation(
    installationId: string,
    actor: string,
    requestId?: string,
  ): Promise<InstallationRecord> {
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
      [installationId],
    );

    const updated = res.rows[0]!;
    await this.recordAdminEvent({
      licenseId: updated.license_id,
      installationId,
      eventType: "INSTALLATION_REACTIVATED",
      actor,
      requestId,
      payload: { previous_status: detail.installation.status },
    });

    return updated;
  }

  async revokeInstallation(
    installationId: string,
    actor: string,
    requestId?: string,
  ): Promise<InstallationRecord> {
    const detail = await this.getInstallationDetail(installationId);
    if (!detail) throw new Error("Installation not found.");

    const res = await this.ctx.db.query<InstallationRecord>(
      `update control_plane.licensing_installations
       set status = 'REVOKED', updated_at = now()
       where id = $1
       returning id, license_id, public_key_fingerprint, status, environment, app_version, last_heartbeat_at, created_at, updated_at;`,
      [installationId],
    );

    const updated = res.rows[0]!;
    await this.recordAdminEvent({
      licenseId: updated.license_id,
      installationId,
      eventType: "INSTALLATION_REVOKED",
      actor,
      requestId,
      payload: { previous_status: detail.installation.status },
    });

    return updated;
  }

  async forceDeactivateInstallation(
    installationId: string,
    actor: string,
    requestId?: string,
  ): Promise<InstallationRecord> {
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
      [installationId],
    );

    const updated = res.rows[0]!;
    await this.recordAdminEvent({
      licenseId: updated.license_id,
      installationId,
      eventType: "ADMIN_FORCE_DEACTIVATED",
      actor,
      requestId,
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
      select id, license_id, installation_id, event_type, payload, actor, actor_type, actor_id, created_at
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
