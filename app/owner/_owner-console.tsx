"use client";

import { useState, type FormEvent } from "react";

type Tenant = { id: string; slug: string; display_name: string };
type OwnerApiPayload = {
  data?:
    | {
        id?: string;
        slug?: string;
        display_name?: string;
        invitation?: { accept_url?: string; email_dispatched?: boolean };
      }
    | Tenant[];
  error?: { message?: string };
};

type Feedback = { kind: "success" | "error"; message: string } | null;

export function OwnerConsole({ ownerEmail }: { ownerEmail: string }) {
  const [tenants, setTenants] = useState<Tenant[]>([]);
  const [selectedTenantId, setSelectedTenantId] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [slug, setSlug] = useState("");
  const [plan, setPlan] = useState<"standard" | "pro" | "enterprise">("pro");
  const [tenantOwnerEmail, setTenantOwnerEmail] = useState(ownerEmail);
  const [inviteEmail, setInviteEmail] = useState("");
  const [inviteRole, setInviteRole] = useState<"viewer" | "agent" | "manager" | "admin">("agent");
  const [inviteUrl, setInviteUrl] = useState<string | null>(null);
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
    setBusy(true);
    setFeedback(null);
    try {
      const response = await fetch("/api/v1/admin/tenants", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Idempotency-Key": crypto.randomUUID(),
        },
        body: JSON.stringify({
          display_name: displayName,
          slug,
          plan,
          owner_email: tenantOwnerEmail,
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
      setDisplayName("");
      setSlug("");
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
      <section aria-labelledby="owner-tenants-title" className="space-y-4 rounded-lg border p-5">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h2 id="owner-tenants-title" className="text-xl font-semibold">
              Empresas
            </h2>
            <p className="text-sm text-muted-foreground">
              A criação respeita o limite global da licença.
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
        <ul aria-label="Empresas desta instalação" className="space-y-2">
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
              className="rounded-md border bg-background px-3 py-2"
            >
              <option value="standard">Standard</option>
              <option value="pro">Pro</option>
              <option value="enterprise">Enterprise</option>
            </select>
          </label>
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
      </section>

      <section aria-labelledby="owner-users-title" className="space-y-4 rounded-lg border p-5">
        <div>
          <h2 id="owner-users-title" className="text-xl font-semibold">
            Usuários e vagas
          </h2>
          <p className="text-sm text-muted-foreground">
            O convite reserva uma vaga quando for aceito, conforme o plano da empresa.
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
            E-mail do usuário
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
              Abrir convite para aceitar a vaga
            </a>
          </p>
        )}
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
