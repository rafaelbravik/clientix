"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { randomId } from "@/lib/random-id";
import { LicensingNav } from "@/components/admin/licensing/LicensingNav";
import { useT } from "@/hooks/i18n/useT";
import { useTagDeIdioma } from "@/hooks/i18n/useLocaleDeData";

interface Customer {
  id: string;
  name: string;
  billing_email?: string;
}
interface License {
  id: string;
  customer_id: string;
  customer_name: string;
  serial: string;
  plan: string;
  status: string;
  valid_from: string;
  expires_at: string;
}
interface ApiList<T> {
  data?: T[];
}

function localDateTime(date: Date) {
  const adjusted = new Date(date.getTime() - date.getTimezoneOffset() * 60_000);
  return adjusted.toISOString().slice(0, 16);
}

export default function NewBillingPage() {
  const t = useT();
  const locale = useTagDeIdioma();
  const router = useRouter();
  const [customers, setCustomers] = useState<Customer[]>([]);
  const [licenses, setLicenses] = useState<License[]>([]);
  const [customerId, setCustomerId] = useState("");
  const [licenseId, setLicenseId] = useState("");
  const [cycle, setCycle] = useState("ANNUAL");
  const [amount, setAmount] = useState("");
  const [currency, setCurrency] = useState("BRL");
  const [dueAt, setDueAt] = useState(() => localDateTime(new Date(Date.now() + 7 * 86_400_000)));
  const [autoRenew, setAutoRenew] = useState(true);
  const [loadingData, setLoadingData] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");
  const [keys] = useState(() => ({
    subscription: randomId(),
    invoice: randomId(),
  }));

  useEffect(() => {
    let active = true;
    void Promise.all([
      fetch("/api/v1/admin/licensing/customers?limit=100&sort=name&direction=asc", {
        cache: "no-store",
      }),
      fetch("/api/v1/admin/licenses?limit=100&sort=expires_at&direction=asc", {
        cache: "no-store",
      }),
    ])
      .then(async ([customerResponse, licenseResponse]) => {
        if (!customerResponse.ok || !licenseResponse.ok)
          throw new Error(t("Não foi possível carregar clientes e licenças."));
        const [customerJson, licenseJson] = (await Promise.all([
          customerResponse.json(),
          licenseResponse.json(),
        ])) as [ApiList<Customer>, ApiList<License>];
        if (!active) return;
        setCustomers(customerJson.data ?? []);
        setLicenses(licenseJson.data ?? []);
      })
      .catch((caught) =>
        setError(caught instanceof Error ? caught.message : t("Falha ao carregar dados.")),
      )
      .finally(() => {
        if (active) setLoadingData(false);
      });
    return () => {
      active = false;
    };
  }, [t]);

  const customerOptions = useMemo(
    () =>
      customers.filter((customer) =>
        licenses.some((license) => license.customer_id === customer.id),
      ),
    [customers, licenses],
  );
  const customerLicenses = useMemo(
    () => licenses.filter((license) => !customerId || license.customer_id === customerId),
    [licenses, customerId],
  );
  const selectedLicense = licenses.find((license) => license.id === licenseId);

  async function createBilling() {
    setError("");
    const amountCents = Math.round(Number(amount.replace(",", ".")) * 100);
    if (
      !customerId ||
      !licenseId ||
      !Number.isSafeInteger(amountCents) ||
      amountCents < 0 ||
      !dueAt
    ) {
      setError(t("Selecione cliente e licença, informe um valor válido e uma data de vencimento."));
      return;
    }
    setSubmitting(true);
    try {
      const now = new Date();
      const selectedEnd = selectedLicense ? new Date(selectedLicense.expires_at) : now;
      const periodEnd = selectedEnd > now ? selectedEnd : now;
      const periodStart = selectedLicense ? new Date(selectedLicense.valid_from) : now;
      const safeStart =
        periodStart < periodEnd ? periodStart : new Date(periodEnd.getTime() - 60_000);
      const subscriptionResponse = await fetch("/api/v1/admin/billing/subscriptions", {
        method: "POST",
        headers: { "Content-Type": "application/json", "Idempotency-Key": keys.subscription },
        body: JSON.stringify({
          customer_id: customerId,
          license_id: licenseId,
          provider: "MANUAL",
          billing_cycle: cycle,
          amount_cents: amountCents,
          currency,
          current_period_start: safeStart.toISOString(),
          current_period_end: periodEnd.toISOString(),
          auto_renew: autoRenew,
        }),
      });
      const subscriptionJson = (await subscriptionResponse.json()) as {
        data?: { id: string };
        error?: { message?: string };
      };
      if (!subscriptionResponse.ok || !subscriptionJson.data?.id)
        throw new Error(subscriptionJson.error?.message || "Assinatura não pôde ser criada.");
      const invoiceResponse = await fetch("/api/v1/admin/billing/invoices", {
        method: "POST",
        headers: { "Content-Type": "application/json", "Idempotency-Key": keys.invoice },
        body: JSON.stringify({
          subscription_id: subscriptionJson.data.id,
          due_at: new Date(dueAt).toISOString(),
        }),
      });
      const invoiceJson = (await invoiceResponse.json()) as {
        data?: { id: string };
        error?: { message?: string };
      };
      if (!invoiceResponse.ok || !invoiceJson.data?.id)
        throw new Error(
          invoiceJson.error?.message ||
            "Assinatura criada, mas a fatura ainda não foi criada. Reenvie para concluir sem duplicar a assinatura.",
        );
      router.push(`/admin/billing/invoices/${invoiceJson.data.id}`);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Não foi possível criar a cobrança.");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <main className="mx-auto w-full max-w-4xl space-y-6 px-4 py-6 sm:px-6 lg:px-8">
      <LicensingNav />
      <header>
        <Link href="/admin/billing" className="text-sm text-primary hover:underline">
          {t("Cobrança")}
        </Link>
        <h1 className="mt-2 text-3xl font-semibold tracking-tight">{t("Nova cobrança")}</h1>
        <p className="mt-2 text-sm text-muted-foreground">
          {t("Crie uma assinatura comercial MANUAL e a primeira fatura de renovação.")}
        </p>
      </header>
      {error && (
        <p
          role="alert"
          className="rounded-lg border border-destructive/40 bg-destructive/5 p-3 text-sm"
        >
          {error}
        </p>
      )}
      {loadingData ? (
        <p
          role="status"
          className="rounded-xl border p-8 text-center text-sm text-muted-foreground"
        >
          {t("Carregando clientes e licenças…")}
        </p>
      ) : (
        <section className="space-y-5 rounded-xl border bg-card p-5 sm:p-7">
          <div className="grid gap-4 sm:grid-cols-2">
            <label className="block space-y-1.5 text-sm font-medium">
              Cliente
              <select
                value={customerId}
                onChange={(event) => {
                  setCustomerId(event.target.value);
                  setLicenseId("");
                }}
                className="h-11 w-full rounded-md border bg-background px-3 font-normal"
              >
                <option value="">Selecione um cliente</option>
                {customerOptions.map((customer) => (
                  <option key={customer.id} value={customer.id}>
                    {customer.name}
                  </option>
                ))}
              </select>
            </label>
            <label className="block space-y-1.5 text-sm font-medium">
              {t("Licença")}
              <select
                value={licenseId}
                onChange={(event) => setLicenseId(event.target.value)}
                disabled={!customerId}
                className="h-11 w-full rounded-md border bg-background px-3 font-normal"
              >
                <option value="">{t("Selecione uma licença")}</option>
                {customerLicenses.map((license) => (
                  <option key={license.id} value={license.id}>
                    {license.serial} · {license.plan} · {license.status}
                  </option>
                ))}
              </select>
            </label>
            {selectedLicense && (
              <div className="rounded-md bg-muted/40 p-3 text-sm sm:col-span-2">
                <span className="font-medium">Plano licenciado: </span>
                {selectedLicense.plan}
                <span className="mx-2 text-muted-foreground">·</span>
                <span className="font-medium">Validade atual: </span>
                {new Date(selectedLicense.expires_at).toLocaleDateString(locale)}
              </div>
            )}
            <label className="space-y-1.5 text-sm font-medium">
              Ciclo
              <select
                value={cycle}
                onChange={(event) => setCycle(event.target.value)}
                className="h-11 w-full rounded-md border bg-background px-3 font-normal"
              >
                <option value="MONTHLY">Mensal</option>
                <option value="QUARTERLY">Trimestral</option>
                <option value="SEMIANNUAL">Semestral</option>
                <option value="ANNUAL">Anual</option>
              </select>
            </label>
            <label className="space-y-1.5 text-sm font-medium">
              Valor por ciclo
              <input
                type="number"
                min="0"
                step="0.01"
                value={amount}
                onChange={(event) => setAmount(event.target.value)}
                placeholder="0,00"
                className="h-11 w-full rounded-md border bg-background px-3 font-normal"
              />
            </label>
            <label className="space-y-1.5 text-sm font-medium">
              Moeda
              <select
                value={currency}
                onChange={(event) => setCurrency(event.target.value)}
                className="h-11 w-full rounded-md border bg-background px-3 font-normal"
              >
                <option value="BRL">BRL · Real</option>
                <option value="USD">{t("USD · Dólar")}</option>
                <option value="EUR">EUR · Euro</option>
              </select>
            </label>
            <label className="space-y-1.5 text-sm font-medium">
              Vencimento da primeira fatura
              <input
                type="datetime-local"
                value={dueAt}
                onChange={(event) => setDueAt(event.target.value)}
                className="h-11 w-full rounded-md border bg-background px-3 font-normal"
              />
            </label>
          </div>
          <label className="flex items-center gap-3 rounded-md border p-3 text-sm">
            <input
              type="checkbox"
              checked={autoRenew}
              onChange={(event) => setAutoRenew(event.target.checked)}
              className="h-4 w-4"
            />
            <span>
              <span className="block font-medium">{t("Agendar renovação automática")}</span>
              <span className="text-xs text-muted-foreground">
                {t("Gera as próximas faturas no Control Plane. O pagamento continua manual.")}
              </span>
            </span>
          </label>
          <div className="flex flex-wrap items-center justify-between gap-3 border-t pt-4">
            <p className="max-w-xl text-xs text-muted-foreground">
              {t(
                "Nenhum gateway externo está conectado. O status pago só será definido por confirmação administrativa explícita.",
              )}
            </p>
            <button
              onClick={() => void createBilling()}
              disabled={submitting || loadingData}
              className="rounded-md bg-primary px-5 py-2.5 text-sm font-semibold text-primary-foreground disabled:opacity-50"
            >
              {submitting ? "Criando…" : "Criar assinatura e fatura"}
            </button>
          </div>
        </section>
      )}
    </main>
  );
}
