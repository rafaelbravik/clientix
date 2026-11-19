"use client";

import { useEffect, useState, type FormEvent } from "react";
import { useT } from "@/hooks/i18n/useT";

type Plan = { slug: string; name: string };
type SubscriptionStatus = "trialing" | "active" | "past_due" | "canceled" | "suspended" | "expired";
type BillingInterval = "monthly" | "annual" | "custom";
type Subscription = {
  plan_slug: string;
  status: SubscriptionStatus;
  billing_interval: BillingInterval;
  price_cents: number | null;
  currency: string;
  current_period_starts_at: string;
  current_period_ends_at: string;
  trial_ends_at: string | null;
  cancel_at_period_end: boolean;
};
type Feedback = { kind: "success" | "error"; message: string } | null;

function dataLocal(iso: string): string {
  const date = new Date(iso);
  if (!Number.isFinite(date.getTime())) return "";
  return new Date(date.getTime() - date.getTimezoneOffset() * 60_000).toISOString().slice(0, 16);
}

function dataIso(value: string): string {
  return new Date(value).toISOString();
}

function inicioAgora(): string {
  return dataLocal(new Date().toISOString());
}

function fimDoPeriodo(interval: BillingInterval): string {
  const date = new Date();
  if (interval === "annual") date.setFullYear(date.getFullYear() + 1);
  else if (interval === "monthly") date.setMonth(date.getMonth() + 1);
  else date.setMonth(date.getMonth() + 1);
  return dataLocal(date.toISOString());
}

function statusLabel(status: SubscriptionStatus): string {
  const labels: Record<SubscriptionStatus, string> = {
    trialing: "Em teste",
    active: "Ativa",
    past_due: "Em atraso",
    canceled: "Cancelada",
    suspended: "Suspensa",
    expired: "Encerrada",
  };
  return labels[status];
}

