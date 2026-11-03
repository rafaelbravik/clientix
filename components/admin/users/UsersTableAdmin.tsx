"use client";

import { useLocaleDeData } from "@/hooks/i18n/useLocaleDeData";

import type { Locale } from "date-fns";
import Link from "next/link";
import { formatDistanceToNow } from "date-fns";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Users } from "@/lib/ui/icons";
import type { AdminUserRow } from "@/hooks/useAdminUsers";
import { useT } from "@/hooks/i18n/useT";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

// ---------------------------------------------------------------------------
// Role badge
// ---------------------------------------------------------------------------

const ROLE_VARIANTS: Record<
  string,
  "success" | "info" | "warning" | "error" | "neutral"
> = {
  admin: "error",
  manager: "warning",
  agent: "info",
  viewer: "neutral",
};

const ROLE_LABELS: Record<string, string> = {
  admin: "Admin",
  manager: "Manager",
  agent: "Agente",
  viewer: "Viewer",
};

function RoleBadge({ role }: { role: string }) {
  const t = useT();
  return (
    <Badge variant={ROLE_VARIANTS[role] ?? "neutral"}>
      {t(ROLE_LABELS[role] ?? role)}
    </Badge>
  );
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function relativeDate(iso: string | null, locale: Locale): string {
  if (!iso) return "—";
  try {
    return formatDistanceToNow(new Date(iso), {
      addSuffix: true,
      locale: locale,
    });
  } catch {
    return iso;
  }
}

// ---------------------------------------------------------------------------
// Skeleton
// ---------------------------------------------------------------------------

export function UsersTableAdminSkeleton() {
  const t = useT();
  return (
    <div className="rounded-md border">
      <Table>
        <TableHeader>
          <TableRow>
            {["Email", t("Nome"), "Tenant", "Role", t("Último acesso"), t("Status"), ""].map(
              (h) => (
                <TableHead key={h}>{h}</TableHead>
              ),
            )}
          </TableRow>
        </TableHeader>
        <TableBody>
          {Array.from({ length: 5 }).map((_, i) => (
            <TableRow key={i}>
              {Array.from({ length: 7 }).map((__, j) => (
                <TableCell key={j}>
                  <Skeleton className="h-4 w-full max-w-[140px]" />
                </TableCell>
              ))}
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Main component
// ---------------------------------------------------------------------------

interface UsersTableAdminProps {
  data: AdminUserRow[];
  canManage: boolean;
  canGrantGlobalAdmin?: boolean;
  busyMembership: string | null;
  busyGlobalAdmin?: string | null;
  onChangeRole: (row: AdminUserRow, role: AdminUserRow["role"]) => void;
  onToggleMembership: (row: AdminUserRow) => void;
  onGrantGlobalAdmin?: (row: AdminUserRow) => void;
  hasNextPage: boolean;
  isFetchingNextPage: boolean;
  onLoadMore: () => void;
}

export function UsersTableAdmin({
  data,
  canManage,
  canGrantGlobalAdmin = false,
  busyMembership,
  busyGlobalAdmin,
  onChangeRole,
  onToggleMembership,
  onGrantGlobalAdmin,
  hasNextPage,
  isFetchingNextPage,
  onLoadMore,
}: UsersTableAdminProps) {
  const localeDaData = useLocaleDeData();
  const t = useT();
  if (data.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center gap-3 rounded-md border py-16 text-center text-muted-foreground">
        <Users size={36} weight="duotone" className="opacity-40" aria-hidden />
        <p className="text-sm font-medium">{t("Nenhum usuário encontrado")}</p>
        <p className="max-w-xs text-xs opacity-70">
          {t("Ajuste os filtros para refinar a busca.")}
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div className="rounded-md border">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Email</TableHead>
              <TableHead className="w-[160px]">{t("Nome")}</TableHead>
              <TableHead className="w-[160px]">Tenant</TableHead>
              <TableHead className="w-[100px]">Role</TableHead>
              <TableHead className="w-[160px]">{t("Último acesso")}</TableHead>
              <TableHead className="w-[100px]">{t("Status")}</TableHead>
              <TableHead className={canManage || canGrantGlobalAdmin ? "w-[280px]" : "w-[60px]"}>{canManage || canGrantGlobalAdmin ? t("Ações") : ""}</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {data.map((row) => (
              <TableRow key={`${row.user_id}:${row.organization_id}`}>
                <TableCell className="font-mono text-xs">
                  {row.email ?? "—"}
                </TableCell>
                <TableCell className="font-medium">
                  {row.full_name ?? <span className="text-muted-foreground">—</span>}
                </TableCell>
                <TableCell>
                  <div className="flex flex-col gap-0.5">
                    <span className="text-xs font-medium">{row.tenant_name}</span>
                    <span className="font-mono text-[10px] text-muted-foreground">
                      {row.tenant_slug}
                    </span>
                  </div>
                </TableCell>
                <TableCell>
                  {canManage && !row.revoked_at ? (
                    <Select value={row.role} onValueChange={(value) => onChangeRole(row, value as AdminUserRow["role"])}>
                      <SelectTrigger className="h-8 w-32" aria-label={`${t("Papel de")} ${row.email ?? row.user_id}`}>
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="admin">{t("Admin")}</SelectItem>
                        <SelectItem value="manager">{t("Manager")}</SelectItem>
                        <SelectItem value="agent">{t("Agente")}</SelectItem>
                        <SelectItem value="viewer">{t("Viewer")}</SelectItem>
                      </SelectContent>
                    </Select>
                  ) : <RoleBadge role={row.role} />}
                </TableCell>
                <TableCell className="text-xs text-muted-foreground">
                  {relativeDate(row.last_sign_in_at, localeDaData)}
                </TableCell>
                <TableCell>
                  {row.revoked_at ? (
                    <Badge variant="error">{t("Revogado")}</Badge>
                  ) : (
                    <Badge variant="success">{t("Ativo")}</Badge>
                  )}
                </TableCell>
                <TableCell>
                  <div className="flex items-center gap-2">
                    <Link
                      href={`/admin/users/${row.user_id}`}
                      className="text-xs font-medium text-accent hover:underline"
                    >
                      {t("Ver")}
                    </Link>
                    {canManage && (
                      <Button
                        type="button"
                        size="sm"
                        variant={row.revoked_at ? "secondary" : "destructive"}
                        disabled={busyMembership === `${row.user_id}:${row.organization_id}`}
                        onClick={() => onToggleMembership(row)}
                      >
                        {busyMembership === `${row.user_id}:${row.organization_id}`
                          ? t("Salvando…")
                          : row.revoked_at ? t("Reativar") : t("Revogar acesso")}
                      </Button>
                    )}
                    {canGrantGlobalAdmin && row.platform_role === null && onGrantGlobalAdmin && (
                      <Button
                        type="button"
                        size="sm"
                        variant="outline"
                        disabled={busyGlobalAdmin === row.user_id}
                        onClick={() => onGrantGlobalAdmin(row)}
                      >
                        {busyGlobalAdmin === row.user_id ? t("Salvando…") : t("Tornar admin global")}
                      </Button>
                    )}
                    {canGrantGlobalAdmin && row.platform_role && (
                      <Badge variant={row.platform_role === "owner" ? "default" : "secondary"}>
                        {row.platform_role === "owner" ? t("Proprietário global") : t("Admin global")}
                      </Badge>
                    )}
                  </div>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>

      {hasNextPage && (
        <div className="flex justify-center">
          <Button
            variant="outline"
            size="sm"
            onClick={onLoadMore}
            disabled={isFetchingNextPage}
          >
            {isFetchingNextPage ? t("Carregando...") : t("Carregar mais")}
          </Button>
        </div>
      )}
    </div>
  );
}
