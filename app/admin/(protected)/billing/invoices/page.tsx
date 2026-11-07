"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { LicensingNav } from "@/components/admin/licensing/LicensingNav";
import { useT } from "@/hooks/i18n/useT";
import { useTagDeIdioma } from "@/hooks/i18n/useLocaleDeData";

interface Invoice {
  id: string;
  customer_name: string;
  license_serial: string;
  provider: string;
  amount_cents: number;
  currency: string;
  status: "OPEN" | "PAID" | "OVERDUE" | "CANCELLED" | "REFUNDED";
  due_at: string;
  paid_at: string | null;
  created_at: string;
}

const badge: Record<Invoice["status"], string> = {
  OPEN: "border-sky-500/30 bg-sky-500/10 text-sky-700 dark:text-sky-300",
  PAID: "border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300",
  OVERDUE: "border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-300",
  CANCELLED: "border-muted bg-muted text-muted-foreground",
  REFUNDED: "border-violet-500/30 bg-violet-500/10 text-violet-700 dark:text-violet-300",
};

export default function BillingInvoicesPage() {
  const t = useT();
  const locale = useTagDeIdioma();
  const [items, setItems] = useState<Invoice[]>([]);
  const [total, setTotal] = useState(0);
  const [status, setStatus] = useState("ALL");
  const [search, setSearch] = useState("");
  const [offset, setOffset] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const limit = 25;

  const load = useCallback(
    async (nextOffset = 0) => {
      setLoading(true);
      setError("");
      const query = new URLSearchParams({
        limit: String(limit),
        offset: String(nextOffset),
        sort: "due_at",
        direction: "asc",
      });
      if (status !== "ALL") query.set("status", status);
      if (search.trim()) query.set("search", search.trim());
      try {
        const response = await fetch(`/api/v1/admin/billing/invoices?${query}`, {
          cache: "no-store",
        });
        if (!response.ok) throw new Error("Não foi possível carregar as faturas.");
        const json = (await response.json()) as { data?: Invoice[]; meta?: { total?: number } };
        setItems(json.data ?? []);
        setTotal(json.meta?.total ?? 0);
        setOffset(nextOffset);
      } catch (caught) {
        setError(caught instanceof Error ? caught.message : "Falha ao carregar as faturas.");
      } finally {
        setLoading(false);
      }
    },
    [search, status],
  );

  useEffect(() => {
    const timer = window.setTimeout(() => void load(0), 0);
    return () => window.clearTimeout(timer);
  }, [load]);
  const hasPrevious = offset > 0;
  const hasNext = offset + items.length < total;

  return (
    <main className="mx-auto w-full max-w-7xl space-y-6 px-4 py-6 sm:px-6 lg:px-8">
      <LicensingNav />
      <header className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <Link href="/admin/billing" className="text-sm text-primary hover:underline">
            {t("Cobrança")}
          </Link>
          <h1 className="mt-2 text-3xl font-semibold tracking-tight">Faturas</h1>
          <p className="mt-2 text-sm text-muted-foreground">
            {t("Histórico paginado das cobranças comerciais do Vendor.")}
          </p>
        </div>
        <Link
          href="/admin/billing/new"
          className="rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground"
        >
          {t("Nova cobrança")}
        </Link>
      </header>
      <section className="flex flex-col gap-3 rounded-xl border bg-card p-4 sm:flex-row">
        <label className="flex-1">
          <span className="mb-1 block text-xs font-medium text-muted-foreground">
            Buscar cliente, serial ou ID
          </span>
          <input
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            className="h-10 w-full rounded-md border bg-background px-3 text-sm"
            placeholder={t("Digite para buscar")}
          />
        </label>
        <label className="w-full sm:w-56">
          <span className="mb-1 block text-xs font-medium text-muted-foreground">Status</span>
          <select
            value={status}
            onChange={(event) => setStatus(event.target.value)}
            className="h-10 w-full rounded-md border bg-background px-3 text-sm"
          >
            <option value="ALL">{t("Todos os status")}</option>
            <option>OPEN</option>
            <option>OVERDUE</option>
            <option>PAID</option>
            <option>REFUNDED</option>
            <option>CANCELLED</option>
          </select>
        </label>
      </section>
      {error && (
        <div
          role="alert"
          className="rounded-lg border border-destructive/40 bg-destructive/5 p-4 text-sm"
        >
          {error}{" "}
          <button onClick={() => void load(offset)} className="ml-2 font-medium underline">
            Tentar novamente
          </button>
        </div>
      )}
      <section className="overflow-hidden rounded-xl border bg-card">
        <div className="flex items-center justify-between border-b px-5 py-4">
          <h2 className="font-semibold">{t("Todas as faturas")}</h2>
          <span className="text-sm text-muted-foreground">{total} registros</span>
        </div>
        {loading ? (
          <p role="status" className="p-8 text-center text-sm text-muted-foreground">
            Carregando faturas…
          </p>
        ) : items.length === 0 ? (
          <p className="p-10 text-center text-sm text-muted-foreground">
            {t("Nenhuma fatura encontrada para este filtro.")}
          </p>
        ) : (
          <>
            <div className="space-y-3 p-3 sm:hidden">
              {items.map((invoice) => (
                <article key={invoice.id} className="space-y-3 rounded-lg border p-4">
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <p className="font-medium break-words">{invoice.customer_name}</p>
                      <p className="mt-1 font-mono text-xs text-muted-foreground">
                        {invoice.license_serial}
                      </p>
                    </div>
                    <span
                      className={`inline-flex shrink-0 rounded-full border px-2.5 py-1 text-xs font-medium ${badge[invoice.status]}`}
                    >
                      {invoice.status}
                    </span>
                  </div>
                  <dl className="grid grid-cols-2 gap-3 text-sm">
                    <div>
                      <dt className="text-xs text-muted-foreground">Provedor</dt>
                      <dd className="mt-1">{invoice.provider}</dd>
                    </div>
                    <div>
                      <dt className="text-xs text-muted-foreground">Vencimento</dt>
                      <dd className="mt-1">
                        {new Date(invoice.due_at).toLocaleDateString(locale)}
                      </dd>
                    </div>
                    <div>
                      <dt className="text-xs text-muted-foreground">Valor</dt>
                      <dd className="mt-1 tabular-nums">
                        {(invoice.amount_cents / 100).toLocaleString(locale, {
                          style: "currency",
                          currency: invoice.currency,
                        })}
                      </dd>
                    </div>
                  </dl>
                  <Link
                    href={`/admin/billing/invoices/${invoice.id}`}
                    className="inline-flex min-h-10 items-center font-medium text-primary hover:underline"
                  >
                    Abrir fatura
                  </Link>
                </article>
              ))}
            </div>
            <div className="hidden overflow-x-auto sm:block">
              <table className="w-full min-w-[760px] text-left text-sm">
                <thead className="bg-muted/40 text-xs tracking-wide text-muted-foreground uppercase">
                  <tr>
                    <th className="px-5 py-3">{t("Cliente / licença")}</th>
                    <th className="px-5 py-3">Provedor</th>
                    <th className="px-5 py-3">Vencimento</th>
                    <th className="px-5 py-3">Status</th>
                    <th className="px-5 py-3 text-right">Valor</th>
                    <th className="px-5 py-3">
                      <span className="sr-only">{t("Ação")}</span>
                    </th>
                  </tr>
                </thead>
                <tbody className="divide-y">
                  {items.map((invoice) => (
                    <tr key={invoice.id} className="hover:bg-muted/20">
                      <td className="px-5 py-4">
                        <p className="font-medium">{invoice.customer_name}</p>
                        <p className="mt-1 font-mono text-xs text-muted-foreground">
                          {invoice.license_serial}
                        </p>
                      </td>
                      <td className="px-5 py-4">{invoice.provider}</td>
                      <td className="px-5 py-4">
                        {new Date(invoice.due_at).toLocaleDateString(locale)}
                      </td>
                      <td className="px-5 py-4">
                        <span
                          className={`inline-flex rounded-full border px-2.5 py-1 text-xs font-medium ${badge[invoice.status]}`}
                        >
                          {invoice.status}
                        </span>
                      </td>
                      <td className="px-5 py-4 text-right tabular-nums">
                        {(invoice.amount_cents / 100).toLocaleString(locale, {
                          style: "currency",
                          currency: invoice.currency,
                        })}
                      </td>
                      <td className="px-5 py-4 text-right">
                        <Link
                          href={`/admin/billing/invoices/${invoice.id}`}
                          className="font-medium text-primary hover:underline"
                        >
                          Abrir
                        </Link>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </>
        )}
        <footer className="flex items-center justify-between border-t px-5 py-3 text-sm">
          <span className="text-muted-foreground">
            {total === 0 ? 0 : offset + 1}–{Math.min(offset + items.length, total)} de {total}
          </span>
          <div className="flex gap-2">
            <button
              disabled={!hasPrevious || loading}
              onClick={() => void load(Math.max(0, offset - limit))}
              className="rounded-md border px-3 py-1.5 disabled:opacity-40"
            >
              Anterior
            </button>
            <button
              disabled={!hasNext || loading}
              onClick={() => void load(offset + limit)}
              className="rounded-md border px-3 py-1.5 disabled:opacity-40"
            >
              {t("Próxima")}
            </button>
          </div>
        </footer>
      </section>
    </main>
  );
}
