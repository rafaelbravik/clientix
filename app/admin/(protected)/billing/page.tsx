"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { LicensingNav } from "@/components/admin/licensing/LicensingNav";
import { useT } from "@/hooks/i18n/useT";
import { useTagDeIdioma } from "@/hooks/i18n/useLocaleDeData";

interface BillingDashboard {
  active_subscriptions: number;
  open_invoices: number;
  overdue_invoices: number;
  due_invoices_7_days: number;
  due_invoices_1_day: number;
  confirmed_payments: number;
  failed_payments: number;
  confirmed_revenue_cents_period: number;
  revenue_currency: string | null;
  past_due_subscriptions: number;
  billing_suspended_subscriptions: number;
  pending_notifications: number;
  open_reconciliation_findings: number;
  upcoming_renewals: Array<{
    id: string;
    customer_name: string;
    license_serial: string;
    billing_cycle: string;
    amount_cents: number;
    currency: string;
    next_billing_at: string | null;
  }>;
  settings: { billing_grace_days: number; nonpayment_policy: string; invoice_lead_days: number };
  recent_events: Array<{
    event_id: string;
    event_type: string;
    created_at: string;
    metadata: Record<string, unknown>;
  }>;
}

const money = (cents: number, locale: string, currency = "BRL") =>
  (cents / 100).toLocaleString(locale, { style: "currency", currency });

function Metric({ title, value, hint }: { title: string; value: string | number; hint?: string }) {
  return (
    <article className="rounded-xl border bg-card p-5 shadow-sm">
      <h2 className="text-sm font-medium text-muted-foreground">{title}</h2>
      <p className="mt-3 text-2xl font-semibold tracking-tight tabular-nums">{value}</p>
      {hint && <p className="mt-1 text-xs text-muted-foreground">{hint}</p>}
    </article>
  );
}

