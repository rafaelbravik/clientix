"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { useT } from "@/hooks/i18n/useT";
import { useTagDeIdioma } from "@/hooks/i18n/useLocaleDeData";

interface Summary {
  subscriptions?: Array<{
    id: string;
    provider: string;
    status: string;
    billing_cycle: string;
    amount_cents: number;
    currency: string;
    next_billing_at: string | null;
    auto_renew: boolean;
  }>;
  invoices?: Array<{
    id: string;
    status: string;
    amount_cents: number;
    currency: string;
    due_at: string;
  }>;
  payments?: Array<{
    id: string;
    status: string;
    amount_cents: number;
    currency: string;
    paid_at: string | null;
  }>;
}

export function BillingSummary({ kind, id }: { kind: "customers" | "licenses"; id: string }) {
  const t = useT();
  const locale = useTagDeIdioma();
  const [summary, setSummary] = useState<Summary | null>(null);
  const [error, setError] = useState(false);

  useEffect(() => {
    let active = true;
    void fetch(`/api/v1/admin/billing/${kind}/${id}`, { cache: "no-store" })
      .then(async (response) => {
        if (!response.ok) throw new Error("billing summary unavailable");
        const json = (await response.json()) as { data?: Summary };
        if (active) setSummary(json.data ?? {});
      })
      .catch(() => {
        if (active) setError(true);
      });
    return () => {
      active = false;
    };
  }, [id, kind]);

  const subscriptions = summary?.subscriptions ?? [];
  const invoices = summary?.invoices ?? [];
  const payments = summary?.payments ?? [];

  return (
    <section
      className="space-y-4 rounded-lg border bg-card p-5"
      aria-labelledby="billing-summary-title"
    >
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 id="billing-summary-title" className="text-base font-semibold">
            {t("Cobrança")}
          </h2>
          <p className="text-sm text-muted-foreground">Dados comerciais internos do Vendor.</p>
        </div>
        <Link href="/admin/billing" className="text-sm font-medium text-primary hover:underline">
          {t("Abrir painel de cobrança")}
        </Link>
      </div>
      {error ? (
        <p role="status" className="text-sm text-muted-foreground">
          {t("Resumo de cobrança indisponível.")}
        </p>
      ) : !summary ? (
        <p role="status" className="text-sm text-muted-foreground">
          {t("Carregando cobrança…")}
        </p>
      ) : (
        <div className="grid gap-4 sm:grid-cols-3">
          <div className="rounded-md border p-3">
            <p className="text-xs text-muted-foreground">Assinaturas</p>
            <p className="mt-1 font-semibold">{subscriptions.length}</p>
            {subscriptions.slice(0, 2).map((subscription) => (
              <p key={subscription.id} className="mt-1 text-xs text-muted-foreground">
                {subscription.status} · {subscription.billing_cycle} ·{" "}
                {subscription.auto_renew ? t("renovação automática") : t("sem renovação")}
              </p>
            ))}
          </div>
          <div className="rounded-md border p-3">
            <p className="text-xs text-muted-foreground">Faturas recentes</p>
            <p className="mt-1 font-semibold">{invoices.length}</p>
            {invoices.slice(0, 2).map((invoice) => (
              <Link
                key={invoice.id}
                href={`/admin/billing/invoices/${invoice.id}`}
                className="mt-1 block text-xs text-primary hover:underline"
              >
                {invoice.status} ·{" "}
                {(invoice.amount_cents / 100).toLocaleString(locale, {
                  style: "currency",
                  currency: invoice.currency,
                })}
              </Link>
            ))}
          </div>
          <div className="rounded-md border p-3">
            <p className="text-xs text-muted-foreground">Pagamentos recentes</p>
            <p className="mt-1 font-semibold">{payments.length}</p>
            {payments.slice(0, 2).map((payment) => (
              <p key={payment.id} className="mt-1 text-xs text-muted-foreground">
                {payment.status} ·{" "}
                {(payment.amount_cents / 100).toLocaleString(locale, {
                  style: "currency",
                  currency: payment.currency,
                })}
              </p>
            ))}
          </div>
        </div>
      )}
    </section>
  );
}