export function OwnerSubscriptionManager({ organizationId }: { organizationId: string }) {
  const t = useT();
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [plans, setPlans] = useState<Plan[]>([]);
  const [subscription, setSubscription] = useState<Subscription | null>(null);
  const [plan, setPlan] = useState("standard");
  const [status, setStatus] = useState<SubscriptionStatus>("active");
  const [billingInterval, setBillingInterval] = useState<BillingInterval>("monthly");
  const [amount, setAmount] = useState("");
  const [currency, setCurrency] = useState("BRL");
  const [periodStartsAt, setPeriodStartsAt] = useState(inicioAgora());
  const [periodEndsAt, setPeriodEndsAt] = useState(fimDoPeriodo("monthly"));
  const [trialEndsAt, setTrialEndsAt] = useState("");
  const [cancelAtPeriodEnd, setCancelAtPeriodEnd] = useState(false);
  const [feedback, setFeedback] = useState<Feedback>(null);

  useEffect(() => {
    let active = true;
    async function load() {
      if (!organizationId) {
        setSubscription(null);
        setPlans([]);
        return;
      }
      setLoading(true);
      setFeedback(null);
      try {
        const response = await fetch(`/api/v1/owner/tenants/${organizationId}/subscription`, {
          cache: "no-store",
        });
        const payload = (await response.json()) as {
          data?: { plan: string; subscription: Subscription | null; plans: Plan[] };
          error?: { message?: string };
        };
        if (!response.ok || !payload.data) throw new Error(payload.error?.message ?? t("Não foi possível carregar a assinatura."));
        if (!active) return;
        const current = payload.data.subscription;
        setPlans(payload.data.plans);
        setSubscription(current);
        setPlan(current?.plan_slug ?? payload.data.plan);
        setStatus(current?.status ?? "active");
        setBillingInterval(current?.billing_interval ?? "monthly");
        setAmount(current?.price_cents === null || current?.price_cents === undefined ? "" : (current.price_cents / 100).toFixed(2));
        setCurrency(current?.currency ?? "BRL");
        setPeriodStartsAt(current ? dataLocal(current.current_period_starts_at) : inicioAgora());
        setPeriodEndsAt(current ? dataLocal(current.current_period_ends_at) : fimDoPeriodo("monthly"));
        setTrialEndsAt(current?.trial_ends_at ? dataLocal(current.trial_ends_at) : "");
        setCancelAtPeriodEnd(current?.cancel_at_period_end ?? false);
      } catch (error) {
        if (active) setFeedback({ kind: "error", message: error instanceof Error ? error.message : t("Não foi possível carregar a assinatura.") });
      } finally {
        if (active) setLoading(false);
      }
    }
    void load();
    return () => { active = false; };
  }, [organizationId, t]);

  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!organizationId) return;
    const normalizedAmount = amount.trim().replace(",", ".");
    const parsedAmount = normalizedAmount === "" ? null : Number(normalizedAmount);
    if (parsedAmount !== null && (!Number.isFinite(parsedAmount) || parsedAmount < 0 || parsedAmount > 9_999_999_999)) {
      setFeedback({ kind: "error", message: t("Informe um preço válido.") });
      return;
    }
    setSaving(true);
    setFeedback(null);
    try {
      const response = await fetch(`/api/v1/owner/tenants/${organizationId}/subscription`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          plan_slug: plan,
          status,
          billing_interval: billingInterval,
          price_cents: parsedAmount === null ? null : Math.round(parsedAmount * 100),
          currency,
          current_period_starts_at: dataIso(periodStartsAt),
          current_period_ends_at: dataIso(periodEndsAt),
          trial_ends_at: status === "trialing" && trialEndsAt ? dataIso(trialEndsAt) : null,
          cancel_at_period_end: cancelAtPeriodEnd,
        }),
      });
      const payload = (await response.json()) as { error?: { message?: string } };
      if (!response.ok) throw new Error(payload.error?.message ?? t("Não foi possível salvar a assinatura."));
      setFeedback({ kind: "success", message: t("Assinatura salva. As cotas do plano já foram aplicadas.") });
      const refreshed = await fetch(`/api/v1/owner/tenants/${organizationId}/subscription`, { cache: "no-store" });
      const refreshedPayload = (await refreshed.json()) as { data?: { subscription: Subscription | null } };
      if (refreshed.ok && refreshedPayload.data) setSubscription(refreshedPayload.data.subscription);
    } catch (error) {
      setFeedback({ kind: "error", message: error instanceof Error ? error.message : t("Não foi possível salvar a assinatura.") });
    } finally {
      setSaving(false);
    }
  }

  return (
    <section aria-labelledby="owner-subscription-title" className="space-y-4 rounded-lg border p-5">
      <div>
        <h2 id="owner-subscription-title" className="text-xl font-semibold">{t("Assinatura da empresa")}</h2>
        <p className="mt-1 text-sm text-muted-foreground">
          {subscription ? `${t("Status atual")}: ${t(statusLabel(subscription.status))}` : t("Esta empresa ainda não tem uma assinatura registrada.")}
        </p>
        <p className="mt-2 text-sm text-muted-foreground">
          {t("O plano controla cotas e módulos. A cobrança é manual nesta versão; nenhum pagamento é processado automaticamente.")}
        </p>
      </div>

      {!organizationId ? (
        <p className="rounded-md bg-muted/50 p-3 text-sm">{t("Selecione uma empresa para ver ou alterar a assinatura.")}</p>
      ) : loading ? (
        <p role="status" className="text-sm text-muted-foreground">{t("Carregando assinatura…")}</p>
      ) : (
        <form onSubmit={save} className="grid gap-4 sm:grid-cols-2" data-testid="tenant-subscription-form">
          <label className="grid gap-1 text-sm">
            {t("Plano")}
            <select value={plan} onChange={(event) => setPlan(event.target.value)} required className="rounded-md border bg-background px-3 py-2">
              {plans.map((item) => <option key={item.slug} value={item.slug}>{item.name} · {item.slug}</option>)}
            </select>
          </label>
          <label className="grid gap-1 text-sm">
            {t("Status da assinatura")}
            <select value={status} onChange={(event) => setStatus(event.target.value as SubscriptionStatus)} className="rounded-md border bg-background px-3 py-2">
              {(["trialing", "active", "past_due", "canceled", "suspended", "expired"] as const).map((value) => <option key={value} value={value}>{t(statusLabel(value))}</option>)}
            </select>
          </label>
          <label className="grid gap-1 text-sm">
            {t("Ciclo de cobrança")}
            <select value={billingInterval} onChange={(event) => setBillingInterval(event.target.value as BillingInterval)} className="rounded-md border bg-background px-3 py-2">
              <option value="monthly">{t("Mensal")}</option>
              <option value="annual">{t("Anual")}</option>
              <option value="custom">{t("Personalizado")}</option>
            </select>
          </label>
          <label className="grid gap-1 text-sm">
            {t("Preço acordado")}
            <div className="flex gap-2">
              <input aria-label={t("Moeda ISO de 3 letras")} value={currency} onChange={(event) => setCurrency(event.target.value.toUpperCase())} maxLength={3} pattern="[A-Z]{3}" required className="w-20 rounded-md border bg-background px-3 py-2" />
              <input aria-label={t("Preço em unidades da moeda")} type="number" min="0" step="0.01" value={amount} onChange={(event) => setAmount(event.target.value)} placeholder={t("Não informado")} className="min-w-0 flex-1 rounded-md border bg-background px-3 py-2" />
            </div>
          </label>
          <label className="grid gap-1 text-sm">
            {t("Período iniciado em")}
            <input type="datetime-local" value={periodStartsAt} onChange={(event) => setPeriodStartsAt(event.target.value)} required className="rounded-md border bg-background px-3 py-2" />
          </label>
          <label className="grid gap-1 text-sm">
            {t("Período válido até")}
            <input type="datetime-local" value={periodEndsAt} onChange={(event) => setPeriodEndsAt(event.target.value)} required className="rounded-md border bg-background px-3 py-2" />
          </label>
          {status === "trialing" && (
            <label className="grid gap-1 text-sm">
              {t("Teste válido até")}
              <input type="datetime-local" value={trialEndsAt} onChange={(event) => setTrialEndsAt(event.target.value)} required className="rounded-md border bg-background px-3 py-2" />
            </label>
          )}
          {(status === "active" || status === "past_due") && (
            <label className="flex items-center gap-2 self-end rounded-md border p-3 text-sm">
              <input type="checkbox" checked={cancelAtPeriodEnd} onChange={(event) => setCancelAtPeriodEnd(event.target.checked)} />
              {t("Encerrar no fim do período")}
            </label>
          )}
          <p className="text-xs text-muted-foreground sm:col-span-2">
            {t("Quando a assinatura termina, novos usuários, canais e módulos pagos são bloqueados. Os dados existentes continuam acessíveis.")}
          </p>
          <button type="submit" disabled={saving || plans.length === 0} className="rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground disabled:opacity-50 sm:col-span-2">
            {saving ? t("Salvando…") : t("Salvar assinatura")}
          </button>
        </form>
      )}

      {feedback && (
        <p role={feedback.kind === "error" ? "alert" : "status"} className={feedback.kind === "error" ? "text-sm text-destructive" : "text-sm text-foreground"}>
          {feedback.message}
        </p>
      )}
    </section>
  );
}
