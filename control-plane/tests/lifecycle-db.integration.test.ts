import { randomUUID, generateKeyPairSync } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Pool, type PoolClient } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  createInstallationRequestSignature,
  computePublicKeyFingerprint,
  generateInstallationKeyPair,
  generateRequestNonce,
} from "@/lib/licensing/installation-auth";
import { ControlPlaneAdminService } from "../src/admin-service";
import { BillingService } from "../src/billing-service";
import { BillingScheduler } from "../src/billing-scheduler";
import { CONTROL_PLANE_BILLING_SCHEDULER_LOCK_ID } from "../src/admin-service-provider";
import { verifyLicense } from "@/lib/licensing/verify";
import { installLicenseFile } from "@/lib/licensing/enforcement";
import { PostgresNonceStore } from "../src/nonce-store";
import { PostgresRateLimiter } from "../src/rate-limiter";
import { ControlPlaneService } from "../src/service";
import { StaticVendorSignerProvider } from "../src/signer";
import { runControlPlaneMigrations, type DatabaseClient } from "../scripts/migrator";

const testDatabaseUrl = process.env.CONTROL_PLANE_TEST_DATABASE_URL;

function isDedicatedLocalDatabase(value: string | undefined): boolean {
  if (!value) return false;
  try {
    const url = new URL(value);
    return (
      ["localhost", "127.0.0.1", "::1", "[::1]"].includes(url.hostname.toLowerCase()) &&
      url.pathname === "/clientix_license_server_test"
    );
  } catch {
    return false;
  }
}

const localDatabaseSuite = describe.skipIf(!isDedicatedLocalDatabase(testDatabaseUrl));

class PoolDatabaseClient implements DatabaseClient {
  constructor(private readonly pool: Pool) {}

  async query<R = Record<string, unknown>>(
    sql: string,
    params: unknown[] = [],
  ): Promise<{ rows: R[]; rowCount?: number }> {
    const result = await this.pool.query(sql, params as never[]);
    return { rows: result.rows as R[], rowCount: result.rowCount ?? undefined };
  }
}

class PinnedDatabaseClient implements DatabaseClient {
  constructor(private readonly client: PoolClient) {}

  async query<R = Record<string, unknown>>(
    sql: string,
    params: unknown[] = [],
  ): Promise<{ rows: R[]; rowCount?: number }> {
    const result = await this.client.query(sql, params as never[]);
    return { rows: result.rows as R[], rowCount: result.rowCount ?? undefined };
  }
}

function installationId(): string {
  return `inst_${randomUUID()}`;
}

