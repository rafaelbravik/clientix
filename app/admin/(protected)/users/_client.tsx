"use client";
import { useCallback, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useAdminUsers, type AdminUserRow, type AdminUsersFilters } from "@/hooks/useAdminUsers";
import { useAdminTenants } from "@/hooks/useAdminTenants";
import {
  UsersTableAdmin,
  UsersTableAdminSkeleton,
} from "@/components/admin/users/UsersTableAdmin";
import { useT } from "@/hooks/i18n/useT";
import { apiClient } from "@/lib/api/client";
import { ApiError } from "@/lib/api/types";
import { copyToClipboard } from "@/lib/clipboard";

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function UsersClient({ canManage, canGrantGlobalAdmin = false }: { canManage: boolean; canGrantGlobalAdmin?: boolean }) {
  const t = useT();
  const queryClient = useQueryClient();
  const [filters, setFilters] = useState<AdminUsersFilters>({});
  const [inputValue, setInputValue] = useState("");
  const [inviteEmail, setInviteEmail] = useState("");
  const [inviteOrganizationId, setInviteOrganizationId] = useState("");
  const [inviteRole, setInviteRole] = useState<"viewer" | "agent" | "manager" | "admin">("admin");
  const [inviteBusy, setInviteBusy] = useState(false);
  const [inviteLink, setInviteLink] = useState<string | null>(null);
  const [inviteError, setInviteError] = useState<string | null>(null);
  const [membershipBusy, setMembershipBusy] = useState<string | null>(null);
  const [globalAdminBusy, setGlobalAdminBusy] = useState<string | null>(null);
  const [globalAdminScope, setGlobalAdminScope] = useState<"support_readonly" | "full">("support_readonly");
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Load tenants for the tenant select filter
  const { data: tenantsData } = useAdminTenants({});
  const tenants = (tenantsData?.pages ?? [])
    .flatMap((p) => p.data ?? [])
    .map((t) => ({ id: t.id, slug: t.slug, display_name: t.display_name }));

  const { data, isLoading, hasNextPage, isFetchingNextPage, fetchNextPage } =
    useAdminUsers(filters);

  const rows = data?.pages.flatMap((p) => p.data ?? []) ?? [];
  const total = rows.length;

  const handleSearch = useCallback(
    (value: string) => {
      setInputValue(value);
      if (debounceRef.current) clearTimeout(debounceRef.current);
      debounceRef.current = setTimeout(() => {
        setFilters((prev) => ({ ...prev, q: value || undefined }));
      }, 300);
    },
    [],
  );

  const handleTenant = useCallback((value: string) => {
    setFilters((prev) => ({
      ...prev,
      tenant_id: value === "all" ? undefined : value,
    }));
  }, []);

  const handleRole = useCallback((value: string) => {
    setFilters((prev) => ({
      ...prev,
      role:
        value === "all"
          ? undefined
          : (value as AdminUsersFilters["role"]),
    }));
  }, []);

  async function enviarConvite(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setInviteError(null);
    setInviteLink(null);
    setInviteBusy(true);
    try {
      const response = await apiClient.post<{
        data: { invitation: { accept_url: string; email_dispatched: boolean } };
      }>("/api/v1/admin/users", {
        organization_id: inviteOrganizationId,
        email: inviteEmail,
        role: inviteRole,
      });
      setInviteLink(response.data.invitation.accept_url);
      setInviteEmail("");
      toast.success(response.data.invitation.email_dispatched ? "Convite enviado por e-mail." : "Convite criado; copie o link para compartilhar.");
      await queryClient.invalidateQueries({ queryKey: ["admin", "users"] });
    } catch (error) {
      const message = error instanceof ApiError ? error.message : "Não foi possível emitir o convite.";
      setInviteError(message);
      toast.error(message);
    } finally {
      setInviteBusy(false);
    }
  }

  async function alterarVinculo(row: AdminUserRow, action: "revoke" | "reactivate" | "change_role", role?: AdminUserRow["role"]) {
    if (action === "revoke" && !window.confirm(`Revogar o acesso de ${row.email ?? "este usuário"} à empresa ${row.tenant_name}?`)) return;
    const key = `${row.user_id}:${row.organization_id}`;
    setMembershipBusy(key);
    try {
      await apiClient.patch(`/api/v1/admin/users/${row.user_id}`, {
        organization_id: row.organization_id,
        action,
        ...(role ? { role } : {}),
      });
      toast.success(action === "change_role" ? "Papel da empresa atualizado." : action === "revoke" ? "Acesso à empresa revogado." : "Acesso à empresa reativado.");
      await queryClient.invalidateQueries({ queryKey: ["admin", "users"] });
    } catch (error) {
      toast.error(error instanceof ApiError ? error.message : "Não foi possível atualizar o acesso.");
    } finally {
      setMembershipBusy(null);
    }
  }

  async function concederAdminGlobal(row: AdminUserRow) {
    const scopeLabel = globalAdminScope === "support_readonly" ? "somente leitura" : "administração global completa";
    if (!window.confirm(`Conceder ${scopeLabel} a ${row.email ?? row.user_id}? O acesso será global e exigirá MFA.`)) return;
    setGlobalAdminBusy(row.user_id);
    try {
      await apiClient.post("/api/v1/admin/platform-admins", {
        user_id: row.user_id,
        scope: globalAdminScope,
        mfa_required: true,
        reason: "Concedido pelo proprietário global pelo painel administrativo",
      });
      toast.success("Administrador global concedido com MFA obrigatório.");
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["admin", "users"] }),
        queryClient.invalidateQueries({ queryKey: ["admin", "platform-admins"] }),
      ]);
    } catch (error) {
      toast.error(error instanceof ApiError ? error.message : t("Não foi possível conceder o acesso global."));
    } finally {
      setGlobalAdminBusy(null);
    }
  }

  return (
    <div className="space-y-6">
      {canManage && (
        <Card>
          <CardHeader>
            <CardTitle className="text-lg">{t("Convidar usuário para uma empresa")}</CardTitle>
            <CardDescription>{t("O convite concede acesso somente à empresa selecionada. Para trocar alguém de empresa, conclua a revogação antes de convidá-lo novamente.")}</CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <form onSubmit={(event) => void enviarConvite(event)} className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
              <div className="space-y-2">
                <Label htmlFor="platform-user-invite-email">{t("E-mail")}</Label>
                <Input id="platform-user-invite-email" type="email" autoComplete="email" required maxLength={254} value={inviteEmail} onChange={(event) => setInviteEmail(event.target.value)} />
              </div>
              <div className="space-y-2">
                <Label htmlFor="platform-user-invite-organization">{t("Empresa")}</Label>
                <Select value={inviteOrganizationId} onValueChange={setInviteOrganizationId}>
                  <SelectTrigger id="platform-user-invite-organization" aria-label={t("Empresa do convite")}><SelectValue placeholder={t("Selecione uma empresa")} /></SelectTrigger>
                  <SelectContent>
                    {tenants.map((tenant) => <SelectItem key={tenant.id} value={tenant.id}>{tenant.display_name}</SelectItem>)}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-2">
                <Label htmlFor="platform-user-invite-role">{t("Papel na empresa")}</Label>
                <Select value={inviteRole} onValueChange={(value) => setInviteRole(value as typeof inviteRole)}>
                  <SelectTrigger id="platform-user-invite-role" aria-label={t("Papel na empresa")}><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="admin">{t("Administrador")}</SelectItem>
                    <SelectItem value="manager">{t("Gerente")}</SelectItem>
                    <SelectItem value="agent">{t("Agente")}</SelectItem>
                    <SelectItem value="viewer">{t("Visualizador")}</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div className="flex items-end">
                <Button type="submit" className="w-full" disabled={inviteBusy || !inviteOrganizationId || tenants.length === 0}>
                  {inviteBusy ? t("Emitindo convite…") : t("Convidar")}
                </Button>
              </div>
            </form>
            {inviteError && <p role="alert" className="text-sm text-destructive">{inviteError}</p>}
            {inviteLink && (
              <div className="space-y-2 rounded-md border bg-muted/30 p-3">
                <p className="text-sm font-medium">{t("Link de aceite do convite")}</p>
                <div className="flex flex-col gap-2 sm:flex-row">
                  <Input readOnly aria-label={t("Link de aceite")} value={inviteLink} />
                  <Button
                    type="button"
                    variant="secondary"
                    onClick={async () => {
                      if (await copyToClipboard(inviteLink)) toast.success(t("Link copiado"));
                      else toast.error(t("Não foi possível copiar o link."));
                    }}
                  >
                    {t("Copiar link")}
                  </Button>
                </div>
              </div>
            )}
          </CardContent>
        </Card>
      )}
      {canGrantGlobalAdmin && (
        <Card>
          <CardHeader>
            <CardTitle className="text-lg">{t("Delegar administração global")}</CardTitle>
            <CardDescription>{t("Escolha um usuário existente na lista abaixo. O grant será auditado e exigirá MFA. Proprietários não podem ser alterados por esta tela.")}</CardDescription>
          </CardHeader>
          <CardContent className="max-w-sm space-y-2">
            <Label htmlFor="global-admin-scope">{t("Escopo do novo administrador")}</Label>
            <Select value={globalAdminScope} onValueChange={(value) => setGlobalAdminScope(value as typeof globalAdminScope)}>
              <SelectTrigger id="global-admin-scope" aria-label={t("Escopo do administrador global")}><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="support_readonly">{t("Somente leitura")}</SelectItem>
                <SelectItem value="full">{t("Administração global completa")}</SelectItem>
              </SelectContent>
            </Select>
          </CardContent>
        </Card>
      )}
      {/* Header */}
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">{t("Usuários")}</h1>
        <p className="text-sm text-muted-foreground mt-1">
          {isLoading
            ? t("Carregando...")
            : `${total} ${total !== 1 ? t("usuários") : t("usuário")}${hasNextPage ? "+" : ""}`}
        </p>
      </div>

      {/* Filters */}
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:flex-wrap">
        <Input
          placeholder={t("Buscar por email ou nome...")}
          value={inputValue}
          onChange={(e) => handleSearch(e.target.value)}
          className="sm:w-72"
          aria-label={t("Buscar usuários")}
        />

        <Select
          value={filters.tenant_id ?? "all"}
          onValueChange={handleTenant}
        >
          <SelectTrigger className="sm:w-52" aria-label={t("Filtrar por tenant")}>
            <SelectValue placeholder="Tenant" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">{t("Todos os tenants")}</SelectItem>
            {tenants.map((tenant) => (
              <SelectItem key={tenant.id} value={tenant.id}>
                {tenant.display_name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>

        <Select value={filters.role ?? "all"} onValueChange={handleRole}>
          <SelectTrigger className="sm:w-40" aria-label={t("Filtrar por role")}>
            <SelectValue placeholder="Role" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">{t("Todos os roles")}</SelectItem>
            <SelectItem value="admin">{t("Admin")}</SelectItem>
            <SelectItem value="manager">{t("Manager")}</SelectItem>
            <SelectItem value="agent">{t("Agente")}</SelectItem>
            <SelectItem value="viewer">{t("Viewer")}</SelectItem>
          </SelectContent>
        </Select>
      </div>

      {/* Table */}
      {isLoading ? (
        <UsersTableAdminSkeleton />
      ) : (
        <UsersTableAdmin
          data={rows}
          canManage={canManage}
          canGrantGlobalAdmin={canGrantGlobalAdmin}
          busyMembership={membershipBusy}
          busyGlobalAdmin={globalAdminBusy}
          onChangeRole={(row, role) => void alterarVinculo(row, "change_role", role)}
          onToggleMembership={(row) => void alterarVinculo(row, row.revoked_at ? "reactivate" : "revoke")}
          onGrantGlobalAdmin={(row) => void concederAdminGlobal(row)}
          hasNextPage={hasNextPage}
          isFetchingNextPage={isFetchingNextPage}
          onLoadMore={() => void fetchNextPage()}
        />
      )}
    </div>
  );
}
