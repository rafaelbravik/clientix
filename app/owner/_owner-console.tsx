"use client";

import { useState, type FormEvent } from "react";
import { useT } from "@/hooks/i18n/useT";
import { copyToClipboard } from "@/lib/clipboard";
import { randomId } from "@/lib/random-id";
import { OwnerSubscriptionManager } from "./_subscription-manager";

type Tenant = { id: string; slug: string; display_name: string };
type Invitation = { accept_url?: string; email_dispatched?: boolean; expires_at?: string };
type OwnerApiPayload = {
  data?:
    | {
        id?: string;
        slug?: string;
        display_name?: string;
        invitation?: Invitation;
        owner_invitation?: Invitation | null;
      }
    | Tenant[];
  error?: { message?: string };
};

type Feedback = { kind: "success" | "error"; message: string } | null;

function dataLocal(date: Date): string {
  return new Date(date.getTime() - date.getTimezoneOffset() * 60_000).toISOString().slice(0, 16);
}

function defaultPeriodEnd(interval: "monthly" | "annual" | "custom"): string {
  const date = new Date();
  if (interval === "annual") date.setFullYear(date.getFullYear() + 1);
  else date.setMonth(date.getMonth() + 1);
  return dataLocal(date);
}

export function OwnerConsole({ ownerEmail }: { ownerEmail: string }) {
  const t = useT();
  const [tenants, setTenants] = useState<Tenant[]>([]);
  const [selectedTenantId, setSelectedTenantId] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [slug, setSlug] = useState("");
  const [plan, setPlan] = useState<"standard" | "pro" | "enterprise" | "">("");
  const [billingInterval, setBillingInterval] = useState<"monthly" | "annual" | "custom">(
    "monthly",
  );
  const [subscriptionAmount, setSubscriptionAmount] = useState("");
  const [periodEndsAt, setPeriodEndsAt] = useState(defaultPeriodEnd("monthly"));
  const [tenantOwnerEmail, setTenantOwnerEmail] = useState("");
  const [inviteEmail, setInviteEmail] = useState("");
  const [inviteRole, setInviteRole] = useState<"viewer" | "agent" | "manager" | "admin">("agent");
  const [inviteUrl, setInviteUrl] = useState<string | null>(null);
  const [ownerInvitation, setOwnerInvitation] = useState<Invitation | null>(null);
  const [busy, setBusy] = useState(false);
  const [feedback, setFeedback] = useState<Feedback>(null);

  async function readPayload(response: Response): Promise<OwnerApiPayload> {
    try {
      return (await response.json()) as OwnerApiPayload;
    } catch {
      return {};
    }
  }

  async function loadTenants() {
    setBusy(true);
    setFeedback(null);
    try {
      const response = await fetch("/api/v1/admin/tenants?limit=100", { cache: "no-store" });
      const payload = await readPayload(response);
      if (!response.ok || !Array.isArray(payload.data)) {
        setFeedback({
          kind: "error",
          message: payload.error?.message ?? "Não foi possível carregar as empresas.",
        });
        return;
      }
      const items = payload.data as Tenant[];
      setTenants(items);
      setSelectedTenantId((current) =>
        items.some((tenant) => tenant.id === current) ? current : (items[0]?.id ?? ""),
      );
    } catch {
      setFeedback({ kind: "error", message: "Não foi possível falar com o servidor." });
    } finally {
      setBusy(false);
    }
  }

  async function createTenant(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!plan) {
      setFeedback({ kind: "error", message: "Selecione um plano para esta empresa." });
      return;
    }
    const normalizedAmount = subscriptionAmount.trim().replace(",", ".");
    const parsedAmount = normalizedAmount === "" ? null : Number(normalizedAmount);
    if (
      parsedAmount !== null &&
      (!Number.isFinite(parsedAmount) || parsedAmount < 0 || parsedAmount > 9_999_999_999)
    ) {
      setFeedback({ kind: "error", message: "Informe um preço válido." });
      return;
    }
    const periodEnd = new Date(periodEndsAt);
    if (!Number.isFinite(periodEnd.getTime()) || periodEnd <= new Date()) {
      setFeedback({
        kind: "error",
        message: "O período da assinatura precisa terminar no futuro.",
      });
      return;
    }
    setBusy(true);
    setFeedback(null);
    setOwnerInvitation(null);
    try {
      const response = await fetch("/api/v1/admin/tenants", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Idempotency-Key": randomId(),
        },
        body: JSON.stringify({
          display_name: displayName,
          slug,
          plan,
          owner_email: tenantOwnerEmail,
          subscription: {
            status: "active",
            billing_interval: billingInterval,
            price_cents: parsedAmount === null ? null : Math.round(parsedAmount * 100),
            currency: "BRL",
            current_period_starts_at: new Date().toISOString(),
            current_period_ends_at: periodEnd.toISOString(),
            trial_ends_at: null,
            cancel_at_period_end: false,
          },
        }),
      });
      const payload = await readPayload(response);
      if (!response.ok || !payload.data || Array.isArray(payload.data)) {
        setFeedback({
          kind: "error",
          message: payload.error?.message ?? "Não foi possível criar a empresa.",
        });
        return;
      }
      const created: Tenant = {
        id: payload.data.id ?? "",
        slug: payload.data.slug ?? slug,
        display_name: payload.data.display_name ?? displayName,
      };
      if (created.id) {
        setTenants((current) => [created, ...current.filter((tenant) => tenant.id !== created.id)]);
        setSelectedTenantId(created.id);
      }
      setOwnerInvitation(payload.data.owner_invitation ?? null);
      setDisplayName("");
      setSlug("");
      setPlan("");
      setTenantOwnerEmail("");
      setFeedback({ kind: "success", message: `Empresa ${created.display_name} criada.` });
    } catch {
      setFeedback({ kind: "error", message: "Não foi possível falar com o servidor." });
    } finally {
      setBusy(false);
    }
  }

  async function inviteUser(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!selectedTenantId) {
      setFeedback({
        kind: "error",
        message: "Crie ou selecione uma empresa antes de convidar alguém.",
      });
      return;
    }
    setBusy(true);
    setFeedback(null);
    setInviteUrl(null);
    try {
      const response = await fetch("/api/v1/admin/users", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          organization_id: selectedTenantId,
          email: inviteEmail,
          role: inviteRole,
        }),
      });
      const payload = await readPayload(response);
      if (!response.ok || !payload.data || Array.isArray(payload.data)) {
        setFeedback({
          kind: "error",
          message: payload.error?.message ?? "Não foi possível criar o convite.",
        });
        return;
      }
      const invitation = payload.data.invitation;
      if (invitation?.accept_url) setInviteUrl(invitation.accept_url);
      setInviteEmail("");
      setFeedback({
        kind: "success",
        message: invitation?.email_dispatched
          ? "Convite enviado. A vaga será consumida quando a pessoa aceitar."
          : "Convite criado. A vaga será consumida quando a pessoa aceitar.",
      });
    } catch {
      setFeedback({ kind: "error", message: "Não foi possível falar com o servidor." });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-8">
      <header className="space-y-2">
        <p className="text-sm font-medium text-muted-foreground">{ownerEmail}</p>
        <h1 className="text-3xl font-semibold tracking-tight">{t("Painel do proprietário")}</h1>
        <p className="max-w-2xl text-sm text-muted-foreground">
          {t(
            "Crie empresas nesta instalação e convide usuários dentro do limite do plano e da licença. Gerencie a licença local em",
          )}{" "}
          <a className="underline" href="/admin/license">
            {t("Licença")}
          </a>
          .
        </p>
      </header>
      <section aria-labelledby="owner-tenants-title" className="space-y-4 rounded-lg border p-5">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h2 id="owner-tenants-title" className="text-xl font-semibold">
              Empresas
            </h2>
            <p className="text-sm text-muted-foreground">
              {t("A criação respeita o limite global da licença.")}
            </p>
          </div>
          <button
            type="button"
            onClick={() => void loadTenants()}
            disabled={busy}
            className="rounded-md border px-4 py-2 text-sm font-medium disabled:opacity-50"
          >
            Atualizar empresas
          </button>
        </div>
        <ul aria-label={t("Empresas desta instalação")} className="space-y-2">
          {tenants.map((tenant) => (
            <li key={tenant.id} className="rounded-md bg-muted/50 px-3 py-2 text-sm">
              <span className="font-medium">{tenant.display_name}</span>{" "}
              <span className="text-muted-foreground">({tenant.slug})</span>
            </li>
          ))}
        </ul>
        <form onSubmit={createTenant} className="grid gap-4 sm:grid-cols-2">
          <h3 className="text-base font-semibold sm:col-span-2">Criar empresa</h3>
          <label className="grid gap-1 text-sm">
            Nome da empresa
            <input
              value={displayName}
              onChange={(event) => setDisplayName(event.target.value)}
              minLength={2}
              maxLength={120}
              required
              className="rounded-md border bg-background px-3 py-2"
            />
          </label>
          <label className="grid gap-1 text-sm">
            Identificador
            <input
              value={slug}
              onChange={(event) => setSlug(event.target.value)}
              pattern="[a-z0-9-]+"
              minLength={2}
              maxLength={40}
              required
              className="rounded-md border bg-background px-3 py-2"
            />
          </label>
          <label className="grid gap-1 text-sm">
            Plano
            <select
              value={plan}
              onChange={(event) => setPlan(event.target.value as typeof plan)}
              required
              className="rounded-md border bg-background px-3 py-2"
            >
              <option value="" disabled>
                {t("Selecione um plano")}
              </option>
              <option value="standard">Standard</option>
              <option value="pro">Pro</option>
              <option value="enterprise">Enterprise</option>
            </select>
          </label>
          <label className="grid gap-1 text-sm">
            {t("Ciclo de cobrança")}
            <select
              value={billingInterval}
              onChange={(event) => {
                const next = event.target.value as typeof billingInterval;
                setBillingInterval(next);
                setPeriodEndsAt(defaultPeriodEnd(next));
              }}
              className="rounded-md border bg-background px-3 py-2"
            >
              <option value="monthly">{t("Mensal")}</option>
              <option value="annual">{t("Anual")}</option>
              <option value="custom">{t("Personalizado")}</option>
            </select>
          </label>
          <label className="grid gap-1 text-sm">
            {t("Preço acordado (R$)")}
            <input
              type="number"
              min="0"
              step="0.01"
              value={subscriptionAmount}
              onChange={(event) => setSubscriptionAmount(event.target.value)}
              placeholder={t("Não informado")}
              className="rounded-md border bg-background px-3 py-2"
            />
          </label>
          <label className="grid gap-1 text-sm">
            {t("Período válido até")}
            <input
              type="datetime-local"
              value={periodEndsAt}
              onChange={(event) => setPeriodEndsAt(event.target.value)}
              required
              className="rounded-md border bg-background px-3 py-2"
            />
          </label>
          <p className="text-xs text-muted-foreground sm:col-span-2">
            {t(
              "A nova empresa recebe uma assinatura ativa com este plano e período. O pagamento continua manual.",
            )}
          </p>
          <label className="grid gap-1 text-sm">
            E-mail do administrador inicial
            <input
              type="email"
              value={tenantOwnerEmail}
              onChange={(event) => setTenantOwnerEmail(event.target.value)}
              maxLength={254}
              required
              className="rounded-md border bg-background px-3 py-2"
            />
          </label>
          <button
            type="submit"
            disabled={busy}
            className="rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground disabled:opacity-50 sm:col-span-2"
          >
            Criar empresa
          </button>
        </form>
        {ownerInvitation?.accept_url && (
          <div
            className="space-y-3 rounded-md border p-4"
            aria-label={t("Convite do administrador inicial")}
          >
            <p role="status" className="text-sm">
              {ownerInvitation.email_dispatched
                ? t("Convite do administrador enviado por e-mail.")
                : t(
                    "O envio por e-mail não foi confirmado. Copie o link e compartilhe com o administrador.",
                  )}
            </p>
            <label className="grid gap-1 text-sm">
              {t("Link do convite do administrador")}
              <input
                type="url"
                readOnly
                value={ownerInvitation.accept_url}
                className="w-full rounded-md border bg-background px-3 py-2"
              />
            </label>
            {ownerInvitation.expires_at && (
              <p className="text-sm text-muted-foreground">
                {t("Válido até")} {new Date(ownerInvitation.expires_at).toLocaleString()}.
              </p>
            )}
            <button
              type="button"
              onClick={async () => {
                const copied = await copyToClipboard(ownerInvitation.accept_url!);
                setFeedback(
                  copied
                    ? { kind: "success", message: t("Link do convite copiado.") }
                    : {
                        kind: "error",
                        message: t(
                          "Não foi possível copiar o convite. Selecione o link e copie manualmente.",
                        ),
                      },
                );
              }}
              className="rounded-md border px-4 py-2 text-sm font-medium"
            >
              {t("Copiar convite do administrador")}
            </button>
          </div>
        )}
      </section>

      <section aria-labelledby="owner-users-title" className="space-y-4 rounded-lg border p-5">
        <div>
          <h2 id="owner-users-title" className="text-xl font-semibold">
            {t("Usuários e vagas")}
          </h2>
          <p className="text-sm text-muted-foreground">
            {t("O convite reserva uma vaga quando for aceito, conforme o plano da empresa.")}
          </p>
        </div>
        <form onSubmit={inviteUser} className="grid gap-4 sm:grid-cols-2">
          <label className="grid gap-1 text-sm sm:col-span-2">
            Empresa
            <select
              value={selectedTenantId}
              onChange={(event) => setSelectedTenantId(event.target.value)}
              required
              className="rounded-md border bg-background px-3 py-2"
            >
              <option value="">Selecione uma empresa</option>
              {tenants.map((tenant) => (
                <option key={tenant.id} value={tenant.id}>
                  {tenant.display_name}
                </option>
              ))}
            </select>
          </label>
          <label className="grid gap-1 text-sm">
            {t("E-mail do usuário")}
            <input
              type="email"
              value={inviteEmail}
              onChange={(event) => setInviteEmail(event.target.value)}
              maxLength={254}
              required
              className="rounded-md border bg-background px-3 py-2"
            />
          </label>
          <label className="grid gap-1 text-sm">
            Papel na empresa
            <select
              value={inviteRole}
              onChange={(event) => setInviteRole(event.target.value as typeof inviteRole)}
              className="rounded-md border bg-background px-3 py-2"
            >
              <option value="viewer">Visualizador</option>
              <option value="agent">Atendente</option>
              <option value="manager">Gerente</option>
              <option value="admin">Administrador</option>
            </select>
          </label>
          <button
            type="submit"
            disabled={busy || tenants.length === 0}
            className="rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground disabled:opacity-50 sm:col-span-2"
          >
            Criar convite
          </button>
        </form>
        {inviteUrl && (
          <p className="text-sm break-all">
            <a className="underline" href={inviteUrl}>
              {t("Abrir convite para aceitar a vaga")}
            </a>
          </p>
        )}
      </section>

      <section className="space-y-3">
        <label className="grid max-w-xl gap-1 text-sm">
          {t("Empresa para assinatura")}
          <select
            value={selectedTenantId}
            onChange={(event) => setSelectedTenantId(event.target.value)}
            className="rounded-md border bg-background px-3 py-2"
          >
            <option value="">{t("Selecione uma empresa")}</option>
            {tenants.map((tenant) => (
              <option key={tenant.id} value={tenant.id}>
                {tenant.display_name}
              </option>
            ))}
          </select>
        </label>
        <OwnerSubscriptionManager organizationId={selectedTenantId} />
      </section>

      {feedback && (
        <p
          role={feedback.kind === "error" ? "alert" : "status"}
          className={
            feedback.kind === "error" ? "text-sm text-destructive" : "text-sm text-foreground"
          }
        >
          {feedback.message}
        </p>
      )}
    </div>
  );
}
