import { createHash } from "node:crypto";
import type { DatabaseClient } from "../scripts/migrator";
import {
  isBillingProviderEnabled,
  type BillingProviderName,
  type BillingWebhookEvent,
} from "./billing-provider";
import type { LicenseArtifactProcessingResult } from "./license-artifact-service";

export type BillingArtifactProcessor = (params: {
  licenseId?: string;
  limit?: number;
}) => Promise<LicenseArtifactProcessingResult>;

export type BillingSubscriptionStatus =
  "TRIAL" | "ACTIVE" | "PAST_DUE" | "SUSPENDED" | "CANCELLED" | "EXPIRED";
export type BillingInvoiceStatus = "OPEN" | "PAID" | "OVERDUE" | "CANCELLED" | "REFUNDED";
export type BillingCycle = "MONTHLY" | "QUARTERLY" | "SEMIANNUAL" | "ANNUAL" | "CUSTOM";

export interface BillingPage<T> {
  items: T[];
  total: number;
  limit: number;
  offset: number;
}

export interface BillingSubscription {
  id: string;
  customer_id: string;
  customer_name: string;
  license_id: string;
  license_serial: string;
  provider: BillingProviderName;
  status: BillingSubscriptionStatus;
  billing_cycle: BillingCycle;
  amount_cents: number;
  currency: string;
  next_billing_at: string | null;
  current_period_start: string;
  current_period_end: string;
  auto_renew: boolean;
  billing_grace_days: number;
  nonpayment_policy: "SUSPEND_AFTER_GRACE" | "ALLOW_NATURAL_EXPIRATION";
  created_at: string;
  updated_at: string;
}

export interface BillingInvoice {
  id: string;
  subscription_id: string;
  license_id: string;
  customer_id: string;
  customer_name?: string;
  license_serial?: string;
  provider: BillingProviderName;
  provider_invoice_id: string | null;
  amount_cents: number;
  currency: string;
  status: BillingInvoiceStatus;
  due_at: string;
  paid_at: string | null;
  period_start: string;
  period_end: string;
  created_at: string;
  updated_at: string;
}

export interface BillingPayment {
  id: string;
  invoice_id: string;
  provider: BillingProviderName;
  provider_payment_id: string;
  amount_cents: number;
  currency: string;
  status: "PENDING" | "CONFIRMED" | "FAILED" | "REFUNDED";
  paid_at: string | null;
  metadata: Record<string, unknown>;
  created_at: string;
  updated_at: string;
}

export interface BillingSettings {
  billing_grace_days: number;
  nonpayment_policy: "SUSPEND_AFTER_GRACE" | "ALLOW_NATURAL_EXPIRATION";
  invoice_lead_days: number;
  updated_by: string | null;
  updated_at: string;
}

const pageLimit = (value: number | undefined) =>
  Math.max(1, Math.min(100, Math.trunc(value ?? 50)));
const pageOffset = (value: number | undefined) =>
  Math.max(0, Math.min(100_000, Math.trunc(value ?? 0)));

function requestFingerprint(values: unknown[]): string {
  return createHash("sha256").update(JSON.stringify(values)).digest("hex");
}

function mapInvoice<T extends BillingInvoice>(row: T): T {
  return {
    ...row,
    amount_cents: Number(row.amount_cents),
  };
}

export class BillingService {
  constructor(
    private readonly db: DatabaseClient,
    private readonly now: () => Date = () => new Date(),
    private readonly processLicenseArtifacts?: BillingArtifactProcessor,
  ) {}

