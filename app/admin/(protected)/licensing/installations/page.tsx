"use client";
import React, { useState, useEffect } from "react";
import { useT } from "@/lib/i18n/IdiomaProvider";
import Link from "next/link";
import { LicensingNav } from "@/components/admin/licensing/LicensingNav";
import { StatusBadge } from "@/components/admin/licensing/Badges";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { MagnifyingGlass, CircleNotch } from "@/lib/ui/icons";
import { useTagDeIdioma } from "@/hooks/i18n/useLocaleDeData";

interface InstallationItem {
  id: string;
  license_id: string;
  customer_name: string;
  license_type: string;
  license_status: string;
  public_key_fingerprint: string;
  status: "ACTIVE" | "SUSPENDED" | "REVOKED" | "DEACTIVATED";
  environment: string;
  app_version: string | null;
  last_heartbeat_at: string | null;
  created_at: string;
}

export default function AdminInstallationsPage() {
  const t = useT();
  const tag = useTagDeIdioma();
  const [installations, setInstallations] = useState<InstallationItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState("ALL");

  const fetchInstallations = async () => {
    setLoading(true);
    try {
      const params = new URLSearchParams();
      if (search) params.set("search", search);
      if (statusFilter !== "ALL") params.set("status", statusFilter);

      const res = await fetch(`/api/v1/admin/licensing/installations?${params.toString()}`);
      if (res.ok) {
        const json = await res.json();
        setInstallations(json.data || []);
      }
    } catch (err) {
      console.error(err);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchInstallations();
  }, [statusFilter]);

  const handleSearchSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    fetchInstallations();
  };

  return (
    <div className="space-y-6">
      <div className="flex flex-col justify-between gap-4 sm:flex-row sm:items-center">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">{t("Instalações Vinculadas")}</h1>
          <p className="text-sm text-muted-foreground">
            {t("Instâncias ativas conectadas ao Control Plane com Proof-of-Possession.")}
          </p>
        </div>
      </div>

      <LicensingNav />

      {/* Filters */}
      <div className="flex flex-col items-center justify-between gap-3 md:flex-row">
        <form onSubmit={handleSearchSubmit} className="flex w-full max-w-sm flex-1 gap-2 md:w-auto">
          <Input
            placeholder="Buscar por ID, fingerprint ou cliente..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
          <Button type="submit" variant="secondary" size="icon">
            <MagnifyingGlass className="h-4 w-4" />
          </Button>
        </form>

        <select
          value={statusFilter}
          onChange={(e) => setStatusFilter(e.target.value)}
          className="h-9 rounded-md border border-input bg-background px-3 text-sm text-foreground focus:ring-1 focus:ring-ring focus:outline-hidden"
        >
          <option value="ALL">{t("Status: Todos")}</option>
          <option value="ACTIVE">Ativas</option>
          <option value="SUSPENDED">Suspensas</option>
          <option value="DEACTIVATED">Desativadas</option>
          <option value="REVOKED">Revogadas</option>
        </select>
      </div>

      {/* Table */}
      <div className="overflow-hidden rounded-lg border bg-card">
        {loading ? (
          <div className="flex items-center justify-center p-8 text-center text-muted-foreground">
            <CircleNotch className="mr-2 h-5 w-5 animate-spin" /> {t("Carregando instalações...")}
          </div>
        ) : installations.length === 0 ? (
          <div className="p-8 text-center text-sm text-muted-foreground">
            {t("Nenhuma instalação encontrada com os filtros selecionados.")}
          </div>
        ) : (
          <table className="w-full text-left text-sm">
            <thead className="border-b bg-muted/40 text-xs font-medium tracking-wider text-muted-foreground uppercase">
              <tr>
                <th className="px-4 py-3">{t("ID da Instalação")}</th>
                <th className="px-4 py-3">Cliente / Contrato</th>
                <th className="px-4 py-3">Fingerprint Ed25519</th>
                <th className="px-4 py-3">Status</th>
                <th className="px-4 py-3">{t("Versão")}</th>
                <th className="px-4 py-3">{t("Último Heartbeat")}</th>
                <th className="px-4 py-3 text-right">{t("Ação")}</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {installations.map((inst) => (
                <tr key={inst.id} className="hover:bg-muted/20">
                  <td className="px-4 py-3 font-mono text-xs text-foreground">{inst.id}</td>
                  <td className="px-4 py-3">
                    <div className="font-medium">{inst.customer_name}</div>
                    <div className="text-xs text-muted-foreground capitalize">
                      {inst.license_type}
                    </div>
                  </td>
                  <td className="px-4 py-3 font-mono text-xs text-muted-foreground">
                    {inst.public_key_fingerprint.slice(0, 16)}...
                  </td>
                  <td className="px-4 py-3">
                    <StatusBadge status={inst.status} />
                  </td>
                  <td className="px-4 py-3 text-xs">{inst.app_version || "—"}</td>
                  <td className="px-4 py-3 text-xs text-muted-foreground">
                    {inst.last_heartbeat_at
                      ? new Date(inst.last_heartbeat_at).toLocaleString(tag)
                      : t("Nunca")}
                  </td>
                  <td className="px-4 py-3 text-right">
                    <Button asChild variant="outline" size="sm">
                      <Link href={`/admin/licensing/installations/${inst.id}`}>
                        {t("Detalhes")}
                      </Link>
                    </Button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
