"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { useParams } from "next/navigation";
import { randomId } from "@/lib/random-id";
import { LicensingNav } from "@/components/admin/licensing/LicensingNav";
import { useT } from "@/hooks/i18n/useT";
import { useTagDeIdioma } from "@/hooks/i18n/useLocaleDeData";

interface InvoiceDetail {
  invoice: {
    id: string;
    subscription_id: string;
    license_id: string;
    customer_id: string;
    provider: string;
    amount_cents: number;
    currency: string;
    status: string;
    due_at: string;
    paid_at: string | null;
    period_start: string;
    period_end: string;
    created_at: string;
  };
  subscription: {
    id: string;
    status: string;
    billing_cycle: string;
    auto_renew: boolean;
    next_billing_at: string | null;
    amount_cents: number;
    currency: string;
    billing_grace_days: number;
    nonpayment_policy: string;
  };
  customer: { id: string; name: string };
  license: { id: string; serial: string; status: string; expires_at: string };
  payments: Array<{
    id: string;
    provider_payment_id: string;
    status: string;
    amount_cents: number;
    currency: string;
    paid_at: string | null;
    created_at: string;
    metadata: Record<string, unknown>;
  }>;
  events: Array<{
    event_id: string;
    event_type: string;
    actor_type: string;
    created_at: string;
    metadata: Record<string, unknown>;
  }>;
}

type Action = { kind: "pay" } | { kind: "cancel" } | { kind: "refund"; paymentId: string };
const statusClass: Record<string, string> = {
  OPEN: "border-sky-500/30 bg-sky-500/10 text-sky-700 dark:text-sky-300",
  PAID: "border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300",
  OVERDUE: "border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-300",
  CANCELLED: "border-muted bg-muted text-muted-foreground",
  REFUNDED: "border-violet-500/30 bg-violet-500/10 text-violet-700 dark:text-violet-300",
};
const money = (cents: number, currency: string, locale: string) =>
  (cents / 100).toLocaleString(locale, { style: "currency", currency });