  async getDashboard(): Promise<{
    active_subscriptions: number;
    open_invoices: number;
    overdue_invoices: number;
    due_invoices_7_days: number;
    due_invoices_1_day: number;
    confirmed_payments: number;
    failed_payments: number;
    confirmed_revenue_cents_period: number;
    revenue_currency: string | null;
    upcoming_renewals: Array<
      Pick<
        BillingSubscription,
        | "id"
        | "customer_id"
        | "customer_name"
        | "license_serial"
        | "billing_cycle"
        | "amount_cents"
        | "currency"
        | "next_billing_at"
      >
    >;
    past_due_subscriptions: number;
    billing_suspended_subscriptions: number;
    pending_notifications: number;
    open_reconciliation_findings: number;
  }> {
    const summary = await this.db.query<{
      active_subscriptions: number | string;
      open_invoices: number | string;
      overdue_invoices: number | string;
      due_invoices_7_days: number | string;
      due_invoices_1_day: number | string;
      confirmed_payments: number | string;
      failed_payments: number | string;
      confirmed_revenue_cents_period: number | string;
      revenue_currency: string | null;
      past_due_subscriptions: number | string;
      billing_suspended_subscriptions: number | string;
      pending_notifications: number | string;
      open_reconciliation_findings: number | string;
    }>(`select
        (select count(*)::int from control_plane.billing_subscriptions where status='ACTIVE') as active_subscriptions,
        (select count(*)::int from control_plane.billing_invoices where status='OPEN') as open_invoices,
        (select count(*)::int from control_plane.billing_invoices where status='OVERDUE') as overdue_invoices,
        (select count(*)::int from control_plane.billing_invoices where status='OPEN' and due_at between now() and now()+interval '7 days') as due_invoices_7_days,
        (select count(*)::int from control_plane.billing_invoices where status='OPEN' and due_at between now() and now()+interval '1 day') as due_invoices_1_day,
        (select count(*)::int from control_plane.billing_payments where status='CONFIRMED' and paid_at >= date_trunc('month',now())) as confirmed_payments,
        (select count(*)::int from control_plane.billing_payments where status='FAILED' and created_at >= date_trunc('month',now())) as failed_payments,
        (select coalesce(sum(case when status='CONFIRMED' then amount_cents else -amount_cents end),0)::bigint from control_plane.billing_payments where status in ('CONFIRMED','REFUNDED') and coalesce(paid_at,updated_at) >= date_trunc('month',now())) as confirmed_revenue_cents_period,
        (select case when count(distinct currency)=1 then min(currency) else null end from control_plane.billing_payments where status in ('CONFIRMED','REFUNDED') and coalesce(paid_at,updated_at) >= date_trunc('month',now())) as revenue_currency,
        (select count(*)::int from control_plane.billing_subscriptions where status='PAST_DUE') as past_due_subscriptions,
        (select count(*)::int from control_plane.billing_subscriptions where status='SUSPENDED' and suspended_for_nonpayment_at is not null) as billing_suspended_subscriptions,
        (select count(*)::int from control_plane.billing_notifications where status='PENDING') as pending_notifications,
        (select count(*)::int from control_plane.billing_reconciliation_findings where status='OPEN') as open_reconciliation_findings;`);
    const upcoming = await this.db.query<{
      id: string;
      customer_id: string;
      customer_name: string;
      license_serial: string;
      billing_cycle: BillingCycle;
      amount_cents: number | string;
      currency: string;
      next_billing_at: string;
    }>(`select s.id,s.customer_id,c.name as customer_name,l.serial as license_serial,s.billing_cycle,
         s.amount_cents,s.currency,s.next_billing_at
       from control_plane.billing_subscriptions s
       join control_plane.licensing_customers c on c.id=s.customer_id
       join control_plane.licensing_licenses l on l.id=s.license_id
       where s.status in ('ACTIVE','PAST_DUE') and s.next_billing_at is not null
         and s.next_billing_at <= now()+interval '45 days'
       order by s.next_billing_at asc limit 20;`);
    const row = summary.rows[0];
    return {
      active_subscriptions: Number(row?.active_subscriptions ?? 0),
      open_invoices: Number(row?.open_invoices ?? 0),
      overdue_invoices: Number(row?.overdue_invoices ?? 0),
      due_invoices_7_days: Number(row?.due_invoices_7_days ?? 0),
      due_invoices_1_day: Number(row?.due_invoices_1_day ?? 0),
      confirmed_payments: Number(row?.confirmed_payments ?? 0),
      failed_payments: Number(row?.failed_payments ?? 0),
      confirmed_revenue_cents_period: Number(row?.confirmed_revenue_cents_period ?? 0),
      revenue_currency: row?.revenue_currency ?? null,
      upcoming_renewals: upcoming.rows.map((item) => ({
        ...item,
        amount_cents: Number(item.amount_cents),
      })),
      past_due_subscriptions: Number(row?.past_due_subscriptions ?? 0),
      billing_suspended_subscriptions: Number(row?.billing_suspended_subscriptions ?? 0),
      pending_notifications: Number(row?.pending_notifications ?? 0),
      open_reconciliation_findings: Number(row?.open_reconciliation_findings ?? 0),
    };
  }

