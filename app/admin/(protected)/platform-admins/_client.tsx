"use client";
import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { apiClient } from "@/lib/api/client";
import { ApiError } from "@/lib/api/types";
import type { PlatformAdminEntry } from "@/hooks/useAdminPlatformAdmins";
import { PlatformAdminDelegationNotice } from "@/components/admin/platform-admins/PlatformAdminDelegationNotice";
import {
  PlatformAdminsTable,
  PlatformAdminsTableSkeleton,
} from "@/components/admin/platform-admins/PlatformAdminsTable";
import { useAdminPlatformAdmins } from "@/hooks/useAdminPlatformAdmins";
import { useT } from "@/hooks/i18n/useT";

export function PlatformAdminsClient({ canManage }: { canManage: boolean }) {
  const t = useT();
  const queryClient = useQueryClient();
  const [busyUserId, setBusyUserId] = useState<string | null>(null);
  const { data, isLoading, isError } = useAdminPlatformAdmins();

  async function toggleAdmin(row: PlatformAdminEntry) {
    const revoked = Boolean(row.revoked_at);
    if (!revoked && !window.confirm(`Revogar o acesso global de ${row.user_email ?? row.user_id}?`)) return;
    setBusyUserId(row.user_id);
    try {
      if (revoked) {
        await apiClient.post("/api/v1/admin/platform-admins", {
          user_id: row.user_id,
          scope: row.scope ?? "support_readonly",
          mfa_required: row.mfa_required,
          reason: row.reason ?? "Reativado pelo proprietário global",
        });
      } else {
        await apiClient.patch("/api/v1/admin/platform-admins", {
          user_id: row.user_id,
          reason: "Revogado pelo proprietário global",
        });
      }
      toast.success(revoked ? "Acesso global reativado." : "Acesso global revogado.");
      await queryClient.invalidateQueries({ queryKey: ["admin", "platform-admins"] });
      await queryClient.invalidateQueries({ queryKey: ["admin", "users"] });
    } catch (error) {
      toast.error(error instanceof ApiError ? error.message : "Não foi possível atualizar o acesso global.");
    } finally {
      setBusyUserId(null);
    }
  }

  return (
    <div className="space-y-6">
      {/* Header */}
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">{t("Platform Admins")}</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          {t("Administradores com acesso privilegiado à plataforma")}
        </p>
      </div>

      {canManage && <PlatformAdminDelegationNotice />}

      {/* Table */}
      {isLoading ? (
        <PlatformAdminsTableSkeleton />
      ) : isError ? (
        <div className="flex items-center justify-center rounded-lg border py-12 text-sm text-muted-foreground">
          {t("Erro ao carregar platform admins. Tente recarregar.")}
        </div>
      ) : (
        <PlatformAdminsTable data={data ?? []} canManage={canManage} busyUserId={busyUserId} onToggleAdmin={(row) => void toggleAdmin(row)} />
      )}
    </div>
  );
}