export default function BillingInvoiceDetailPage() {
  const t = useT();
  const locale = useTagDeIdioma();
  const params = useParams();
  const id = params?.id as string;
  const [detail, setDetail] = useState<InvoiceDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [action, setAction] = useState<Action | null>(null);
  const [reason, setReason] = useState("");
  const [idempotencyKey, setIdempotencyKey] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [notice, setNotice] = useState("");

  const load = useCallback(async () => {
    if (!id) return;
    setLoading(true);
    setError("");
    try {
      const response = await fetch(`/api/v1/admin/billing/invoices/${id}`, { cache: "no-store" });
      if (!response.ok) throw new Error("Detalhes da fatura indisponíveis.");
      const json = (await response.json()) as { data?: InvoiceDetail };
      setDetail(json.data ?? null);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Falha ao carregar fatura.");
    } finally {
      setLoading(false);
    }
  }, [id]);

  useEffect(() => {
    const timer = window.setTimeout(() => void load(), 0);
    return () => window.clearTimeout(timer);
  }, [load]);

  function openAction(next: Action) {
    setAction(next);
    setReason("");
    setIdempotencyKey(next.kind === "pay" ? randomId() : "");
  }

  async function submitAction() {
    if (!action || !detail) return;
    setSubmitting(true);
    setError("");
    try {
      let url = "";
      let body: Record<string, unknown>;
      const headers: Record<string, string> = { "Content-Type": "application/json" };
      if (action.kind === "pay") {
        url = `/api/v1/admin/billing/invoices/${detail.invoice.id}/confirm-payment`;
        headers["Idempotency-Key"] = idempotencyKey;
        body = { confirm: true, reason: reason.trim() || undefined };
      } else if (action.kind === "cancel") {
        url = `/api/v1/admin/billing/invoices/${detail.invoice.id}/cancel`;
        body = { confirm: true, reason: reason.trim() };
      } else {
        url = `/api/v1/admin/billing/payments/${action.paymentId}/refund`;
        body = { confirm: true, reason: reason.trim() };
      }
      const response = await fetch(url, { method: "POST", headers, body: JSON.stringify(body) });
      const json = (await response.json()) as { error?: { message?: string } };
      if (!response.ok) throw new Error(json.error?.message || "A ação não pôde ser concluída.");
      setAction(null);
      setIdempotencyKey("");
      setNotice(
        action.kind === "pay"
          ? "Pagamento manual confirmado e renovação processada."
          : action.kind === "cancel"
            ? "Fatura cancelada."
            : "Estorno registrado. A licença não foi revogada automaticamente.",
      );
      await load();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Falha ao processar a ação.");
    } finally {
      setSubmitting(false);
    }
  }

  async function toggleAutoRenew() {
    if (!detail) return;
    const nextValue = !detail.subscription.auto_renew;
    if (
      !window.confirm(
        nextValue
          ? "Ativar o agendamento de próximas faturas?"
          : "Cancelar a renovação automática? A licença continuará válida até o vencimento atual.",
      )
    )
      return;
    const response = await fetch(
      `/api/v1/admin/billing/subscriptions/${detail.subscription.id}/auto-renew`,
      {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ auto_renew: nextValue, confirm: true }),
      },
    );
    if (!response.ok) {
      setError("Não foi possível atualizar a renovação automática.");
      return;
    }
    setNotice(nextValue ? "Renovação automática agendada." : "Renovação automática cancelada.");
    await load();
  }

  return (
    <main className="mx-auto w-full max-w-6xl space-y-6 px-4 py-6 sm:px-6 lg:px-8">
      <LicensingNav />
      <header className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <Link href="/admin/billing/invoices" className="text-sm text-primary hover:underline">
            Faturas
          </Link>
          <h1 className="mt-2 text-3xl font-semibold tracking-tight">{t("Detalhe da fatura")}</h1>
          {detail && (
            <p className="mt-2 font-mono text-xs text-muted-foreground">{detail.invoice.id}</p>
          )}
        </div>
        {detail && (
          <span
            className={`inline-flex rounded-full border px-3 py-1.5 text-sm font-medium ${statusClass[detail.invoice.status] ?? ""}`}
          >
            {detail.invoice.status}
          </span>
        )}
      </header>
      {notice && (
        <p
          role="status"
          className="rounded-lg border border-emerald-500/30 bg-emerald-500/5 p-3 text-sm"
        >
          {notice}
        </p>
      )}
      {error && (
        <p
          role="alert"
          className="rounded-lg border border-destructive/40 bg-destructive/5 p-3 text-sm"
        >
          {error}
        </p>
      )}
      {loading ? (
        <p
          role="status"
          className="rounded-xl border p-10 text-center text-sm text-muted-foreground"
        >
          Carregando fatura…
        </p>
      ) : detail ? (
        <>
          <section className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            <article className="rounded-xl border bg-card p-4">
              <p className="text-xs text-muted-foreground">Cliente</p>
              <Link
                href={`/admin/customers/${detail.customer.id}`}
                className="mt-2 block font-semibold text-primary hover:underline"
              >
                {detail.customer.name}
              </Link>
            </article>
            <article className="rounded-xl border bg-card p-4">
              <p className="text-xs text-muted-foreground">{t("Licença")}</p>
              <Link
                href={`/admin/licenses/${detail.license.id}`}
                className="mt-2 block font-mono font-semibold text-primary hover:underline"
              >
                {detail.license.serial}
              </Link>
              <p className="mt-1 text-xs text-muted-foreground">
                {detail.license.status} {t("· válida até")}{" "}
                {new Date(detail.license.expires_at).toLocaleDateString(locale)}
              </p>
            </article>
            <article className="rounded-xl border bg-card p-4">
              <p className="text-xs text-muted-foreground">Valor</p>
              <p className="mt-2 text-xl font-semibold tabular-nums">
                {money(detail.invoice.amount_cents, detail.invoice.currency, locale)}
              </p>
              <p className="mt-1 text-xs text-muted-foreground">
                Provedor: {detail.invoice.provider}
              </p>
            </article>
            <article className="rounded-xl border bg-card p-4">
              <p className="text-xs text-muted-foreground">Vencimento</p>
              <p className="mt-2 font-semibold">
                {new Date(detail.invoice.due_at).toLocaleString(locale)}
              </p>
              <p className="mt-1 text-xs text-muted-foreground">
                Ciclo {detail.subscription.billing_cycle}
              </p>
            </article>
          </section>
          <section className="flex flex-wrap items-center justify-between gap-3 rounded-xl border bg-card p-4">
            <div>
              <p className="font-medium">{t("Renovação da assinatura")}</p>
              <p className="mt-1 text-sm text-muted-foreground">
                Status {detail.subscription.status} {t("· próxima data")}{" "}
                {detail.subscription.next_billing_at
                  ? new Date(detail.subscription.next_billing_at).toLocaleDateString(locale)
                  : t("não agendada")}
              </p>
            </div>
            <button
              onClick={() => void toggleAutoRenew()}
              className="rounded-md border px-4 py-2 text-sm font-medium"
            >
              {detail.subscription.auto_renew
                ? t("Cancelar renovação automática")
                : t("Agendar renovação automática")}
            </button>
          </section>
          {["OPEN", "OVERDUE"].includes(detail.invoice.status) && (
            <section className="flex flex-wrap gap-2 rounded-xl border bg-card p-4">
              <button
                onClick={() => openAction({ kind: "pay" })}
                disabled={detail.invoice.provider !== "MANUAL"}
                className="rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground disabled:opacity-40"
              >
                Marcar pagamento confirmado
              </button>
              <button
                onClick={() => openAction({ kind: "cancel" })}
                className="rounded-md border px-4 py-2 text-sm font-medium"
              >
                Cancelar fatura
              </button>
              {detail.invoice.provider !== "MANUAL" && (
                <span className="self-center text-xs text-muted-foreground">
                  {t("Confirmação externa indisponível enquanto o gateway estiver desabilitado.")}
                </span>
              )}
            </section>
          )}
          <div className="grid gap-5 lg:grid-cols-2">
            <section className="overflow-hidden rounded-xl border bg-card">
              <div className="border-b p-5">
                <h2 className="font-semibold">Pagamentos</h2>
                <p className="mt-1 text-sm text-muted-foreground">
                  {t("Sem dados de cartão ou credenciais de gateway.")}
                </p>
              </div>
              {detail.payments.length === 0 ? (
                <p className="p-5 text-sm text-muted-foreground">
                  {t("Nenhum pagamento registrado.")}
                </p>
              ) : (
                <ul className="divide-y">
                  {detail.payments.map((payment) => (
                    <li
                      key={payment.id}
                      className="flex flex-wrap items-center justify-between gap-3 p-4"
                    >
                      <div>
                        <p className="font-medium">
                          {payment.status} · {money(payment.amount_cents, payment.currency, locale)}
                        </p>
                        <p className="mt-1 font-mono text-xs text-muted-foreground">
                          {payment.provider_payment_id}
                        </p>
                        <p className="mt-1 text-xs text-muted-foreground">
                          {payment.paid_at
                            ? new Date(payment.paid_at).toLocaleString(locale)
                            : t("Sem confirmação de pagamento")}
                        </p>
                      </div>
                      {payment.status === "CONFIRMED" && (
                        <button
                          onClick={() => openAction({ kind: "refund", paymentId: payment.id })}
                          className="rounded-md border px-3 py-1.5 text-sm"
                        >
                          Registrar estorno
                        </button>
                      )}
                    </li>
                  ))}
                </ul>
              )}
            </section>
            <section className="overflow-hidden rounded-xl border bg-card">
              <div className="border-b p-5">
                <h2 className="font-semibold">{t("Histórico financeiro")}</h2>
                <p className="mt-1 text-sm text-muted-foreground">
                  {t("Eventos auditáveis desta fatura.")}
                </p>
              </div>
              {detail.events.length === 0 ? (
                <p className="p-5 text-sm text-muted-foreground">
                  {t("Nenhum evento registrado.")}
                </p>
              ) : (
                <ol className="divide-y">
                  {detail.events.map((event) => (
                    <li key={event.event_id} className="p-4">
                      <p className="font-medium">{event.event_type}</p>
                      <p className="mt-1 text-xs text-muted-foreground">
                        {event.actor_type} · {new Date(event.created_at).toLocaleString(locale)}
                      </p>
                    </li>
                  ))}
                </ol>
              )}
            </section>
          </div>
          {action && (
            <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4">
              <section
                role="dialog"
                aria-modal="true"
                aria-labelledby="billing-action-title"
                className="w-full max-w-lg space-y-4 rounded-xl border bg-card p-6 shadow-xl"
              >
                <div>
                  <h2 id="billing-action-title" className="text-lg font-semibold">
                    {action.kind === "pay"
                      ? "Confirmar pagamento manual"
                      : action.kind === "cancel"
                        ? "Cancelar fatura"
                        : "Registrar estorno"}
                  </h2>
                  <p className="mt-1 text-sm text-muted-foreground">
                    {action.kind === "pay"
                      ? t("Confirme somente após validar o recebimento fora do sistema.")
                      : action.kind === "cancel"
                        ? t("Esta ação será auditada e não poderá ser desfeita automaticamente.")
                        : t("O estorno registra o estado financeiro e não revoga a licença.")}
                  </p>
                </div>
                <label className="block space-y-1.5 text-sm font-medium">
                  {action.kind === "pay" ? t("Observação (opcional)") : t("Motivo obrigatório")}
                  <textarea
                    value={reason}
                    onChange={(event) => setReason(event.target.value)}
                    maxLength={500}
                    rows={3}
                    className="w-full rounded-md border bg-background p-3 font-normal"
                    placeholder={t("Registre o motivo ou referência operacional")}
                  />
                </label>
                <div className="flex justify-end gap-2 border-t pt-4">
                  <button
                    onClick={() => setAction(null)}
                    disabled={submitting}
                    className="rounded-md border px-4 py-2 text-sm"
                  >
                    Voltar
                  </button>
                  <button
                    onClick={() => void submitAction()}
                    disabled={submitting || (action.kind !== "pay" && !reason.trim())}
                    className="rounded-md bg-primary px-4 py-2 text-sm font-semibold text-primary-foreground disabled:opacity-50"
                  >
                    {submitting ? "Processando…" : t("Confirmar ação")}
                  </button>
                </div>
              </section>
            </div>
          )}
        </>
      ) : null}
    </main>
  );
}