  async listInvoices(
    params: {
      status?: BillingInvoiceStatus;
      provider?: BillingProviderName;
      customer_id?: string;
      search?: string;
      due_before?: string;
      due_after?: string;
      limit?: number;
      offset?: number;
      sort?: "due_at" | "created_at" | "amount_cents" | "status";
      direction?: "asc" | "desc";
    } = {},
  ): Promise<BillingPage<BillingInvoice>> {
    const where: string[] = [];
    const values: unknown[] = [];
    const add = (sql: (index: number) => string, value: unknown) => {
      values.push(value);
      where.push(sql(values.length));
    };
    if (params.status) add((i) => `i.status=$${i}`, params.status);
    if (params.provider) add((i) => `i.provider=$${i}`, params.provider);
    if (params.customer_id) add((i) => `i.customer_id=$${i}::uuid`, params.customer_id);
    if (params.due_before) add((i) => `i.due_at <= $${i}::timestamptz`, params.due_before);
    if (params.due_after) add((i) => `i.due_at >= $${i}::timestamptz`, params.due_after);
    if (params.search?.trim()) {
      values.push(`%${params.search.trim().slice(0, 100)}%`);
      where.push(
        `(i.id::text ilike $${values.length} or i.provider_invoice_id ilike $${values.length} or l.serial ilike $${values.length} or c.name ilike $${values.length})`,
      );
    }
    const clause = where.length ? `where ${where.join(" and ")}` : "";
    const sortColumn = {
      due_at: "i.due_at",
      created_at: "i.created_at",
      amount_cents: "i.amount_cents",
      status: "i.status",
    }[params.sort ?? "due_at"];
    const direction = params.direction === "asc" ? "asc" : "desc";
    const limit = pageLimit(params.limit);
    const offset = pageOffset(params.offset);
    const [items, count] = await Promise.all([
      this.db.query<BillingInvoice>(
        `select i.*,c.name as customer_name,l.serial as license_serial
        from control_plane.billing_invoices i join control_plane.licensing_customers c on c.id=i.customer_id
        join control_plane.licensing_licenses l on l.id=i.license_id ${clause}
        order by ${sortColumn} ${direction},i.id asc limit $${values.length + 1} offset $${values.length + 2};`,
        [...values, limit, offset],
      ),
      this.db.query<{ total: number | string }>(
        `select count(*)::int as total from control_plane.billing_invoices i
        join control_plane.licensing_customers c on c.id=i.customer_id join control_plane.licensing_licenses l on l.id=i.license_id ${clause};`,
        values,
      ),
    ]);
    return {
      items: items.rows.map(mapInvoice),
      total: Number(count.rows[0]?.total ?? 0),
      limit,
      offset,
    };
  }

  async listSubscriptions(
    params: {
      status?: BillingSubscriptionStatus;
      provider?: BillingProviderName;
      customer_id?: string;
      search?: string;
      limit?: number;
      offset?: number;
    } = {},
  ): Promise<BillingPage<BillingSubscription>> {
    const values: unknown[] = [];
    const where: string[] = [];
    if (params.status) {
      values.push(params.status);
      where.push(`s.status=$${values.length}`);
    }
    if (params.provider) {
      values.push(params.provider);
      where.push(`s.provider=$${values.length}`);
    }
    if (params.customer_id) {
      values.push(params.customer_id);
      where.push(`s.customer_id=$${values.length}::uuid`);
    }
    if (params.search?.trim()) {
      values.push(`%${params.search.trim().slice(0, 100)}%`);
      where.push(
        `(c.name ilike $${values.length} or l.serial ilike $${values.length} or s.id::text ilike $${values.length})`,
      );
    }
    const clause = where.length ? `where ${where.join(" and ")}` : "";
    const limit = pageLimit(params.limit);
    const offset = pageOffset(params.offset);
    const [items, count] = await Promise.all([
      this.db.query<BillingSubscription>(
        `select s.*,c.name as customer_name,l.serial as license_serial
        from control_plane.billing_subscriptions s join control_plane.licensing_customers c on c.id=s.customer_id
        join control_plane.licensing_licenses l on l.id=s.license_id ${clause}
        order by s.next_billing_at asc nulls last,s.created_at desc limit $${values.length + 1} offset $${values.length + 2};`,
        [...values, limit, offset],
      ),
      this.db.query<{ total: number | string }>(
        `select count(*)::int as total from control_plane.billing_subscriptions s
        join control_plane.licensing_customers c on c.id=s.customer_id join control_plane.licensing_licenses l on l.id=s.license_id ${clause};`,
        values,
      ),
    ]);
    return {
      items: items.rows.map((item) => ({ ...item, amount_cents: Number(item.amount_cents) })),
      total: Number(count.rows[0]?.total ?? 0),
      limit,
      offset,
    };
  }

