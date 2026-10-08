import { describe, it, expect, beforeEach } from "vitest";
import crypto from "crypto";
import {
  ControlPlaneAdminService,
  type CustomerRecord,
  type LicenseRecord,
  type ActivationCodeRecord,
  type InstallationRecord,
  type AuditEventRecord,
} from "../src/admin-service";
import type { DatabaseClient } from "../scripts/migrator";
import { deriveActivationCodeDigest } from "@/lib/licensing/installation-auth";

class MockAdminDatabaseClient implements DatabaseClient {
  public customers = new Map<string, CustomerRecord>();
  public licenses = new Map<string, LicenseRecord>();
  public activationCodes = new Map<string, ActivationCodeRecord & { code_hash: string }>();
  public installations = new Map<string, InstallationRecord & { public_key: string }>();
  public events: AuditEventRecord[] = [];
  public signingKeys = [{ key_id: "vendor_key_v1", is_active: true }];

  async query<R = Record<string, unknown>>(
    sql: string,
    params: unknown[] = []
  ): Promise<{ rows: R[]; rowCount?: number }> {
    const trimmed = sql.trim();

    // 1. Customers
    if (trimmed.startsWith("insert into control_plane.licensing_customers")) {
      const id = crypto.randomUUID();
      const customer: CustomerRecord = {
        id,
        name: params[0] as string,
        legal_name: (params[1] as string) || null,
        billing_email: params[2] as string,
        country: (params[3] as string) || null,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      };
      this.customers.set(id, customer);
      return { rows: [customer as unknown as R], rowCount: 1 };
    }

    if (trimmed.includes("from control_plane.licensing_customers where id = $1")) {
      const id = params[0] as string;
      const c = this.customers.get(id);
      return { rows: c ? ([c as unknown as R]) : [] };
    }

    if (trimmed.includes("from control_plane.licensing_customers")) {
      const all = Array.from(this.customers.values());
      const search = params[0] as string | undefined;
      let filtered = all;
      if (search && search.startsWith("%")) {
        const q = search.replace(/%/g, "").toLowerCase();
        filtered = all.filter(
          (c) =>
            c.name.toLowerCase().includes(q) ||
            c.billing_email.toLowerCase().includes(q) ||
            (c.legal_name && c.legal_name.toLowerCase().includes(q))
        );
      }
      return { rows: filtered as unknown as R[] };
    }

    if (trimmed.startsWith("update control_plane.licensing_customers")) {
      const id = params[0] as string;
      const existing = this.customers.get(id);
      if (!existing) return { rows: [], rowCount: 0 };
      const updated: CustomerRecord = {
        ...existing,
        name: params[1] as string,
        legal_name: (params[2] as string) || null,
        billing_email: params[3] as string,
        country: (params[4] as string) || null,
        updated_at: new Date().toISOString(),
      };
      this.customers.set(id, updated);
      return { rows: [updated as unknown as R], rowCount: 1 };
    }

    // 2. Signer keys
    if (trimmed.includes("from control_plane.licensing_signer_keys")) {
      return { rows: this.signingKeys as unknown as R[] };
    }

    // 3. Licenses
    if (trimmed.startsWith("insert into control_plane.licensing_licenses")) {
      const id = crypto.randomUUID();
      const lic: LicenseRecord = {
        id,
        customer_id: params[0] as string,
        license_type: params[1] as LicenseRecord["license_type"],
        status: "ACTIVE",
        signing_key_id: params[2] as string,
        issued_at: new Date().toISOString(),
        valid_from: params[3] as string,
        expires_at: params[4] as string,
        maintenance_until: (params[5] as string) || null,
        grace_days: params[6] as number,
        max_installations: params[7] as number,
        max_tenants: (params[8] as number) ?? null,
        resale_allowed: Boolean(params[9]),
        white_label: Boolean(params[10]),
        features: (params[11] as string[]) || [],
        metadata: JSON.parse((params[12] as string) || "{}"),
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      };
      this.licenses.set(id, lic);
      return { rows: [lic as unknown as R], rowCount: 1 };
    }

    if (trimmed.includes("from control_plane.licensing_licenses l") && trimmed.includes("where l.id = $1")) {
      const id = params[0] as string;
      const lic = this.licenses.get(id);
      if (!lic) return { rows: [] };
      const cust = this.customers.get(lic.customer_id);
      const combined = {
        ...lic,
        cust_name: cust?.name || "",
        cust_legal: cust?.legal_name || null,
        cust_email: cust?.billing_email || "",
        cust_country: cust?.country || null,
        active_installations_count: 0,
      };
      return { rows: [combined as unknown as R] };
    }

    if (trimmed.includes("from control_plane.licensing_licenses l where l.customer_id = $1")) {
      const custId = params[0] as string;
      const lics = Array.from(this.licenses.values()).filter((l) => l.customer_id === custId);
      return { rows: lics as unknown as R[] };
    }

    if (trimmed.includes("from control_plane.licensing_licenses l")) {
      const all = Array.from(this.licenses.values()).map((l) => {
        const cust = this.customers.get(l.customer_id);
        return {
          ...l,
          customer_name: cust?.name || "",
          customer_email: cust?.billing_email || "",
          active_installations_count: 0,
        };
      });
      return { rows: all as unknown as R[] };
    }

    if (trimmed.startsWith("update control_plane.licensing_licenses")) {
      const id = params[0] as string;
      const existing = this.licenses.get(id);
      if (!existing) return { rows: [], rowCount: 0 };

      const updated = { ...existing, updated_at: new Date().toISOString() };
      if (trimmed.includes("set expires_at = $2")) {
        updated.expires_at = params[1] as string;
        updated.maintenance_until = (params[2] as string) || null;
      } else if (trimmed.includes("set status = 'SUSPENDED'")) {
        updated.status = "SUSPENDED";
      } else if (trimmed.includes("set status = 'ACTIVE'")) {
        updated.status = "ACTIVE";
      } else if (trimmed.includes("set status = 'REVOKED'")) {
        updated.status = "REVOKED";
      }

      this.licenses.set(id, updated);
      return { rows: [updated as unknown as R], rowCount: 1 };
    }

    // 4. Activation codes
    if (trimmed.startsWith("insert into control_plane.licensing_activation_codes")) {
      const id = crypto.randomUUID();
      const code = {
        id,
        license_id: params[0] as string,
        code_hash: params[1] as string,
        max_uses: params[2] as number,
        used_count: 0,
        expires_at: params[3] as string,
        revoked_at: null,
        created_at: new Date().toISOString(),
        is_valid: true,
      };
      this.activationCodes.set(id, code);
      return { rows: [code as unknown as R], rowCount: 1 };
    }

    if (trimmed.includes("from control_plane.licensing_activation_codes") && trimmed.includes("license_id = $1")) {
      const licId = params[0] as string;
      const codes = Array.from(this.activationCodes.values())
        .filter((c) => c.license_id === licId)
        .map(({ code_hash: _hash, ...rest }) => rest);
      return { rows: codes as unknown as R[] };
    }

    if (trimmed.startsWith("update control_plane.licensing_activation_codes")) {
      const id = params[0] as string;
      const code = this.activationCodes.get(id);
      if (!code) return { rows: [], rowCount: 0 };
      const updated = { ...code, revoked_at: new Date().toISOString(), is_valid: false };
      this.activationCodes.set(id, updated);
      return { rows: [updated as unknown as R], rowCount: 1 };
    }

    // 5. Installations
    if (trimmed.includes("from control_plane.licensing_installations i") && trimmed.includes("where i.id = $1")) {
      const id = params[0] as string;
      const inst = this.installations.get(id);
      if (!inst) return { rows: [] };
      const lic = this.licenses.get(inst.license_id);
      const cust = lic ? this.customers.get(lic.customer_id) : undefined;
      const combined = {
        ...inst,
        cust_id: cust?.id || "",
        cust_name: cust?.name || "",
        cust_legal: cust?.legal_name || null,
        cust_email: cust?.billing_email || "",
        cust_country: cust?.country || null,
        lic_type: lic?.license_type || "enterprise",
        lic_status: lic?.status || "ACTIVE",
        signing_key_id: lic?.signing_key_id || "vendor_key_v1",
        issued_at: lic?.issued_at || new Date().toISOString(),
        valid_from: lic?.valid_from || new Date().toISOString(),
        expires_at: lic?.expires_at || new Date().toISOString(),
        maintenance_until: lic?.maintenance_until || null,
        grace_days: lic?.grace_days ?? 7,
        max_installations: lic?.max_installations ?? 1,
        max_tenants: lic?.max_tenants ?? null,
        resale_allowed: lic?.resale_allowed ?? false,
        white_label: lic?.white_label ?? false,
        features: lic?.features ?? [],
      };
      return { rows: [combined as unknown as R] };
    }

    if (trimmed.includes("from control_plane.licensing_installations where license_id = $1")) {
      const licId = params[0] as string;
      const insts = Array.from(this.installations.values()).filter((i) => i.license_id === licId);
      return { rows: insts as unknown as R[] };
    }

    if (trimmed.includes("from control_plane.licensing_installations i")) {
      const all = Array.from(this.installations.values()).map((i) => {
        const lic = this.licenses.get(i.license_id);
        const cust = lic ? this.customers.get(lic.customer_id) : undefined;
        return {
          ...i,
          customer_name: cust?.name || "",
          license_type: lic?.license_type || "enterprise",
          license_status: lic?.status || "ACTIVE",
        };
      });
      return { rows: all as unknown as R[] };
    }

    if (trimmed.startsWith("update control_plane.licensing_installations")) {
      const id = params[0] as string;
      const inst = this.installations.get(id);
      if (!inst) return { rows: [], rowCount: 0 };
      let newStatus = inst.status;
      if (trimmed.includes("set status = 'SUSPENDED'")) newStatus = "SUSPENDED";
      if (trimmed.includes("set status = 'ACTIVE'")) newStatus = "ACTIVE";
      if (trimmed.includes("set status = 'REVOKED'")) newStatus = "REVOKED";
      if (trimmed.includes("set status = 'DEACTIVATED'")) newStatus = "DEACTIVATED";

      const updated = {
        ...inst,
        status: newStatus as InstallationRecord["status"],
        updated_at: new Date().toISOString(),
      };
      this.installations.set(id, updated);
      return { rows: [updated as unknown as R], rowCount: 1 };
    }

    // 6. Events / Audit
    if (trimmed.startsWith("insert into control_plane.licensing_events")) {
      const evt: AuditEventRecord = {
        id: crypto.randomUUID(),
        license_id: (params[0] as string) || null,
        installation_id: (params[1] as string) || null,
        event_type: params[2] as string,
        payload: JSON.parse((params[3] as string) || "{}"),
        actor: params[4] as string,
        created_at: new Date().toISOString(),
      };
      this.events.push(evt);
      return { rows: [evt as unknown as R], rowCount: 1 };
    }

    if (trimmed.includes("from control_plane.licensing_events")) {
      return { rows: [...this.events].reverse() as unknown as R[] };
    }

    return { rows: [] };
  }
}

