"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { LicensingNav } from "@/components/admin/licensing/LicensingNav";
import { StatusBadge } from "@/components/admin/licensing/Badges";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useT } from "@/hooks/i18n/useT";
import { useTagDeIdioma } from "@/hooks/i18n/useLocaleDeData";
import { CircleNotch, MagnifyingGlass } from "@/lib/ui/icons";

interface InstallationItem {
  id: string;
  license_id: string;
  serial: string;
  customer_name: string;
  license_type: string;
  license_status: string;
  status: string;
  last_validation_at: string | null;
  last_heartbeat_at: string | null;
  active_session_id: string | null;
  clientix_version: string | null;
  clone_status: "NORMAL" | "SUSPECTED_CLONE" | "CLONE_CONFIRMED" | "TRANSFER_PENDING";
}

function maskedId(id: string) {
  return id.length > 18 ? `${id.slice(0, 12)}…${id.slice(-4)}` : id;
}

export default function AdminInstallationsPage() {
  const t = useT();
  const tag = useTagDeIdioma();
  const [installations, setInstallations] = useState<InstallationItem[]>([]);
  const [total, setTotal] = useState(0);
  const [offset, setOffset] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [searchDraft, setSearchDraft] = useState("");
  const [search, setSearch] = useState("");
  const [status, setStatus] = useState("ALL");
  const [cloneStatus, setCloneStatus] = useState("ALL");
  const [sort, setSort] = useState("created_at");
  const [direction, setDirection] = useState<"asc" | "desc">("desc");
  const limit = 25;

  const fetchInstallations = useCallback(
    async (nextOffset = 0) => {
      setLoading(true);
      setError("");
      try {
        const params = new URLSearchParams({
          limit: String(limit),
          offset: String(nextOffset),
          sort,
          direction,
        });
        if (search) params.set("search", search);
        if (status !== "ALL") params.set("status", status);
        if (cloneStatus !== "ALL") params.set("clone_status", cloneStatus);
        const response = await fetch(`/api/v1/admin/licensing/installations?${params}`);
        if (!response.ok) throw new Error("Não foi possível carregar instalações.");
        const result = await response.json();
        setInstallations(result.data ?? []);
        setTotal(result.meta?.total ?? 0);
        setOffset(nextOffset);
      } catch (caught) {
        setError(
          caught instanceof Error ? caught.message : "Não foi possível carregar instalações.",
        );
      } finally {
        setLoading(false);
      }
    },
    [search, status, cloneStatus, sort, direction],
  );

  useEffect(() => {
    void fetchInstallations(0);
  }, [fetchInstallations]);

  return (
    <div className="space-y-6">
      <header>
        <h1 className="text-2xl font-bold tracking-tight">{t("Instalações")}</h1>
        <p className="text-sm text-muted-foreground">
          {t("Identidade, sessão e estado de clone registrados no Control Plane.")}
        </p>
      </header>
      <LicensingNav />
      <section className="grid gap-2 sm:grid-cols-[minmax(0,1fr)_200px_220px_220px_110px]">
        <form
          onSubmit={(event) => {
            event.preventDefault();
            setSearch(searchDraft.trim());
          }}
          className="flex gap-2"
        >
          <Input
            value={searchDraft}
            onChange={(event) => setSearchDraft(event.target.value)}
            placeholder="Buscar installation_id, serial ou cliente"
            aria-label={t("Buscar instalações")}
          />
          <Button type="submit" size="icon" variant="secondary" aria-label="Buscar">
            <MagnifyingGlass className="h-4 w-4" />
          </Button>
        </form>
        <select
          aria-label={t("Status de instalação")}
          value={status}
          onChange={(event) => setStatus(event.target.value)}
          className="h-9 rounded-md border bg-background px-3 text-sm"
        >
          <option value="ALL">{t("Todos os status")}</option>
          {["ACTIVE", "SUSPENDED", "REVOKED", "DEACTIVATED", "TRANSFERRED", "DISABLED"].map(
            (value) => (
              <option key={value}>{value}</option>
            ),
          )}
        </select>
        <select
          aria-label="Status de clone"
          value={cloneStatus}
          onChange={(event) => setCloneStatus(event.target.value)}
          className="h-9 rounded-md border bg-background px-3 text-sm"
        >
          <option value="ALL">{t("Todos os estados de clone")}</option>
          {["NORMAL", "SUSPECTED_CLONE", "CLONE_CONFIRMED", "TRANSFER_PENDING"].map((value) => (
            <option key={value}>{value}</option>
          ))}
        </select>
        <select
          aria-label={t("Ordenar instalações")}
          value={sort}
          onChange={(event) => setSort(event.target.value)}
          className="h-9 rounded-md border bg-background px-3 text-sm"
        >
          <option value="created_at">{t("Mais recentes")}</option>
          <option value="customer">Cliente</option>
          <option value="status">Status</option>
          <option value="last_validation">{t("Última validação")}</option>
        </select>
        <Button
          type="button"
          variant="outline"
          onClick={() => setDirection((current) => (current === "asc" ? "desc" : "asc"))}
        >
          Ordem {direction === "asc" ? "↑" : "↓"}
        </Button>
      </section>
      {error && (
        <div
          role="alert"
          className="rounded-md border border-destructive/30 bg-destructive/5 p-3 text-sm text-destructive"
        >
          {error}
        </div>
      )}
      <section className="overflow-hidden rounded-lg border bg-card">
        {loading ? (
          <div className="flex items-center justify-center p-10 text-sm text-muted-foreground">
            <CircleNotch className="mr-2 h-4 w-4 animate-spin" />
            {t("Carregando instalações…")}
          </div>
        ) : installations.length === 0 ? (
          <div className="p-10 text-center text-sm text-muted-foreground">
            {t("Nenhuma instalação corresponde aos filtros.")}
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[1000px] text-left text-sm">
              <thead className="border-b bg-muted/40 text-xs tracking-wide text-muted-foreground uppercase">
                <tr>
                  <th className="px-4 py-3">{t("Instalação")}</th>
                  <th className="px-4 py-3">{t("Cliente / licença")}</th>
                  <th className="px-4 py-3">Status</th>
                  <th className="px-4 py-3">Clone</th>
                  <th className="px-4 py-3">{t("Última validação")}</th>
                  <th className="px-4 py-3">{t("Heartbeat / sessão")}</th>
                  <th className="px-4 py-3">{t("Versão")}</th>
                  <th className="px-4 py-3 text-right">{t("Ação")}</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {installations.map((item) => (
                  <tr key={item.id} className="hover:bg-muted/20">
                    <td className="px-4 py-3 font-mono text-xs" title={item.id}>
                      {maskedId(item.id)}
                    </td>
                    <td className="px-4 py-3">
                      <span className="block font-medium">{item.customer_name}</span>
                      <Link
                        className="font-mono text-xs text-muted-foreground hover:underline"
                        href={`/admin/licenses/${item.license_id}`}
                      >
                        {item.serial}
                      </Link>
                    </td>
                    <td className="px-4 py-3">
                      <StatusBadge status={item.status} />
                    </td>
                    <td className="px-4 py-3 text-xs">{item.clone_status}</td>
                    <td className="px-4 py-3 text-xs">
                      {item.last_validation_at
                        ? new Date(item.last_validation_at).toLocaleString(tag)
                        : t("Nunca")}
                    </td>
                    <td className="px-4 py-3 text-xs">
                      <span className="block">
                        {item.last_heartbeat_at
                          ? new Date(item.last_heartbeat_at).toLocaleString(tag)
                          : t("Sem heartbeat")}
                      </span>
                      <span className="text-muted-foreground">
                        {item.active_session_id ? t("sessão ativa") : t("sem sessão ativa")}
                      </span>
                    </td>
                    <td className="px-4 py-3 text-xs">{item.clientix_version ?? "—"}</td>
                    <td className="px-4 py-3 text-right">
                      <Button asChild variant="outline" size="sm">
                        <Link
                          href={`/admin/licensing/installations/${encodeURIComponent(item.id)}`}
                        >
                          {t("Detalhes")}
                        </Link>
                      </Button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <footer className="flex items-center justify-between border-t px-4 py-3 text-xs text-muted-foreground">
          <span>
            {total
              ? `${offset + 1}–${Math.min(offset + installations.length, total)} de ${total}`
              : "0 resultados"}
          </span>
          <div className="flex gap-2">
            <Button
              size="sm"
              variant="outline"
              disabled={offset === 0 || loading}
              onClick={() => void fetchInstallations(Math.max(0, offset - limit))}
            >
              Anterior
            </Button>
            <Button
              size="sm"
              variant="outline"
              disabled={offset + limit >= total || loading}
              onClick={() => void fetchInstallations(offset + limit)}
            >
              {t("Próxima")}
            </Button>
          </div>
        </footer>
      </section>
    </div>
  );
}