  async createSubscription(input: {
    customer_id: string;
    license_id: string;
    provider: BillingProviderName;
    billing_cycle: BillingCycle;
    amount_cents: number;
    currency: string;
    current_period_start: string;
    current_period_end: string;
    auto_renew: boolean;
    idempotency_key: string;
    actor_id: string;
    request_id: string;
  }): Promise<BillingSubscription> {
    if (input.provider !== "MANUAL")
      throw new Error("Only MANUAL billing is enabled in this release.");
    const fingerprint = requestFingerprint([
      input.customer_id,
      input.license_id,
      input.provider,
      input.billing_cycle,
      input.amount_cents,
      input.currency.toUpperCase(),
      input.current_period_start,
      input.current_period_end,
      input.auto_renew,
    ]);
    const result = await this.db.query<BillingSubscription>(
      `select * from control_plane.create_billing_subscription($1::uuid,$2::uuid,$3,$4,$5,$6,$7::timestamptz,$8::timestamptz,$9,$10,$11,$12,$13);`,
      [
        input.customer_id,
        input.license_id,
        input.provider,
        input.billing_cycle,
        input.amount_cents,
        input.currency.toUpperCase(),
        input.current_period_start,
        input.current_period_end,
        input.auto_renew,
        input.idempotency_key,
        fingerprint,
        input.actor_id,
        input.request_id,
      ],
    );
    if (!result.rows[0]) throw new Error("Billing subscription creation returned no record.");
    return result.rows[0];
  }

  async createInvoice(input: {
    subscription_id: string;
    due_at: string;
    idempotency_key: string;
    actor_id: string;
    request_id: string;
    actor_type?: "ADMIN" | "SYSTEM";
  }): Promise<BillingInvoice> {
    const fingerprint = requestFingerprint([input.subscription_id, input.due_at]);
    const result = await this.db.query<BillingInvoice>(
      `select * from control_plane.create_billing_invoice($1::uuid,$2::timestamptz,$3,$4,$5,$6,$7);`,
      [
        input.subscription_id,
        input.due_at,
        input.idempotency_key,
        fingerprint,
        input.actor_id,
        input.actor_type ?? "ADMIN",
        input.request_id,
      ],
    );
    if (!result.rows[0]) throw new Error("Invoice creation returned no record.");
    return mapInvoice(result.rows[0]);
  }

  async getInvoice(invoiceId: string): Promise<{
    invoice: BillingInvoice;
    subscription: BillingSubscription;
    customer: { id: string; name: string; billing_email: string };
    license: { id: string; serial: string; status: string; expires_at: string };
    payments: BillingPayment[];
    events: Array<Record<string, unknown>>;
  } | null> {
    const result = await this.db.query<
      BillingInvoice & {
        customer_email: string;
        customer_name: string;
        license_serial: string;
        sub_status: BillingSubscriptionStatus;
        billing_cycle: BillingCycle;
        auto_renew: boolean;
        next_billing_at: string | null;
        current_period_start: string;
        current_period_end: string;
        billing_grace_days: number;
        nonpayment_policy: BillingSubscription["nonpayment_policy"];
        license_status: string;
        license_expires_at: string;
        subscription_amount_cents: number | string;
      }
    >(
      `select i.*,c.name as customer_name,c.billing_email as customer_email,l.serial as license_serial,l.status as license_status,l.expires_at as license_expires_at,
        s.status as sub_status,s.billing_cycle,s.auto_renew,s.next_billing_at,s.current_period_start,s.current_period_end,s.billing_grace_days,s.nonpayment_policy,s.amount_cents as subscription_amount_cents
       from control_plane.billing_invoices i join control_plane.licensing_customers c on c.id=i.customer_id
       join control_plane.licensing_licenses l on l.id=i.license_id join control_plane.billing_subscriptions s on s.id=i.subscription_id where i.id=$1::uuid;`,
      [invoiceId],
    );
    const row = result.rows[0];
    if (!row) return null;
    const [payments, events] = await Promise.all([
      this.db.query<BillingPayment>(
        `select id,invoice_id,provider,provider_payment_id,amount_cents,currency,status,paid_at,metadata,created_at,updated_at from control_plane.billing_payments where invoice_id=$1::uuid order by created_at desc;`,
        [invoiceId],
      ),
      this.db.query<Record<string, unknown>>(
        `select event_id,event_type,actor_type,actor_id,provider_event_id,request_id,metadata,created_at from control_plane.billing_events where invoice_id=$1::uuid order by created_at desc limit 100;`,
        [invoiceId],
      ),
    ]);
    const invoice = mapInvoice(row);
    const subscription: BillingSubscription = {
      id: row.subscription_id,
      customer_id: row.customer_id,
      customer_name: row.customer_name,
      license_id: row.license_id,
      license_serial: row.license_serial!,
      provider: row.provider,
      status: row.sub_status,
      billing_cycle: row.billing_cycle,
      amount_cents: Number(row.subscription_amount_cents),
      currency: row.currency,
      next_billing_at: row.next_billing_at,
      current_period_start: row.current_period_start,
      current_period_end: row.current_period_end,
      auto_renew: row.auto_renew,
      billing_grace_days: row.billing_grace_days,
      nonpayment_policy: row.nonpayment_policy,
      created_at: row.created_at,
      updated_at: row.updated_at,
    };
    return {
      invoice,
      subscription,
      customer: { id: row.customer_id, name: row.customer_name, billing_email: row.customer_email },
      license: {
        id: row.license_id,
        serial: row.license_serial!,
        status: row.license_status,
        expires_at: row.license_expires_at,
      },
      payments: payments.rows.map((p) => ({ ...p, amount_cents: Number(p.amount_cents) })),
      events: events.rows,
    };
  }