describe("ControlPlaneAdminService", () => {
  let db: MockAdminDatabaseClient;
  let service: ControlPlaneAdminService;
  const pepper = "test_admin_control_plane_pepper_32_characters_long";

  beforeEach(() => {
    db = new MockAdminDatabaseClient();
    service = new ControlPlaneAdminService({
      db,
      pepper,
      clockNow: () => new Date("2026-10-08T12:00:00.000Z"),
    });
  });

  describe("Customer Management", () => {
    it("creates a customer with valid data and records admin event", async () => {
      const cust = await service.createCustomer(
        {
          name: "Acme Corp",
          legal_name: "Acme Corporation Inc.",
          billing_email: "billing@acme.com",
          country: "US",
        },
        "admin@clientix.com"
      );

      expect(cust.id).toBeDefined();
      expect(cust.name).toBe("Acme Corp");
      expect(cust.billing_email).toBe("billing@acme.com");
      expect(cust.country).toBe("US");

      expect(db.events).toHaveLength(1);
      expect(db.events[0]?.event_type).toBe("CUSTOMER_CREATED");
      expect(db.events[0]?.actor).toBe("admin@clientix.com");
    });

    it("rejects invalid billing email", async () => {
      await expect(
        service.createCustomer({ name: "Bad", billing_email: "invalid-email" }, "admin@clientix.com")
      ).rejects.toThrow("Invalid billing email format.");
    });

    it("rejects invalid country code format", async () => {
      await expect(
        service.createCustomer(
          { name: "Bad", billing_email: "ok@test.com", country: "BRAZIL" },
          "admin@clientix.com"
        )
      ).rejects.toThrow("Country must be a 2-letter uppercase ISO code");
    });

    it("updates customer fields and logs audit event", async () => {
      const cust = await service.createCustomer(
        { name: "Initial", billing_email: "init@test.com" },
        "admin@clientix.com"
      );

      const updated = await service.updateCustomer(
        cust.id,
        { name: "Updated Name", country: "BR" },
        "admin@clientix.com"
      );

      expect(updated.name).toBe("Updated Name");
      expect(updated.country).toBe("BR");
      expect(db.events).toHaveLength(2);
      expect(db.events[1]?.event_type).toBe("CUSTOMER_UPDATED");
    });
  });

  describe("License Management & Lifecycle", () => {
    let customerId: string;

    beforeEach(async () => {
      const c = await service.createCustomer(
        { name: "Test Cust", billing_email: "cust@test.com" },
        "admin@clientix.com"
      );
      customerId = c.id;
    });

    it("creates license with validation and sets temporal_state", async () => {
      const lic = await service.createLicense({
        customer_id: customerId,
        license_type: "enterprise",
        max_installations: 5,
        valid_from: "2026-10-01T00:00:00.000Z",
        expires_at: "2027-10-01T00:00:00.000Z",
        grace_days: 14,
        features: ["ai_agent", "whitelabel"],
        actor: "admin@clientix.com",
      });

      expect(lic.id).toBeDefined();
      expect(lic.status).toBe("ACTIVE");
      expect(lic.temporal_state).toBe("VALID");
      expect(lic.max_installations).toBe(5);

      expect(db.events.some((e) => e.event_type === "LICENSE_CREATED")).toBe(true);
    });

    it("rejects valid_from >= expires_at", async () => {
      await expect(
        service.createLicense({
          customer_id: customerId,
          license_type: "enterprise",
          max_installations: 1,
          valid_from: "2027-01-01T00:00:00.000Z",
          expires_at: "2026-01-01T00:00:00.000Z",
          actor: "admin@clientix.com",
        })
      ).rejects.toThrow("valid_from must precede expires_at.");
    });

    it("rejects max_installations <= 0", async () => {
      await expect(
        service.createLicense({
          customer_id: customerId,
          license_type: "enterprise",
          max_installations: 0,
          expires_at: "2027-01-01T00:00:00.000Z",
          actor: "admin@clientix.com",
        })
      ).rejects.toThrow("max_installations must be greater than 0.");
    });

    it("suspends, reactivates, and revokes license with proper state transitions", async () => {
      const lic = await service.createLicense({
        customer_id: customerId,
        license_type: "partner",
        max_installations: 2,
        expires_at: "2027-01-01T00:00:00.000Z",
        actor: "admin@clientix.com",
      });

      // Suspend
      const suspended = await service.suspendLicense(lic.id, "admin@clientix.com");
      expect(suspended.status).toBe("SUSPENDED");

      // Reactivate
      const reactivated = await service.reactivateLicense(lic.id, "admin@clientix.com");
      expect(reactivated.status).toBe("ACTIVE");

      // Revoke
      const revoked = await service.revokeLicense(lic.id, "admin@clientix.com");
      expect(revoked.status).toBe("REVOKED");

      // Cannot reactivate or suspend a revoked license
      await expect(service.reactivateLicense(lic.id, "admin@clientix.com")).rejects.toThrow(
        "Cannot reactivate a REVOKED license."
      );
      await expect(service.suspendLicense(lic.id, "admin@clientix.com")).rejects.toThrow(
        "Cannot suspend a REVOKED license."
      );
    });

    it("ACTIVE + renew: preserves ACTIVE status and extends expiration", async () => {
      const lic = await service.createLicense({
        customer_id: customerId,
        license_type: "enterprise",
        max_installations: 1,
        valid_from: "2025-01-01T00:00:00.000Z",
        expires_at: "2026-01-01T00:00:00.000Z",
        actor: "admin@clientix.com",
      });

      const renewed = await service.renewLicense({
        license_id: lic.id,
        new_expires_at: "2028-01-01T00:00:00.000Z",
        actor: "admin@clientix.com",
      });

      expect(renewed.status).toBe("ACTIVE");
      expect(renewed.expires_at).toBe("2028-01-01T00:00:00.000Z");
      expect(renewed.temporal_state).toBe("VALID");
    });

    it("SUSPENDED + renew: preserves SUSPENDED status (Policy A - admin date update without implicit reactivation)", async () => {
      const lic = await service.createLicense({
        customer_id: customerId,
        license_type: "enterprise",
        max_installations: 1,
        valid_from: "2025-01-01T00:00:00.000Z",
        expires_at: "2026-01-01T00:00:00.000Z",
        actor: "admin@clientix.com",
      });

      await service.suspendLicense(lic.id, "admin@clientix.com");

      const renewed = await service.renewLicense({
        license_id: lic.id,
        new_expires_at: "2028-01-01T00:00:00.000Z",
        actor: "admin@clientix.com",
      });

      expect(renewed.status).toBe("SUSPENDED");
      expect(renewed.expires_at).toBe("2028-01-01T00:00:00.000Z");
    });

    it("REVOKED + renew: strictly DENIED", async () => {
      const lic = await service.createLicense({
        customer_id: customerId,
        license_type: "enterprise",
        max_installations: 1,
        expires_at: "2027-01-01T00:00:00.000Z",
        actor: "admin@clientix.com",
      });

      await service.revokeLicense(lic.id, "admin@clientix.com");

      await expect(
        service.renewLicense({
          license_id: lic.id,
          new_expires_at: "2028-01-01T00:00:00.000Z",
          actor: "admin@clientix.com",
        })
      ).rejects.toThrow("Cannot renew a REVOKED license.");
    });

    it("SUSPENDED + reactivate: transitions to ACTIVE", async () => {
      const lic = await service.createLicense({
        customer_id: customerId,
        license_type: "enterprise",
        max_installations: 1,
        expires_at: "2027-01-01T00:00:00.000Z",
        actor: "admin@clientix.com",
      });

      await service.suspendLicense(lic.id, "admin@clientix.com");
      const reactivated = await service.reactivateLicense(lic.id, "admin@clientix.com");
      expect(reactivated.status).toBe("ACTIVE");
    });
  });

  describe("Activation Codes", () => {
    let licenseId: string;

    beforeEach(async () => {
      const c = await service.createCustomer(
        { name: "Test Cust", billing_email: "cust@test.com" },
        "admin@clientix.com"
      );
      const lic = await service.createLicense({
        customer_id: c.id,
        license_type: "enterprise",
        max_installations: 3,
        expires_at: "2027-01-01T00:00:00.000Z",
        actor: "admin@clientix.com",
      });
      licenseId = lic.id;
    });

    it("generates ACT_<base64url> code, stores HMAC-SHA256, and returns raw code only once", async () => {
      const res = await service.createActivationCode({
        license_id: licenseId,
        max_uses: 2,
        expires_at: "2026-12-31T23:59:59.000Z",
        actor: "admin@clientix.com",
      });

      expect(res.raw_activation_code).toMatch(/^ACT_[A-Za-z0-9_-]{43}$/);
      expect(res.code.id).toBeDefined();
      expect(res.code.max_uses).toBe(2);

      // Verify db stored only the HMAC digest
      const stored = db.activationCodes.get(res.code.id);
      expect(stored).toBeDefined();
      expect(stored?.code_hash).toBe(deriveActivationCodeDigest(res.raw_activation_code, pepper));
      expect((stored as unknown as Record<string, unknown>)["raw_activation_code"]).toBeUndefined();

      // Ensure audit log never contains raw code
      const event = db.events.find((e) => e.event_type === "ACTIVATION_CODE_CREATED");
      expect(JSON.stringify(event?.payload)).not.toContain(res.raw_activation_code);
    });

    it("revokes an activation code", async () => {
      const res = await service.createActivationCode({
        license_id: licenseId,
        expires_at: "2026-12-31T23:59:59.000Z",
        actor: "admin@clientix.com",
      });

      const revoked = await service.revokeActivationCode(res.code.id, "admin@clientix.com");
      expect(revoked.revoked_at).not.toBeNull();
      expect(revoked.is_valid).toBe(false);
    });

    it("SHOW-ONCE invariant: listActivationCodes never exposes raw code or code_hash", async () => {
      const created = await service.createActivationCode({
        license_id: licenseId,
        expires_at: "2026-12-31T23:59:59.000Z",
        actor: "admin@clientix.com",
      });

      const list = await service.listActivationCodes(licenseId);
      expect(list.length).toBeGreaterThan(0);
      const found = list.find((c) => c.id === created.code.id);
      expect(found).toBeDefined();

      // Explicitly check forbidden fields
      expect((found as unknown as Record<string, unknown>)["raw_activation_code"]).toBeUndefined();
      expect((found as unknown as Record<string, unknown>)["code_hash"]).toBeUndefined();
      expect((found as unknown as Record<string, unknown>)["rawCode"]).toBeUndefined();
    });
  });

  describe("Installation Management", () => {
    let installationId: string;
    let licenseId: string;

    beforeEach(async () => {
      const c = await service.createCustomer(
        { name: "Test Cust", billing_email: "cust@test.com" },
        "admin@clientix.com"
      );
      const lic = await service.createLicense({
        customer_id: c.id,
        license_type: "enterprise",
        max_installations: 3,
        expires_at: "2027-01-01T00:00:00.000Z",
        actor: "admin@clientix.com",
      });
      licenseId = lic.id;

      installationId = "inst_11111111-2222-4333-8444-555555555555";
      db.installations.set(installationId, {
        id: installationId,
        license_id: licenseId,
        public_key: "-----BEGIN PUBLIC KEY-----\nMIIB...FakeKey\n-----END PUBLIC KEY-----",
        public_key_fingerprint: "a".repeat(64),
        status: "ACTIVE",
        environment: "production",
        app_version: "1.0.0",
        last_heartbeat_at: "2026-10-08T11:00:00.000Z",
        created_at: "2026-10-08T10:00:00.000Z",
        updated_at: "2026-10-08T10:00:00.000Z",
      });
    });

    it("retrieves installation detail with fingerprint and customer", async () => {
      const detail = await service.getInstallationDetail(installationId);
      expect(detail).not.toBeNull();
      expect(detail?.installation.id).toBe(installationId);
      expect(detail?.installation.public_key_fingerprint).toBe("a".repeat(64));
      expect(detail?.customer.name).toBe("Test Cust");
    });

    it("suspends, reactivates, revokes, and force deactivates installation", async () => {
      // Suspend
      const suspended = await service.suspendInstallation(installationId, "admin@clientix.com");
      expect(suspended.status).toBe("SUSPENDED");

      // Reactivate
      const reactivated = await service.reactivateInstallation(installationId, "admin@clientix.com");
      expect(reactivated.status).toBe("ACTIVE");

      // Force deactivate
      const deact = await service.forceDeactivateInstallation(installationId, "admin@clientix.com");
      expect(deact.status).toBe("DEACTIVATED");

      // Revoke
      const revoked = await service.revokeInstallation(installationId, "admin@clientix.com");
      expect(revoked.status).toBe("REVOKED");

      // Cannot reactivate revoked installation
      await expect(service.reactivateInstallation(installationId, "admin@clientix.com")).rejects.toThrow(
        "Cannot reactivate a REVOKED installation."
      );
    });
  });

  describe("Audit Logs & Sanitization", () => {
    it("redacts sensitive keys from audit event payload", async () => {
      await service.recordAdminEvent({
        eventType: "TEST_SECURITY_EVENT",
        actor: "security_admin",
        payload: {
          secret: "super_secret_token",
          token: "jwt_token_here",
          raw_activation_code: "ACT_sensitive_code",
          normal_field: "public_value",
        },
      });

      const events = await service.listAuditEvents({ event_type: "TEST_SECURITY_EVENT" });
      expect(events).toHaveLength(1);
      const payload = events[0]?.payload;
      expect(payload?.normal_field).toBe("public_value");
      expect(payload?.secret).toBe("[REDACTED]");
      expect(payload?.token).toBe("[REDACTED]");
      expect(payload?.raw_activation_code).toBe("[REDACTED]");
      expect(events[0]?.actor).toBe("security_admin");
    });

    it("AUDIT ACTOR invariant: human portal operations record authenticated admin actor (not 'system')", async () => {
      const c = await service.createCustomer(
        { name: "Audited Customer", billing_email: "audit@test.com" },
        "operator.admin@clientix.com"
      );

      const lic = await service.createLicense({
        customer_id: c.id,
        license_type: "enterprise",
        max_installations: 1,
        expires_at: "2027-01-01T00:00:00.000Z",
        actor: "licensing.manager@clientix.com",
      });

      await service.suspendLicense(lic.id, "compliance.officer@clientix.com");
      await service.reactivateLicense(lic.id, "compliance.officer@clientix.com");

      const events = await service.listAuditEvents({ license_id: lic.id });
      const actors = events.map((e) => e.actor);

      // Verify that all recorded events carry human admin email, never 'system'
      expect(actors).toContain("licensing.manager@clientix.com");
      expect(actors).toContain("compliance.officer@clientix.com");
      expect(actors).not.toContain("system");
    });
  });
});