localDatabaseSuite("Control Plane lifecycle migration on disposable PostgreSQL", () => {
  let pool: Pool;
  let admin: ControlPlaneAdminService;
  let signingKeyId: string;
  let signingPrivateKeyPem: string;
  let signingPublicKeyPem: string;
  const testPepper = "disposable-test-pepper-with-at-least-32-characters";
  let ownsDisposableDatabase = false;

  beforeAll(async () => {
    pool = new Pool({ connectionString: testDatabaseUrl, max: 8 });
    const identity = await pool.query<{
      database_name: string;
      is_superuser: boolean;
      schema_exists: boolean;
      runtime_role_exists: boolean;
    }>(`
      select current_database() as database_name,
             (select rolsuper from pg_roles where rolname = current_user) as is_superuser,
             to_regnamespace('control_plane') is not null as schema_exists,
             exists (select 1 from pg_roles where rolname = 'clientix_control_plane') as runtime_role_exists;
    `);
    const state = identity.rows[0];
    if (
      state?.database_name !== "clientix_license_server_test" ||
      state.is_superuser !== true ||
      state.schema_exists ||
      state.runtime_role_exists
    ) {
      throw new Error("The disposable License Server test database must be empty and isolated.");
    }

    ownsDisposableDatabase = true;
    await pool.query("create role clientix_control_plane;");
    const migrationClient: PoolClient = await pool.connect();
    try {
      await runControlPlaneMigrations(
        new PinnedDatabaseClient(migrationClient),
        path.resolve(__dirname, "../migrations"),
      );
    } finally {
      migrationClient.release();
    }

    const keyPair = generateKeyPairSync("ed25519");
    signingPublicKeyPem = keyPair.publicKey.export({ format: "pem", type: "spki" }).toString();
    signingPrivateKeyPem = keyPair.privateKey.export({ format: "pem", type: "pkcs8" }).toString();
    signingKeyId = `dev-only-db-${randomUUID()}`;
    await pool.query(
      `insert into control_plane.licensing_signer_keys (key_id, algorithm, public_key_pem, is_active)
       values ($1, 'Ed25519', $2, true);`,
      [signingKeyId, signingPublicKeyPem],
    );
    admin = new ControlPlaneAdminService({
      db: new PoolDatabaseClient(pool),
      pepper: testPepper,
    });
  }, 30_000);

  afterAll(async () => {
    if (!pool) return;
    try {
      if (ownsDisposableDatabase) {
        await pool.query("drop schema if exists control_plane cascade;");
        await pool.query("drop role if exists clientix_control_plane;");
      }
    } finally {
      await pool.end();
    }
  });

  async function createActiveLicense(maxInstallations = 1): Promise<{
    customerId: string;
    licenseId: string;
    serial: string;
  }> {
    const customer = await admin.createCustomer(
      {
        name: "Synthetic DB test customer",
        billing_email: `test-${randomUUID()}@example.invalid`,
      },
      "db-test-operator",
    );
    const license = await admin.createLicense({
      customer_id: customer.id,
      license_type: "internal",
      plan: "pro",
      max_installations: maxInstallations,
      valid_from: new Date(Date.now() - 60_000).toISOString(),
      expires_at: "2099-01-15T00:00:00.000Z",
      signing_key_id: signingKeyId,
      status: "ACTIVE",
      actor: "db-test-operator",
    });
    return { customerId: customer.id, licenseId: license.id, serial: license.serial };
  }

  async function addInstallation(licenseId: string, id = installationId()): Promise<string> {
    const pair = generateKeyPairSync("ed25519");
    const publicKeyPem = pair.publicKey.export({ format: "pem", type: "spki" }).toString();
    const fingerprint = computePublicKeyFingerprint(publicKeyPem);
    await pool.query(
      `insert into control_plane.licensing_installations
         (id, license_id, public_key, public_key_fingerprint, status, environment, app_version, clientix_version)
       values ($1, $2, $3, $4, 'ACTIVE', 'test', 'test', 'test');`,
      [id, licenseId, publicKeyPem, fingerprint],
    );
    return id;
  }

  async function createRuntimeService(): Promise<{
    service: ControlPlaneService;
    release: () => void;
  }> {
    const client = await pool.connect();
    const db = new PinnedDatabaseClient(client);
    return {
      service: new ControlPlaneService({
        db,
        signerProvider: new StaticVendorSignerProvider(signingKeyId, signingPrivateKeyPem),
        trustedPublicKeyMap: { [signingKeyId]: signingPublicKeyPem },
        pepper: testPepper,
        nonceStore: new PostgresNonceStore(db),
        rateLimiter: new PostgresRateLimiter(db, testPepper),
      }),
      release: () => client.release(),
    };
  }

  function activationRequest(
    activationCode: string,
    id = installationId(),
    publicKeyPem = generateInstallationKeyPair().publicKeyPem,
  ) {
    return {
      installation_id: id,
      installation_public_key: publicKeyPem,
      activation_code: activationCode,
      timestamp: Math.floor(Date.now() / 1000),
      nonce: randomUUID(),
      clientIp: "198.51.100.10",
      app_version: "db-test",
    };
  }

  it("applies the Control Plane migrations and enforces schema constraints and unique serials", async () => {
    const license = await createActiveLicense();
    expect(license.serial).toMatch(/^CLX-\d{4}-[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}$/);

    const privileges = await pool.query<{ rate_limit_delete: boolean; renewal_execute: boolean }>(
      `select has_table_privilege('clientix_control_plane', 'control_plane.licensing_rate_limit_buckets', 'DELETE') as rate_limit_delete,
              has_function_privilege('clientix_control_plane', 'control_plane.renew_license(uuid,integer,timestamp with time zone,timestamp with time zone,boolean,text,text,text,text)', 'EXECUTE') as renewal_execute;`,
    );
    expect(privileges.rows[0]).toEqual({ rate_limit_delete: true, renewal_execute: true });

    await expect(
      pool.query(
        `insert into control_plane.licensing_licenses
           (serial, customer_id, product, deployment, plan, license_type, status, signing_key_id,
            issued_at, valid_from, expires_at, grace_days, max_installations)
         values ($1, $2, 'clientix', 'self-hosted', 'pro', 'internal', 'DRAFT', $3,
                 null, now(), now() + interval '1 day', 7, 1);`,
        [license.serial, license.customerId, signingKeyId],
      ),
    ).rejects.toMatchObject({ code: "23505" });

    const createdEvent = await pool.query<{ count: number }>(
      `select count(*)::int as count from control_plane.licensing_events
       where license_id = $1 and event_type = 'LICENSE_CREATED';`,
      [license.licenseId],
    );
    expect(createdEvent.rows[0]?.count).toBe(1);
  });

  it("creates and issues one draft across identical concurrent retries", async () => {
    const customer = await admin.createCustomer(
      {
        name: "Synthetic idempotency customer",
        billing_email: `draft-${randomUUID()}@example.invalid`,
      },
      "db-test-operator",
    );
    const idempotencyKey = `draft-${randomUUID()}`;
    const request = {
      customer_id: customer.id,
      license_type: "enterprise" as const,
      plan: "pro" as const,
      max_installations: 1,
      valid_from: "2099-01-01T00:00:00.000Z",
      expires_at: "2099-01-15T00:00:00.000Z",
      signing_key_id: signingKeyId,
      idempotency_key: idempotencyKey,
      actor: "db-test-operator",
      request_id: `request-${randomUUID()}`,
    };
    const [first, retry] = await Promise.all([
      admin.createLicense(request),
      admin.createLicense(request),
    ]);
    expect(first.id).toBe(retry.id);
    expect(first.status).toBe("DRAFT");

    await Promise.all([
      admin.issueLicense(first.id, "db-test-operator", `issue-${randomUUID()}`),
      admin.issueLicense(first.id, "db-test-operator", `issue-${randomUUID()}`),
    ]);
    const counts = await pool.query<{ created: number; issued: number }>(
      `select count(*) filter (where event_type = 'LICENSE_CREATED')::int as created,
              count(*) filter (where event_type = 'LICENSE_ISSUED')::int as issued
         from control_plane.licensing_events where license_id = $1;`,
      [first.id],
    );
    expect(counts.rows[0]).toEqual({ created: 1, issued: 1 });
  });

  it("enforces max_installations under concurrent activations in PostgreSQL", async () => {
    const license = await createActiveLicense(1);
    const activation = await admin.createActivationCode({
      license_id: license.licenseId,
      max_uses: 2,
      expires_at: "2099-01-15T00:00:00.000Z",
      actor: "db-test-operator",
    });
    const first = await createRuntimeService();
    const second = await createRuntimeService();
    const requests = [
      activationRequest(activation.raw_activation_code),
      activationRequest(activation.raw_activation_code),
    ];

    try {
      const results = await Promise.all([
        first.service.activate(requests[0]!),
        second.service.activate(requests[1]!),
      ]);
      expect(results.filter((result) => result.ok)).toHaveLength(1);
      expect(
        results.filter((result) => result.error?.code === "ACTIVATION_LIMIT_REACHED"),
      ).toHaveLength(1);

      const state = await pool.query<{
        active_count: number;
        used_count: number;
        event_count: number;
      }>(
        `select
           (select count(*)::int from control_plane.licensing_installations where license_id = $1 and status = 'ACTIVE') as active_count,
           (select used_count from control_plane.licensing_activation_codes where id = $2) as used_count,
           (select count(*)::int from control_plane.licensing_events where license_id = $1 and event_type = 'LICENSE_ACTIVATED') as event_count;`,
        [license.licenseId, activation.code.id],
      );
      expect(state.rows[0]).toEqual({ active_count: 1, used_count: 1, event_count: 1 });
    } finally {
      first.release();
      second.release();
    }
  });

  it("returns one installation idempotently when the same activation races", async () => {
    const license = await createActiveLicense(1);
    const activation = await admin.createActivationCode({
      license_id: license.licenseId,
      max_uses: 1,
      expires_at: "2099-01-15T00:00:00.000Z",
      actor: "db-test-operator",
    });
    const pair = generateInstallationKeyPair();
    const id = installationId();
    const request = activationRequest(activation.raw_activation_code, id, pair.publicKeyPem);
    const first = await createRuntimeService();
    const second = await createRuntimeService();

    try {
      const results = await Promise.all([
        first.service.activate(request),
        second.service.activate(request),
      ]);
      expect(results.every((result) => result.ok)).toBe(true);
      expect(results[0]?.data?.signed_license).toEqual(results[1]?.data?.signed_license);

      const state = await pool.query<{
        installation_count: number;
        used_count: number;
        event_count: number;
      }>(
        `select
           (select count(*)::int from control_plane.licensing_installations where id = $1) as installation_count,
           (select used_count from control_plane.licensing_activation_codes where id = $2) as used_count,
           (select count(*)::int from control_plane.licensing_events where license_id = $3 and event_type = 'LICENSE_ACTIVATED') as event_count;`,
        [id, activation.code.id, license.licenseId],
      );
      expect(state.rows[0]).toEqual({ installation_count: 1, used_count: 1, event_count: 1 });
    } finally {
      first.release();
      second.release();
    }
  });

  it("renews concurrently with idempotency and writes lifecycle events once", async () => {
    const license = await createActiveLicense();
    const idempotencyKey = `same-renewal-${randomUUID()}`;
    const request = {
      license_id: license.licenseId,
      duration_months: 12,
      idempotency_key: idempotencyKey,
      active_signing_key_id: signingKeyId,
      actor: "db-test-operator",
    };
    const [first, retry] = await Promise.all([
      admin.renewLicense(request),
      admin.renewLicense(request),
    ]);

    expect(new Date(first.expires_at).toISOString()).toBe(new Date(retry.expires_at).toISOString());
    expect(new Date(first.expires_at).toISOString()).toBe("2100-01-15T00:00:00.000Z");
    const events = await pool.query<{ count: number }>(
      `select count(*)::int as count from control_plane.licensing_events
       where license_id = $1 and event_type in ('LICENSE_RENEWED', 'LICENSE_REISSUED');`,
      [license.licenseId],
    );
    expect(events.rows[0]?.count).toBe(2);
  });

  it("confirms a MANUAL payment once, signs the renewed revision, and LIC-01 accepts it atomically", async () => {
    const license = await createActiveLicense();
    const installationPair = generateInstallationKeyPair();
    const installation = installationId();
    const installationFingerprint = computePublicKeyFingerprint(installationPair.publicKeyPem);
    await pool.query(
      `insert into control_plane.licensing_installations
         (id, license_id, public_key, public_key_fingerprint, status, environment, app_version, clientix_version)
       values ($1, $2, $3, $4, 'ACTIVE', 'test', 'test', 'test');`,
      [installation, license.licenseId, installationPair.publicKeyPem, installationFingerprint],
    );
    const runtime = await createRuntimeService();
    const billing = new BillingService(
      new PoolDatabaseClient(pool),
      () => new Date(),
      ({ licenseId, limit }) =>
        runtime.service.processPendingLicenseArtifacts({ licenseId, limit }),
    );
    const subscription = await billing.createSubscription({
      customer_id: license.customerId,
      license_id: license.licenseId,
      provider: "MANUAL",
      billing_cycle: "ANNUAL",
      amount_cents: 24_000,
      currency: "brl",
      current_period_start: "2098-01-15T00:00:00.000Z",
      current_period_end: "2099-01-15T00:00:00.000Z",
      auto_renew: true,
      idempotency_key: `billing-sub-${randomUUID()}`,
      actor_id: "db-test-operator",
      request_id: `billing-sub-request-${randomUUID()}`,
    });
    const invoice = await billing.createInvoice({
      subscription_id: subscription.id,
      due_at: new Date(Date.now() + 60_000).toISOString(),
      idempotency_key: `billing-invoice-${randomUUID()}`,
      actor_id: "db-test-operator",
      request_id: `billing-invoice-request-${randomUUID()}`,
    });
    const idempotencyKey = `manual-payment-${randomUUID()}`;
    const input = {
      invoice_id: invoice.id,
      idempotency_key: idempotencyKey,
      actor_id: "db-test-operator",
      request_id: `manual-payment-request-${randomUUID()}`,
      reason: "synthetic integration payment",
    };
    const temporaryDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "clientix-lic04-e2e-"));
    try {
      const first = await billing.confirmManualPayment(input);
      expect(first.duplicate).toBe(false);
      expect(first.license_reissue_status).toBe("ISSUED");
      expect(first.signed_artifacts_created).toBe(1);
      expect(first.signed_artifacts_pending).toBe(0);
      expect(new Date(first.expires_at).toISOString()).toBe("2100-01-15T00:00:00.000Z");

      const retry = await billing.confirmManualPayment({
        ...input,
        request_id: `manual-payment-retry-${randomUUID()}`,
      });
      expect(retry.payment_id).toBe(first.payment_id);
      expect(retry.duplicate).toBe(true);

      const state = await pool.query<{
        invoice_status: string;
        payment_count: number;
        renewal_events: number;
        license_reissued_events: number;
        artifact_count: number;
        issued_artifact_count: number;
        max_revision: number;
      }>(
        `select i.status as invoice_status,
                (select count(*)::int from control_plane.billing_payments p where p.invoice_id=i.id and p.status='CONFIRMED') as payment_count,
                (select count(*)::int from control_plane.billing_events e where e.invoice_id=i.id and e.event_type='LICENSE_RENEWED_FROM_PAYMENT') as renewal_events,
                (select count(*)::int from control_plane.licensing_events e where e.license_id=i.license_id and e.event_type='LICENSE_REISSUED') as license_reissued_events,
                (select count(*)::int from control_plane.licensing_license_artifacts a where a.license_id=i.license_id and a.installation_id=$2) as artifact_count,
                (select count(*)::int from control_plane.licensing_license_artifacts a where a.license_id=i.license_id and a.installation_id=$2 and a.status='ISSUED') as issued_artifact_count,
                (select max(a.license_revision)::int from control_plane.licensing_license_artifacts a where a.license_id=i.license_id and a.installation_id=$2) as max_revision
           from control_plane.billing_invoices i where i.id=$1;`,
        [invoice.id, installation],
      );
      expect(state.rows[0]).toEqual({
        invoice_status: "PAID",
        payment_count: 1,
        renewal_events: 1,
        license_reissued_events: 1,
        artifact_count: 1,
        issued_artifact_count: 1,
        max_revision: 2,
      });

      const artifact = await pool.query<{ signed_document: unknown; artifact_sha256: string }>(
        `select signed_document, artifact_sha256 from control_plane.licensing_license_artifacts
          where license_id=$1 and installation_id=$2 and license_revision=2 and status='ISSUED';`,
        [license.licenseId, installation],
      );
      const signedDocument = artifact.rows[0]?.signed_document;
      expect(signedDocument).toBeTruthy();
      expect(artifact.rows[0]?.artifact_sha256).toMatch(/^[0-9a-f]{64}$/);
      expect(() =>
        verifyLicense(signedDocument, {
          expectedInstallationId: installation,
          trustedKeys: { [signingKeyId]: signingPublicKeyPem },
        }),
      ).not.toThrow();

      const timestamp = Math.floor(Date.now() / 1000);
      const nonce = randomUUID();
      const body = JSON.stringify({
        installation_id: installation,
        license_id: license.licenseId,
        timestamp,
        nonce,
        clientix_version: "db-test",
        local_license_status: "ACTIVE",
      });
      const validated = await runtime.service.heartbeat({
        installation_id: installation,
        license_id: license.licenseId,
        app_version: "db-test",
        timestamp,
        nonce,
        signatureBase64url: createInstallationRequestSignature({
          installationId: installation,
          timestamp,
          nonce,
          method: "POST",
          path: "/api/v1/licensing/validate",
          body,
          privateKeyPem: installationPair.privateKeyPem,
        }),
        rawBody: body,
        requestPath: "/api/v1/licensing/validate",
      });
      expect(validated.ok).toBe(true);
      expect(validated.data?.signed_license).toEqual(signedDocument);
      expect(
        verifyLicense(validated.data?.signed_license, {
          expectedInstallationId: installation,
          trustedKeys: { [signingKeyId]: signingPublicKeyPem },
        }).usable,
      ).toBe(true);

      const installationIdPath = path.join(temporaryDirectory, "installation_id");
      const licensePath = path.join(temporaryDirectory, "license.json");
      await fs.writeFile(installationIdPath, installation, "utf8");
      const installed = await installLicenseFile(signedDocument, {
        targetPath: licensePath,
        installationIdPath,
        trustedKeys: { [signingKeyId]: signingPublicKeyPem },
      });
      expect(installed.success).toBe(true);
      const localDocument = JSON.parse(await fs.readFile(licensePath, "utf8")) as {
        payload: { license_revision: number; expires_at: string };
      };
      expect(localDocument.payload.license_revision).toBe(2);
      expect(localDocument.payload.expires_at).toBe(new Date(first.expires_at).toISOString());
    } finally {
      runtime.release();
      await fs.rm(temporaryDirectory, { recursive: true, force: true });
    }
  });

  it("requires a reason for no-charge renewal and blocks bypassing an active billing subscription", async () => {
    const license = await createActiveLicense();
    const billing = new BillingService(new PoolDatabaseClient(pool));
    await expect(
      billing.renewWithoutBilling({
        license_id: license.licenseId,
        duration_months: 12,
        reason: "",
        idempotency_key: `no-charge-${randomUUID()}`,
        actor_id: "db-test-operator",
        request_id: `no-charge-request-${randomUUID()}`,
      }),
    ).rejects.toThrow();

    await billing.createSubscription({
      customer_id: license.customerId,
      license_id: license.licenseId,
      provider: "MANUAL",
      billing_cycle: "ANNUAL",
      amount_cents: 24_000,
      currency: "BRL",
      current_period_start: "2098-01-15T00:00:00.000Z",
      current_period_end: "2099-01-15T00:00:00.000Z",
      auto_renew: true,
      idempotency_key: `billing-sub-${randomUUID()}`,
      actor_id: "db-test-operator",
      request_id: `billing-sub-request-${randomUUID()}`,
    });
    await expect(
      billing.renewWithoutBilling({
        license_id: license.licenseId,
        duration_months: 12,
        reason: "exception approved by vendor",
        idempotency_key: `no-charge-${randomUUID()}`,
        actor_id: "db-test-operator",
        request_id: `no-charge-request-${randomUUID()}`,
      }),
    ).rejects.toThrow(/active billing subscription/);
  });

  it("marks overdue invoices past_due and suspends only when the vendor policy requests it", async () => {
    const license = await createActiveLicense();
    const installationPair = generateInstallationKeyPair();
    const installedId = installationId();
    await pool.query(
      `insert into control_plane.licensing_installations
         (id, license_id, public_key, public_key_fingerprint, status, environment, app_version, clientix_version)
       values ($1, $2, $3, $4, 'ACTIVE', 'test', 'test', 'test');`,
      [
        installedId,
        license.licenseId,
        installationPair.publicKeyPem,
        computePublicKeyFingerprint(installationPair.publicKeyPem),
      ],
    );
    const runtime = await createRuntimeService();
    const billing = new BillingService(
      new PoolDatabaseClient(pool),
      () => new Date(),
      ({ licenseId, limit }) =>
        runtime.service.processPendingLicenseArtifacts({ licenseId, limit }),
    );
    try {
      const now = new Date();
      const periodEnd = new Date(now.getTime() - 20 * 86_400_000);
      const periodStart = new Date(periodEnd.getTime() - 365 * 86_400_000);
      const subscription = await billing.createSubscription({
        customer_id: license.customerId,
        license_id: license.licenseId,
        provider: "MANUAL",
        billing_cycle: "ANNUAL",
        amount_cents: 12_000,
        currency: "BRL",
        current_period_start: periodStart.toISOString(),
        current_period_end: periodEnd.toISOString(),
        auto_renew: true,
        idempotency_key: `billing-sub-${randomUUID()}`,
        actor_id: "db-test-operator",
        request_id: `billing-sub-request-${randomUUID()}`,
      });
      await billing.runMaintenance(`billing-maintenance-${randomUUID()}`);
      let state = await pool.query<{
        subscription_status: string;
        license_status: string;
        overdue_invoices: number;
      }>(
        `select s.status as subscription_status,l.status as license_status,
              (select count(*)::int from control_plane.billing_invoices i where i.subscription_id=s.id and i.status='OVERDUE') as overdue_invoices
         from control_plane.billing_subscriptions s join control_plane.licensing_licenses l on l.id=s.license_id where s.id=$1;`,
        [subscription.id],
      );
      expect(state.rows[0]).toEqual({
        subscription_status: "PAST_DUE",
        license_status: "ACTIVE",
        overdue_invoices: 1,
      });

      await billing.updateSettings({
        billing_grace_days: 0,
        nonpayment_policy: "SUSPEND_AFTER_GRACE",
        invoice_lead_days: 30,
        actor_id: "db-test-operator",
        request_id: `billing-settings-${randomUUID()}`,
      });
      await billing.runMaintenance(`billing-maintenance-${randomUUID()}`);
      state = await pool.query(
        `select s.status as subscription_status,l.status as license_status,
      (select count(*)::int from control_plane.billing_events e where e.subscription_id=s.id and e.event_type='LICENSE_SUSPENDED_FOR_NONPAYMENT') as suspension_events
      from control_plane.billing_subscriptions s join control_plane.licensing_licenses l on l.id=s.license_id where s.id=$1;`,
        [subscription.id],
      );
      expect(state.rows[0]).toEqual({
        subscription_status: "SUSPENDED",
        license_status: "SUSPENDED",
        suspension_events: 1,
      });

      const overdueInvoice = await pool.query<{ id: string }>(
        `select id from control_plane.billing_invoices where subscription_id=$1 and status='OVERDUE' limit 1;`,
        [subscription.id],
      );
      const payment = await billing.confirmManualPayment({
        invoice_id: overdueInvoice.rows[0]!.id,
        idempotency_key: `after-suspension-payment-${randomUUID()}`,
        actor_id: "db-test-operator",
        request_id: `after-suspension-request-${randomUUID()}`,
        reason: "synthetic payment after billing suspension",
      });
      expect(payment.license_reissue_status).toBe("ISSUED");
      expect(payment.signed_artifacts_created).toBe(1);
      const recovered = await pool.query<{
        subscription_status: string;
        license_status: string;
        suspended_for_nonpayment_at: string | null;
        payments: number;
        renewals: number;
        reactivations: number;
        issued_artifacts: number;
        latest_revision: number;
      }>(
        `select s.status as subscription_status,l.status as license_status,
              s.suspended_for_nonpayment_at,
              (select count(*)::int from control_plane.billing_payments p where p.invoice_id=$2 and p.status='CONFIRMED') as payments,
              (select count(*)::int from control_plane.billing_events e where e.invoice_id=$2 and e.event_type='LICENSE_RENEWED_FROM_PAYMENT') as renewals,
              (select count(*)::int from control_plane.billing_events e where e.invoice_id=$2 and e.event_type='LICENSE_REACTIVATED_AFTER_PAYMENT') as reactivations,
              (select count(*)::int from control_plane.licensing_license_artifacts a where a.license_id=l.id and a.installation_id=$3 and a.status='ISSUED') as issued_artifacts,
              (select max(a.license_revision)::int from control_plane.licensing_license_artifacts a where a.license_id=l.id and a.installation_id=$3 and a.status='ISSUED') as latest_revision
         from control_plane.billing_subscriptions s
         join control_plane.licensing_licenses l on l.id=s.license_id where s.id=$1;`,
        [subscription.id, overdueInvoice.rows[0]!.id, installedId],
      );
      expect(recovered.rows[0]).toEqual({
        subscription_status: "ACTIVE",
        license_status: "ACTIVE",
        suspended_for_nonpayment_at: null,
        payments: 1,
        renewals: 1,
        reactivations: 1,
        issued_artifacts: 1,
        latest_revision: expect.any(Number),
      });
      const signed = await pool.query<{ signed_document: unknown }>(
        `select signed_document from control_plane.licensing_license_artifacts
        where license_id=$1 and installation_id=$2 and status='ISSUED';`,
        [license.licenseId, installedId],
      );
      expect(
        verifyLicense(signed.rows[0]?.signed_document, {
          expectedInstallationId: installedId,
          trustedKeys: { [signingKeyId]: signingPublicKeyPem },
        }).cryptographic_valid,
      ).toBe(true);
    } finally {
      runtime.release();
    }
  });

  it("repeats billing maintenance without duplicating scheduled invoices or notifications", async () => {
    const license = await createActiveLicense();
    const billing = new BillingService(
      new PoolDatabaseClient(pool),
      () => new Date("2098-01-14T00:00:00.000Z"),
    );
    const subscription = await billing.createSubscription({
      customer_id: license.customerId,
      license_id: license.licenseId,
      provider: "MANUAL",
      billing_cycle: "ANNUAL",
      amount_cents: 18_000,
      currency: "BRL",
      current_period_start: "2097-01-15T00:00:00.000Z",
      current_period_end: "2098-01-15T00:00:00.000Z",
      auto_renew: true,
      idempotency_key: `scheduler-sub-${randomUUID()}`,
      actor_id: "db-test-operator",
      request_id: `scheduler-sub-request-${randomUUID()}`,
    });

    await billing.runMaintenance(`scheduler-cycle-${randomUUID()}`);
    await billing.runMaintenance(`scheduler-retry-${randomUUID()}`);
    const result = await pool.query<{
      invoices: number;
      due_notifications: number;
      scheduled_events: number;
      confirmed_payments: number;
      renewals: number;
      overdue_events: number;
    }>(
      `select
         (select count(*)::int from control_plane.billing_invoices where subscription_id=$1) as invoices,
         (select count(*)::int from control_plane.billing_notifications where subscription_id=$1 and event_type='BILLING_DUE_1_DAYS') as due_notifications,
         (select count(*)::int from control_plane.billing_events where subscription_id=$1 and event_type='LICENSE_RENEWAL_SCHEDULED') as scheduled_events,
         (select count(*)::int from control_plane.billing_payments where invoice_id in (select id from control_plane.billing_invoices where subscription_id=$1) and status='CONFIRMED') as confirmed_payments,
         (select count(*)::int from control_plane.billing_events where subscription_id=$1 and event_type='LICENSE_RENEWED_FROM_PAYMENT') as renewals,
         (select count(*)::int from control_plane.billing_events where subscription_id=$1 and event_type='INVOICE_OVERDUE') as overdue_events;`,
      [subscription.id],
    );
    expect(result.rows[0]).toEqual({
      invoices: 1,
      due_notifications: 1,
      scheduled_events: 1,
      confirmed_payments: 0,
      renewals: 0,
      overdue_events: 0,
    });
  });

  it("serializes concurrent scheduler cycles with a PostgreSQL advisory lock", async () => {
    let started!: () => void;
    let finish!: () => void;
    const cycleStarted = new Promise<void>((resolve) => (started = resolve));
    const cycleGate = new Promise<void>((resolve) => (finish = resolve));
    let cycleCount = 0;

    const withDatabaseAdvisoryLock = async <T>(operation: () => Promise<T>) => {
      const client = await pool.connect();
      let acquired = false;
      try {
        const lock = await client.query<{ acquired: boolean }>(
          "select pg_try_advisory_lock($1::bigint) as acquired;",
          [CONTROL_PLANE_BILLING_SCHEDULER_LOCK_ID],
        );
        acquired = lock.rows[0]?.acquired === true;
        if (!acquired) return { acquired: false } as const;
        return { acquired: true, value: await operation() } as const;
      } finally {
        if (acquired)
          await client.query("select pg_advisory_unlock($1::bigint);", [
            CONTROL_PLANE_BILLING_SCHEDULER_LOCK_ID,
          ]);
        client.release();
      }
    };
    const first = new BillingScheduler({
      intervalMs: 900_000,
      withLock: withDatabaseAdvisoryLock,
      runCycle: async () => {
        cycleCount += 1;
        started();
        await cycleGate;
        return "completed";
      },
    });
    const second = new BillingScheduler({
      intervalMs: 900_000,
      withLock: withDatabaseAdvisoryLock,
      runCycle: async () => {
        cycleCount += 1;
        return "completed";
      },
    });

    const firstCycle = first.runOnce();
    await cycleStarted;
    await expect(second.runOnce()).resolves.toEqual({ status: "SKIPPED_LOCKED" });
    finish();
    await expect(firstCycle).resolves.toEqual({ status: "COMPLETED", value: "completed" });
    expect(cycleCount).toBe(1);
  });

  it("serializes different concurrent day-based renewals without losing a term", async () => {
    const license = await createActiveLicense();
    const requests = [
      {
        license_id: license.licenseId,
        duration_days: 30 as const,
        idempotency_key: `renew-day-a-${randomUUID()}`,
        active_signing_key_id: signingKeyId,
        actor: "db-test-operator",
      },
      {
        license_id: license.licenseId,
        duration_days: 30 as const,
        idempotency_key: `renew-day-b-${randomUUID()}`,
        active_signing_key_id: signingKeyId,
        actor: "db-test-operator",
      },
    ];
    const [first, second] = await Promise.all(
      requests.map((request) => admin.renewLicense(request)),
    );
    const expiration = await pool.query<{ expires_at: string }>(
      "select expires_at::text from control_plane.licensing_licenses where id = $1;",
      [license.licenseId],
    );

    const returnedExpirations = [first!.expires_at, second!.expires_at]
      .map((value) => new Date(value).toISOString())
      .sort();
    expect(returnedExpirations).toEqual(["2099-02-14T00:00:00.000Z", "2099-03-16T00:00:00.000Z"]);
    expect(new Date(expiration.rows[0]!.expires_at).toISOString()).toBe("2099-03-16T00:00:00.000Z");
  });

  it("serializes installation transfers and preserves one active slot on retry", async () => {
    const license = await createActiveLicense(1);
    const sourceInstallationId = await addInstallation(license.licenseId);
    const targetInstallationId = installationId();
    const targetPair = generateKeyPairSync("ed25519");
    const targetPublicKey = targetPair.publicKey.export({ format: "pem", type: "spki" }).toString();
    const request = {
      license_id: license.licenseId,
      from_installation_id: sourceInstallationId,
      to_installation_id: targetInstallationId,
      to_public_key: targetPublicKey,
      reason: "Synthetic database transfer test",
      actor: "db-test-operator",
    };
    const [first, retry] = await Promise.all([
      admin.transferInstallation(request),
      admin.transferInstallation(request),
    ]);
    expect(first).toEqual(retry);

    const state = await pool.query<{
      active_count: number;
      source_status: string;
      target_status: string;
    }>(
      `select count(*) filter (where status = 'ACTIVE')::int as active_count,
              max(status) filter (where id = $2) as source_status,
              max(status) filter (where id = $3) as target_status
       from control_plane.licensing_installations where license_id = $1;`,
      [license.licenseId, sourceInstallationId, targetInstallationId],
    );
    expect(state.rows[0]).toEqual({
      active_count: 1,
      source_status: "TRANSFERRED",
      target_status: "ACTIVE",
    });

    const events = await pool.query<{ count: number }>(
      `select count(*)::int as count from control_plane.licensing_events
       where license_id = $1 and event_type in ('INSTALLATION_TRANSFERRED', 'INSTALLATION_REGISTERED');`,
      [license.licenseId],
    );
    expect(events.rows[0]?.count).toBe(2);
  });

  it("rolls back an installation transfer when the target id is already registered", async () => {
    const sourceLicense = await createActiveLicense();
    const targetLicense = await createActiveLicense();
    const sourceInstallationId = await addInstallation(sourceLicense.licenseId);
    const occupiedTargetId = await addInstallation(targetLicense.licenseId);
    const targetPair = generateKeyPairSync("ed25519");
    const targetPublicKey = targetPair.publicKey.export({ format: "pem", type: "spki" }).toString();

    await expect(
      admin.transferInstallation({
        license_id: sourceLicense.licenseId,
        from_installation_id: sourceInstallationId,
        to_installation_id: occupiedTargetId,
        to_public_key: targetPublicKey,
        reason: "Expected conflict in isolated database test",
        actor: "db-test-operator",
      }),
    ).rejects.toThrow();

    const source = await pool.query<{ status: string }>(
      `select status from control_plane.licensing_installations where id = $1;`,
      [sourceInstallationId],
    );
    const transferEvents = await pool.query<{ count: number }>(
      `select count(*)::int as count from control_plane.licensing_events
       where license_id = $1 and event_type = 'INSTALLATION_TRANSFERRED';`,
      [sourceLicense.licenseId],
    );
    expect(source.rows[0]?.status).toBe("ACTIVE");
    expect(transferEvents.rows[0]?.count).toBe(0);
  });

  it("keeps terminated sessions ended after reactivation and ends sessions after transfer/suspension/revocation", async () => {
    const license = await createActiveLicense(1);
    const sourceInstallationId = await addInstallation(license.licenseId);
    const sourceSessionId = `sess_${randomUUID()}`;
    const startedAt = new Date().toISOString();
    await pool.query(
      `insert into control_plane.licensing_instance_sessions
         (session_id, license_id, installation_id, status, boot_started_at, started_at, last_heartbeat_at)
       values ($1, $2, $3, 'ACTIVE', $4, $4, $4);`,
      [sourceSessionId, license.licenseId, sourceInstallationId, startedAt],
    );

    const targetInstallationId = installationId();
    const targetKey = generateInstallationKeyPair();
    await admin.transferInstallation({
      license_id: license.licenseId,
      from_installation_id: sourceInstallationId,
      to_installation_id: targetInstallationId,
      to_public_key: targetKey.publicKeyPem,
      reason: "Synthetic lifecycle integration test",
      actor: "db-test-operator",
    });
    const afterTransfer = await pool.query<{ status: string; ended_events: number }>(
      `select s.status,
              (select count(*)::int from control_plane.licensing_events e
                where e.installation_id = s.installation_id and e.event_type = 'INSTANCE_SESSION_ENDED') as ended_events
         from control_plane.licensing_instance_sessions s where s.session_id = $1;`,
      [sourceSessionId],
    );
    expect(afterTransfer.rows[0]).toEqual({ status: "ENDED", ended_events: 1 });

    const targetSessionAfterSuspend = `sess_${randomUUID()}`;
    const suspendStartedAt = new Date().toISOString();
    await pool.query(
      `insert into control_plane.licensing_instance_sessions
         (session_id, license_id, installation_id, status, boot_started_at, started_at, last_heartbeat_at)
       values ($1, $2, $3, 'ACTIVE', $4, $4, $4);`,
      [targetSessionAfterSuspend, license.licenseId, targetInstallationId, suspendStartedAt],
    );
    await admin.suspendLicense(
      license.licenseId,
      "db-test-operator",
      "Synthetic lifecycle integration test",
    );
    const afterSuspend = await pool.query<{ status: string }>(
      `select status from control_plane.licensing_instance_sessions where session_id = $1;`,
      [targetSessionAfterSuspend],
    );
    expect(afterSuspend.rows[0]?.status).toBe("ENDED");

    await admin.reactivateLicense(license.licenseId, "db-test-operator");
    const afterReactivation = await pool.query<{ status: string }>(
      `select status from control_plane.licensing_instance_sessions where session_id = $1;`,
      [targetSessionAfterSuspend],
    );
    expect(afterReactivation.rows[0]?.status).toBe("ENDED");

    const targetSessionAfterReactivation = `sess_${randomUUID()}`;
    const revokeStartedAt = new Date().toISOString();
    await pool.query(
      `insert into control_plane.licensing_instance_sessions
         (session_id, license_id, installation_id, status, boot_started_at, started_at, last_heartbeat_at)
       values ($1, $2, $3, 'ACTIVE', $4, $4, $4);`,
      [targetSessionAfterReactivation, license.licenseId, targetInstallationId, revokeStartedAt],
    );
    await admin.revokeLicense(
      license.licenseId,
      "db-test-operator",
      "Synthetic lifecycle integration test",
    );
    const afterRevocation = await pool.query<{ status: string }>(
      `select status from control_plane.licensing_instance_sessions where session_id = $1;`,
      [targetSessionAfterReactivation],
    );
    expect(afterRevocation.rows[0]?.status).toBe("ENDED");
  });

  it("detects two overlapping sessions from a full-volume clone and allows vendor recovery/key rotation", async () => {
    const license = await createActiveLicense();
    const originalKey = generateInstallationKeyPair();
    const id = installationId();
    const fingerprint = computePublicKeyFingerprint(originalKey.publicKeyPem);
    await pool.query(
      `insert into control_plane.licensing_installations
         (id, license_id, public_key, public_key_fingerprint, status, environment, app_version, clientix_version)
       values ($1, $2, $3, $4, 'ACTIVE', 'test', 'test', 'test');`,
      [id, license.licenseId, originalKey.publicKeyPem, fingerprint],
    );
    const { service, release } = await createRuntimeService();
    const bootTimes = new Map<string, string>();

    async function attest(sessionId: string, keyPair = originalKey) {
      const bootStartedAt = bootTimes.get(sessionId) ?? new Date().toISOString();
      bootTimes.set(sessionId, bootStartedAt);
      const challengeTimestamp = Math.floor(Date.now() / 1000);
      const challengeNonce = generateRequestNonce();
      const challengeBody = JSON.stringify({
        installation_id: id,
        license_id: license.licenseId,
        instance_session_id: sessionId,
        boot_started_at: bootStartedAt,
        clientix_version: "db-test",
        timestamp: challengeTimestamp,
        nonce: challengeNonce,
      });
      const challengeSignature = createInstallationRequestSignature({
        installationId: id,
        timestamp: challengeTimestamp,
        nonce: challengeNonce,
        method: "POST",
        path: "/api/v1/licensing/challenge",
        body: challengeBody,
        privateKeyPem: keyPair.privateKeyPem,
      });
      const issued = await service.createAttestationChallenge({
        installation_id: id,
        license_id: license.licenseId,
        instance_session_id: sessionId,
        boot_started_at: bootStartedAt,
        app_version: "db-test",
        timestamp: challengeTimestamp,
        nonce: challengeNonce,
        signatureBase64url: challengeSignature,
        rawBody: challengeBody,
        clientIp: "198.51.100.22",
      });
      expect(issued.ok).toBe(true);
      if (!issued.data) throw new Error("Expected a signed challenge fixture.");

      const timestamp = Math.floor(Date.now() / 1000);
      const nonce = generateRequestNonce();
      const body = JSON.stringify({
        installation_id: id,
        license_id: license.licenseId,
        instance_session_id: sessionId,
        boot_started_at: bootStartedAt,
        clientix_version: "db-test",
        local_license_status: "ACTIVE",
        challenge: issued.data.challenge,
        timestamp,
        nonce,
      });
      const signature = createInstallationRequestSignature({
        installationId: id,
        timestamp,
        nonce,
        method: "POST",
        path: "/api/v1/licensing/validate-attestation",
        body,
        privateKeyPem: keyPair.privateKeyPem,
      });
      const params = {
        installation_id: id,
        license_id: license.licenseId,
        instance_session_id: sessionId,
        boot_started_at: bootStartedAt,
        app_version: "db-test",
        local_license_state: "ACTIVE",
        challenge: issued.data.challenge,
        timestamp,
        nonce,
        signatureBase64url: signature,
        rawBody: body,
        clientIp: "198.51.100.22",
      };
      return { result: await service.validateAttestation(params), params };
    }

    try {
      const sessionA = `sess_${randomUUID()}`;
      const sessionB = `sess_${randomUUID()}`;
      expect((await attest(sessionA)).result.data?.clone_status).toBe("NORMAL");
      expect((await attest(sessionB)).result.data?.clone_status).toBe("SUSPECTED_CLONE");
      expect((await attest(sessionB)).result.data?.clone_status).toBe("SUSPECTED_CLONE");
      const persistentConflict = await attest(sessionA);
      expect(persistentConflict.result.data?.clone_status).toBe("CLONE_CONFIRMED");
      expect(persistentConflict.result.data?.license_status).toBe("SUSPENDED");

      const replay = await service.validateAttestation(persistentConflict.params);
      expect(replay).toMatchObject({ ok: false, status: 409 });

      const adminResult = await admin.authorizeInstallationRecovery({
        installation_id: id,
        reason: "Authorized isolated database integration test",
        actor: "db-test-operator",
        request_id: `recovery-${randomUUID()}`,
      });
      expect(adminResult.recovery_code).toMatch(/^REC_[A-Za-z0-9_-]{40,48}$/);
      const rotatedKey = generateInstallationKeyPair();
      const recoveryTimestamp = Math.floor(Date.now() / 1000);
      const recoveryNonce = generateRequestNonce();
      const recoveryBody = JSON.stringify({
        installation_id: id,
        installation_public_key: rotatedKey.publicKeyPem,
        recovery_code: adminResult.recovery_code,
        timestamp: recoveryTimestamp,
        nonce: recoveryNonce,
      });
      const recoverySignature = createInstallationRequestSignature({
        installationId: id,
        timestamp: recoveryTimestamp,
        nonce: recoveryNonce,
        method: "POST",
        path: "/api/v1/licensing/recover-installation",
        body: recoveryBody,
        privateKeyPem: rotatedKey.privateKeyPem,
      });
      const recovered = await service.recoverInstallationKey({
        installation_id: id,
        installation_public_key: rotatedKey.publicKeyPem,
        recovery_code: adminResult.recovery_code,
        timestamp: recoveryTimestamp,
        nonce: recoveryNonce,
        signatureBase64url: recoverySignature,
        rawBody: recoveryBody,
        clientIp: "198.51.100.22",
      });
      expect(recovered).toMatchObject({ ok: true, data: { clone_status: "NORMAL" } });

      const finalState = await pool.query<{
        clone_status: string;
        public_key_fingerprint: string;
        active_sessions: number;
        confirmed_events: number;
        recovery_request_id_present: boolean;
      }>(
        `select i.clone_status, i.public_key_fingerprint,
                (select count(*)::int from control_plane.licensing_instance_sessions s where s.installation_id = i.id and s.status = 'ACTIVE') as active_sessions,
                (select count(*)::int from control_plane.licensing_events e where e.installation_id = i.id and e.event_type = 'CLONE_CONFIRMED') as confirmed_events,
                exists (select 1 from control_plane.licensing_events e where e.installation_id = i.id and e.event_type = 'INSTALLATION_RECOVERY_AUTHORIZED' and e.request_id is not null) as recovery_request_id_present
           from control_plane.licensing_installations i where i.id = $1;`,
        [id],
      );
      expect(finalState.rows[0]).toEqual({
        clone_status: "NORMAL",
        public_key_fingerprint: computePublicKeyFingerprint(rotatedKey.publicKeyPem),
        active_sessions: 0,
        confirmed_events: 1,
        recovery_request_id_present: true,
      });

      await admin.revokeLicense(
        license.licenseId,
        "db-test-operator",
        "Synthetic revoked validation test",
      );
      const validationAfterRevocation = await attest(`sess_${randomUUID()}`, rotatedKey);
      expect(validationAfterRevocation.result.data?.license_status).toBe("REVOKED");
      const revokedSessions = await pool.query<{ active_sessions: number }>(
        `select count(*)::int as active_sessions from control_plane.licensing_instance_sessions
          where installation_id = $1 and status = 'ACTIVE';`,
        [id],
      );
      expect(revokedSessions.rows[0]?.active_sessions).toBe(0);
    } finally {
      release();
    }
  });
});