  async confirmManualPayment(input: {
    invoice_id: string;
    idempotency_key: string;
    actor_id: string;
    request_id: string;
    reason?: string;
  }): Promise<{
    payment_id: string;
    invoice_id: string;
    subscription_id: string;
    license_id: string;
    expires_at: string;
    duplicate: boolean;
    license_reissue_status: "ISSUED" | "PENDING" | "NOT_REQUIRED" | "NOT_CONFIGURED";
    signed_artifacts_created: number;
    signed_artifacts_pending: number;
  }> {
    const detail = await this.getInvoice(input.invoice_id);
    if (!detail) throw new Error("Invoice not found.");
    if (detail.invoice.provider !== "MANUAL")
      throw new Error("Invoice is not payable through the manual provider.");
    const paymentId = `manual_${createHash("sha256").update(input.idempotency_key).digest("hex").slice(0, 40)}`;
    return this.confirmPayment({
      invoice_id: input.invoice_id,
      provider: "MANUAL",
      provider_payment_id: paymentId,
      provider_event_id: null,
      amount_cents: detail.invoice.amount_cents,
      currency: detail.invoice.currency,
      payload_sha256: null,
      actor_type: "ADMIN",
      actor_id: input.actor_id,
      reason: input.reason,
      request_id: input.request_id,
    });
  }

  async confirmProviderPayment(input: {
    event: BillingWebhookEvent;
    provider: Exclude<BillingProviderName, "MANUAL">;
    payload_sha256: string;
    request_id: string;
  }): Promise<{
    payment_id: string;
    invoice_id: string;
    subscription_id: string;
    license_id: string;
    expires_at: string;
    duplicate: boolean;
    license_reissue_status: "ISSUED" | "PENDING" | "NOT_REQUIRED" | "NOT_CONFIGURED";
    signed_artifacts_created: number;
    signed_artifacts_pending: number;
  }> {
    if (input.event.type === "payment.failed") {
      const failed = await this.recordProviderPaymentFailure(input);
      const detail = await this.getInvoice(input.event.invoice_id);
      if (!detail) throw new Error("Invoice not found.");
      return {
        payment_id: failed.payment_id,
        invoice_id: failed.invoice_id,
        subscription_id: detail.subscription.id,
        license_id: detail.license.id,
        expires_at: detail.license.expires_at,
        duplicate: failed.duplicate,
        license_reissue_status: "NOT_REQUIRED",
        signed_artifacts_created: 0,
        signed_artifacts_pending: 0,
      };
    }
    return this.confirmPayment({
      invoice_id: input.event.invoice_id,
      provider: input.provider,
      provider_payment_id: input.event.payment_id,
      provider_event_id: input.event.event_id,
      amount_cents: input.event.amount_cents,
      currency: input.event.currency,
      payload_sha256: input.payload_sha256,
      actor_type: "PROVIDER",
      actor_id: input.provider,
      request_id: input.request_id,
    });
  }