export default function BillingDashboardPage() {
  const t = useT();
  const locale = useTagDeIdioma();
  const [data, setData] = useState<BillingDashboard | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [reconciling, setReconciling] = useState(false);
  const [notice, setNotice] = useState("");

  const load = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const response = await fetch("/api/v1/admin/billing/dashboard", { cache: "no-store" });
      if (!response.ok) throw new Error("O painel de cobrança não pôde ser carregado.");
      const json = (await response.json()) as { data?: BillingDashboard };
      setData(json.data ?? null);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Falha ao carregar cobrança.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    const timer = window.setTimeout(() => void load(), 0);
    return () => window.clearTimeout(timer);
  }, [load]);

  async function reconcile() {
    setReconciling(true);
    setNotice("");
    try {
      const response = await fetch("/api/v1/admin/billing/reconcile", { method: "POST" });
      if (!response.ok) throw new Error("Reconciliação não concluída.");
      setNotice("Reconciliação concluída. Divergências foram registradas para revisão.");
      await load();
    } catch (caught) {
      setNotice(caught instanceof Error ? caught.message : "Reconciliação não concluída.");
    } finally {
      setReconciling(false);
    }
  }

  return (
    <main className="mx-auto w-full max-w-7xl space-y-6 px-4 py-6 sm:px-6 lg:px-8">
      <LicensingNav />
      <header className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <p className="text-sm font-medium text-primary">{t("Operação comercial do Vendor")}</p>
          <h1 className="mt-1 text-3xl font-semibold tracking-tight">{t("Cobrança")}</h1>
          <p className="mt-2 max-w-2xl text-sm text-muted-foreground">
            {t(
              "Faturas, pagamentos e renovação de licenças em um painel interno. Nenhum dado financeiro é enviado ao runtime do cliente.",
            )}
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Link
            href="/admin/billing/invoices"
            className="rounded-md border px-4 py-2 text-sm font-medium hover:bg-muted"
          >
            Ver faturas
          </Link>
          <Link
            href="/admin/billing/new"
            className="rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:opacity-90"
          >
            {t("Nova cobrança")}
          </Link>
          <Link
            href="/admin/billing/settings"
            className="rounded-md border px-4 py-2 text-sm font-medium hover:bg-muted"
          >
            {t("Política")}
          </Link>
        </div>
      </header>
      {notice && (
        <p role="status" className="rounded-lg border border-primary/30 bg-primary/5 p-3 text-sm">
          {notice}
        </p>
      )}
      {error && (
        <div
          role="alert"
          className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-destructive/40 bg-destructive/5 p-4 text-sm"
        >
          <span>{error}</span>
          <button onClick={() => void load()} className="font-medium underline">
            Tentar novamente
          </button>
        </div>
      )}
      {loading ? (
        <div
          className="rounded-xl border p-10 text-center text-sm text-muted-foreground"
          role="status"
        >
          {t("Carregando dados de cobrança…")}
        </div>
      ) : data ? (
        <>
          <section
            className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4"
            aria-label={t("Indicadores de cobrança")}
          >
            <Metric title="Assinaturas ativas" value={data.active_subscriptions} />
            <Metric title="Faturas abertas" value={data.open_invoices} />
            <Metric
              title="Faturas vencidas"
              value={data.overdue_invoices}
              hint={`${data.past_due_subscriptions} assinaturas past due`}
            />
            <Metric
              title={t("Vencem em até 7 dias")}
              value={data.due_invoices_7_days}
              hint={`${data.due_invoices_1_day} vencem em até 24 horas`}
            />
            <Metric
              title={t("Pagamentos confirmados no mês")}
              value={data.confirmed_payments}
              hint={
                data.revenue_currency
                  ? money(data.confirmed_revenue_cents_period, data.revenue_currency)
                  : t("Receita não agregada entre moedas")
              }
            />
            <Metric title={t("Pagamentos falhos no mês")} value={data.failed_payments} />
            <Metric
              title="Assinaturas suspensas por billing"
              value={data.billing_suspended_subscriptions}
            />
            <Metric
              title={t("Notificações internas pendentes")}
              value={data.pending_notifications}
            />
            <Metric title={t("Divergências abertas")} value={data.open_reconciliation_findings} />
            <Metric
              title={t("Antecedência de fatura")}
              value={`${data.settings.invoice_lead_days} dias`}
              hint={`Tolerância de inadimplência: ${data.settings.billing_grace_days} dias`}
            />
          </section>
          <div className="grid gap-5 lg:grid-cols-[1.4fr_1fr]">
            <section className="overflow-hidden rounded-xl border bg-card">
              <div className="flex flex-wrap items-center justify-between gap-3 border-b p-5">
                <div>
                  <h2 className="font-semibold">{t("Próximas renovações")}</h2>
                  <p className="mt-1 text-sm text-muted-foreground">
                    Ciclo e valor registrados na assinatura.
                  </p>
                </div>
                <button
                  onClick={() => void reconcile()}
                  disabled={reconciling}
                  className="rounded-md border px-3 py-2 text-sm font-medium disabled:opacity-50"
                >
                  {reconciling ? "Verificando…" : t("Reconciliar agora")}
                </button>
              </div>
              {data.upcoming_renewals.length === 0 ? (
                <p className="p-6 text-sm text-muted-foreground">
                  {t("Nenhuma renovação próxima registrada.")}
                </p>
              ) : (
                <div className="overflow-x-auto">
                  <table className="w-full min-w-[600px] text-left text-sm">
                    <thead className="bg-muted/40 text-xs tracking-wide text-muted-foreground uppercase">
                      <tr>
                        <th className="px-5 py-3">{t("Cliente / licença")}</th>
                        <th className="px-5 py-3">Ciclo</th>
                        <th className="px-5 py-3">{t("Próxima cobrança")}</th>
                        <th className="px-5 py-3 text-right">Valor</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y">
                      {data.upcoming_renewals.map((item) => (
                        <tr key={item.id}>
                          <td className="px-5 py-4">
                            <p className="font-medium">{item.customer_name}</p>
                            <p className="mt-1 font-mono text-xs text-muted-foreground">
                              {item.license_serial}
                            </p>
                          </td>
                          <td className="px-5 py-4">{item.billing_cycle}</td>
                          <td className="px-5 py-4">
                            {item.next_billing_at
                              ? new Date(item.next_billing_at).toLocaleDateString(locale)
                              : "—"}
                          </td>
                          <td className="px-5 py-4 text-right tabular-nums">
                            {money(item.amount_cents, locale, item.currency)}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </section>
            <section className="rounded-xl border bg-card">
              <div className="border-b p-5">
                <h2 className="font-semibold">Atividade recente</h2>
                <p className="mt-1 text-sm text-muted-foreground">
                  {t("Eventos registrados no livro de cobrança.")}
                </p>
              </div>
              {data.recent_events.length === 0 ? (
                <p className="p-5 text-sm text-muted-foreground">
                  {t("Ainda não há eventos de billing.")}
                </p>
              ) : (
                <ol className="divide-y">
                  {data.recent_events.map((event) => (
                    <li key={event.event_id} className="p-4">
                      <p className="text-sm font-medium">{event.event_type}</p>
                      <time className="mt-1 block text-xs text-muted-foreground">
                        {new Date(event.created_at).toLocaleString(locale)}
                      </time>
                    </li>
                  ))}
                </ol>
              )}
            </section>
          </div>
          <p className="text-xs text-muted-foreground">
            {t(
              "Gateways externos estão desabilitados. O modo MANUAL registra confirmação administrativa; nenhuma credencial financeira é usada.",
            )}
          </p>
        </>
      ) : null}
    </main>
  );
}