  private async recordProviderPaymentFailure(input: {
    event: BillingWebhookEvent;
    provider: Exclude<BillingProviderName, "MANUAL">;
    payload_sha256: string;
    request_id: string;
  }): Promise<{ payment_id: string; invoice_id: string; duplicate: boolean }> {
    const result = await this.db.query<{
      payment_id: string;
      invoice_id: string;
      duplicate: boolean;
    }>(
      `select * from control_plane.record_billing_payment_failure($1::uuid,$2,$3,$4,$5,$6,$7,$8);`,
      [
        input.event.invoice_id,
        input.provider,
        input.event.payment_id,
        input.event.event_id,
        input.event.amount_cents,
        input.event.currency.toUpperCase(),
        input.payload_sha256,
        input.request_id,
      ],
    );
    if (!result.rows[0]) throw new Error("Payment failure event returned no result.");
    return result.rows[0];
  }

  async isWebhookProviderReady(provider: Exclude<BillingProviderName, "MANUAL">): Promise<boolean> {
    if (!isBillingProviderEnabled(provider)) return false;
    const result = await this.db.query<{ ready: boolean }>(
      `select status='READY' and test_mode as ready from control_plane.billing_provider_accounts_metadata where provider=$1;`,
      [provider],
    );
    return result.rows[0]?.ready === true;
  }

  private async confirmPayment(input: {
    invoice_id: string;
    provider: BillingProviderName;
    provider_payment_id: string;
    provider_event_id: string | null;
    amount_cents: number;
    currency: string;
    payload_sha256: string | null;
    actor_type: "ADMIN" | "PROVIDER";
    actor_id: string;
    reason?: string;
    request_id: string;
  }): Promise<{
    payment_id: string;
    invoice_id: string;
    subscription_id: string;
    license_id: string;
    expires_at: string;
    duplicate: boolean;
    license_reissue_status: "ISSUED" | "PENDING" | "NOT_REQUIRED" | "NOT_CONFIGURED";
    signed_artifacts_created: number;
    signed_artifacts_pending: number;
  }> {
    const result = await this.db.query<{
      payment_id: string;
      invoice_id: string;
      subscription_id: string;
      license_id: string;
      expires_at: string;
      duplicate: boolean;
    }>(
      `select * from control_plane.confirm_billing_payment($1::uuid,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11);`,
      [
        input.invoice_id,
        input.provider,
        input.provider_payment_id,
        input.provider_event_id,
        input.amount_cents,
        input.currency.toUpperCase(),
        input.payload_sha256,
        input.actor_type,
        input.actor_id,
        input.reason ?? null,
        input.request_id,
      ],
    );
    if (!result.rows[0]) throw new Error("Payment confirmation returned no result.");
    const payment = result.rows[0];
    if (!this.processLicenseArtifacts) {
      return {
        ...payment,
        license_reissue_status: "NOT_CONFIGURED",
        signed_artifacts_created: 0,
        signed_artifacts_pending: 0,
      };
    }

    try {
      const artifacts = await this.processLicenseArtifacts({ licenseId: payment.license_id });
      return {
        ...payment,
        license_reissue_status:
          artifacts.pending > 0 || artifacts.failed > 0
            ? "PENDING"
            : artifacts.issued > 0
              ? "ISSUED"
              : "NOT_REQUIRED",
        signed_artifacts_created: artifacts.issued,
        signed_artifacts_pending: artifacts.pending,
      };
    } catch {
      const pending = await this.countPendingLicenseArtifacts(payment.license_id).catch(() => 1);
      return {
        ...payment,
        license_reissue_status: "PENDING",
        signed_artifacts_created: 0,
        signed_artifacts_pending: pending,
      };
    }
  }

  private async countPendingLicenseArtifacts(licenseId: string): Promise<number> {
    const result = await this.db.query<{ count: number | string }>(
      `select count(*)::int as count from control_plane.licensing_license_artifacts
        where license_id = $1::uuid and status in ('PENDING', 'PROCESSING');`,
      [licenseId],
    );
    return Number(result.rows[0]?.count ?? 0);
  }

  async cancelInvoice(
    invoiceId: string,
    reason: string,
    actorId: string,
    requestId: string,
  ): Promise<BillingInvoice> {
    const result = await this.db.query<BillingInvoice>(
      `select * from control_plane.cancel_billing_invoice($1::uuid,$2,$3,$4);`,
      [invoiceId, reason, actorId, requestId],
    );
    if (!result.rows[0]) throw new Error("Invoice cancellation returned no result.");
    return mapInvoice(result.rows[0]);
  }

  async refundPayment(
    paymentId: string,
    reason: string,
    actorId: string,
    requestId: string,
  ): Promise<BillingPayment> {
    const result = await this.db.query<BillingPayment>(
      `select * from control_plane.refund_billing_payment($1::uuid,$2,$3,$4);`,
      [paymentId, reason, actorId, requestId],
    );
    if (!result.rows[0]) throw new Error("Refund recording returned no result.");
    return { ...result.rows[0], amount_cents: Number(result.rows[0].amount_cents) };
  }

  async setAutoRenew(
    subscriptionId: string,
    autoRenew: boolean,
    actorId: string,
    requestId: string,
  ): Promise<BillingSubscription> {
    const result = await this.db.query<BillingSubscription>(
      `select * from control_plane.set_billing_auto_renew($1::uuid,$2,$3,$4);`,
      [subscriptionId, autoRenew, actorId, requestId],
    );
    if (!result.rows[0]) throw new Error("Subscription update returned no result.");
    return { ...result.rows[0], amount_cents: Number(result.rows[0].amount_cents) };
  }

  async getSettings(): Promise<BillingSettings> {
    const result = await this.db.query<BillingSettings>(
      `select billing_grace_days,nonpayment_policy,invoice_lead_days,updated_by,updated_at from control_plane.billing_settings where singleton;`,
    );
    if (!result.rows[0]) throw new Error("Billing settings are unavailable.");
    return result.rows[0];
  }

  async updateSettings(input: {
    billing_grace_days: number;
    nonpayment_policy: BillingSettings["nonpayment_policy"];
    invoice_lead_days: number;
    actor_id: string;
    request_id: string;
  }): Promise<BillingSettings> {
    const result = await this.db.query<BillingSettings>(
      `select * from control_plane.update_billing_settings($1,$2,$3,$4,$5);`,
      [
        input.billing_grace_days,
        input.nonpayment_policy,
        input.invoice_lead_days,
        input.actor_id,
        input.request_id,
      ],
    );
    if (!result.rows[0]) throw new Error("Billing settings update returned no result.");
    return result.rows[0];
  }

  async renewWithoutBilling(input: {
    license_id: string;
    duration_months?: number;
    duration_days?: number;
    new_expires_at?: string;
    renewal_basis?: "previous_expiration" | "today";
    new_maintenance_until?: string | null;
    reason: string;
    idempotency_key: string;
    actor_id: string;
    request_id: string;
  }): Promise<Record<string, unknown>> {
    const fingerprint = requestFingerprint([
      input.license_id,
      input.duration_months ?? null,
      input.duration_days ?? null,
      input.new_expires_at ?? null,
      input.renewal_basis ?? null,
      input.new_maintenance_until ?? null,
      input.reason.trim(),
    ]);
    const result = await this.db.query<Record<string, unknown>>(
      `select * from control_plane.renew_license_without_billing($1::uuid,$2,$3,$4::timestamptz,$5,$6::timestamptz,$7,$8,$9,$10,$11,$12);`,
      [
        input.license_id,
        input.duration_months ?? null,
        input.duration_days ?? null,
        input.new_expires_at ?? null,
        input.renewal_basis ?? null,
        input.new_maintenance_until ?? null,
        input.new_maintenance_until !== undefined,
        input.reason,
        input.idempotency_key,
        fingerprint,
        input.actor_id,
        input.request_id,
      ],
    );
    if (!result.rows[0]) throw new Error("No-charge renewal returned no license.");
    return result.rows[0];
  }

  async getCustomerSummary(customerId: string): Promise<Record<string, unknown>> {
    const [subscriptions, invoices, payments] = await Promise.all([
      this.listSubscriptions({ customer_id: customerId, limit: 100, offset: 0 }),
      this.listInvoices({ customer_id: customerId, limit: 10, offset: 0 }),
      this.db.query<BillingPayment>(
        `select p.* from control_plane.billing_payments p join control_plane.billing_invoices i on i.id=p.invoice_id where i.customer_id=$1::uuid order by p.created_at desc limit 10;`,
        [customerId],
      ),
    ]);
    return {
      subscriptions: subscriptions.items,
      invoices: invoices.items,
      payments: payments.rows.map((p) => ({ ...p, amount_cents: Number(p.amount_cents) })),
    };
  }

  async getLicenseSummary(licenseId: string): Promise<Record<string, unknown>> {
    const subscriptions = await this.db.query<BillingSubscription>(
      `select s.*,c.name as customer_name,l.serial as license_serial from control_plane.billing_subscriptions s join control_plane.licensing_customers c on c.id=s.customer_id join control_plane.licensing_licenses l on l.id=s.license_id where s.license_id=$1::uuid order by s.created_at desc;`,
      [licenseId],
    );
    const invoices = await this.db.query<BillingInvoice>(
      `select i.* from control_plane.billing_invoices i where i.license_id=$1::uuid order by i.created_at desc limit 20;`,
      [licenseId],
    );
    return {
      subscriptions: subscriptions.rows.map((s) => ({
        ...s,
        amount_cents: Number(s.amount_cents),
      })),
      invoices: invoices.rows.map(mapInvoice),
    };
  }

  async listEvents(
    params: { invoice_id?: string; customer_id?: string; limit?: number; offset?: number } = {},
  ): Promise<BillingPage<Record<string, unknown>>> {
    const values: unknown[] = [];
    const where: string[] = [];
    if (params.invoice_id) {
      values.push(params.invoice_id);
      where.push(`invoice_id=$${values.length}::uuid`);
    }
    if (params.customer_id) {
      values.push(params.customer_id);
      where.push(`customer_id=$${values.length}::uuid`);
    }
    const clause = where.length ? `where ${where.join(" and ")}` : "";
    const limit = pageLimit(params.limit);
    const offset = pageOffset(params.offset);
    const [items, count] = await Promise.all([
      this.db.query<Record<string, unknown>>(
        `select event_id,customer_id,license_id,subscription_id,invoice_id,payment_id,provider,provider_event_id,actor_type,actor_id,event_type,metadata,request_id,created_at from control_plane.billing_events ${clause} order by created_at desc limit $${values.length + 1} offset $${values.length + 2};`,
        [...values, limit, offset],
      ),
      this.db.query<{ total: number | string }>(
        `select count(*)::int as total from control_plane.billing_events ${clause};`,
        values,
      ),
    ]);
    return { items: items.rows, total: Number(count.rows[0]?.total ?? 0), limit, offset };
  }

  async runMaintenance(requestId?: string): Promise<{
    maintenance: unknown;
    reconciliation: unknown;
    license_artifacts: LicenseArtifactProcessingResult | null;
  }> {
    const maintenance = await this.db.query<{ summary: unknown }>(
      `select control_plane.run_billing_maintenance($1::timestamptz) as summary;`,
      [this.now().toISOString()],
    );
    const reconciliation = await this.db.query<{ summary: unknown }>(
      `select control_plane.reconcile_billing($1) as summary;`,
      [requestId ?? null],
    );
    await this.db.query(
      `insert into control_plane.billing_events(actor_type,event_type,metadata,request_id)
       values ('SYSTEM','BILLING_MAINTENANCE_RUN',$1::jsonb,$2),
              ('SYSTEM','BILLING_RECONCILIATION_RUN',$3::jsonb,$2);`,
      [
        JSON.stringify(maintenance.rows[0]?.summary ?? {}),
        requestId ?? null,
        JSON.stringify(reconciliation.rows[0]?.summary ?? {}),
      ],
    );
    const licenseArtifacts = this.processLicenseArtifacts
      ? await this.processLicenseArtifacts({ limit: 250 }).catch(() => ({
          issued: 0,
          pending: 1,
          superseded: 0,
          failed: 1,
        }))
      : null;
    return {
      maintenance: maintenance.rows[0]?.summary ?? {},
      reconciliation: reconciliation.rows[0]?.summary ?? {},
      license_artifacts: licenseArtifacts,
    };
  }

  async reconcileOnly(requestId?: string, actorId?: string): Promise<{ summary: unknown }> {
    const result = await this.db.query<{ summary: unknown }>(
      `select control_plane.reconcile_billing($1) as summary;`,
      [requestId ?? null],
    );
    const summary = result.rows[0]?.summary ?? {};
    await this.db.query(
      `insert into control_plane.billing_events(actor_type,actor_id,event_type,metadata,request_id)
       values ($1,$2,'BILLING_RECONCILIATION_RUN',$3::jsonb,$4)
       on conflict do nothing;`,
      [actorId ? "ADMIN" : "SYSTEM", actorId ?? null, JSON.stringify(summary), requestId ?? null],
    );
    return { summary };
  }
}
