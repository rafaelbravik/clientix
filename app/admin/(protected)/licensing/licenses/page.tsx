"use client";
import React, { useState, useEffect } from "react";
import { useT } from "@/lib/i18n/IdiomaProvider";
import Link from "next/link";
import { LicensingNav } from "@/components/admin/licensing/LicensingNav";
import { StatusBadge, TemporalStateBadge } from "@/components/admin/licensing/Badges";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Plus, MagnifyingGlass, CircleNotch } from "@/lib/ui/icons";
import { useTagDeIdioma } from "@/hooks/i18n/useLocaleDeData";

interface LicenseItem {
  id: string;
  customer_id: string;
  customer_name: string;
  customer_email: string;
  license_type: string;
  status: "ACTIVE" | "SUSPENDED" | "REVOKED";
  temporal_state: "VALID" | "GRACE" | "EXPIRED" | "NOT_YET_VALID";
  max_installations: number;
  active_installations_count: number;
  valid_from: string;
  expires_at: string;
}

export default function AdminLicensesPage() {
  const t = useT();
  const tag = useTagDeIdioma();
  const [licenses, setLicenses] = useState<LicenseItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState<string>("ALL");
  const [typeFilter, setTypeFilter] = useState<string>("ALL");

  const fetchLicenses = async () => {
    setLoading(true);
    try {
      const params = new URLSearchParams();
      if (search) params.set("search", search);
      if (statusFilter !== "ALL") params.set("status", statusFilter);
      if (typeFilter !== "ALL") params.set("license_type", typeFilter);

      const res = await fetch(`/api/v1/admin/licensing/licenses?${params.toString()}`);
      if (res.ok) {
        const json = await res.json();
        setLicenses(json.data || []);
      }
    } catch (err) {
      console.error(err);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchLicenses();
  }, [statusFilter, typeFilter]);

  const handleSearchSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    fetchLicenses();
  };

  return (
    <div className="space-y-6">
      <div className="flex flex-col justify-between gap-4 sm:flex-row sm:items-center">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">Licenciamento & Releases</h1>
          <p className="text-sm text-muted-foreground">
            {t("Gestão operacional de clientes, licenças emitidas, ativações e instalações.")}
          </p>
        </div>
        <Button asChild size="sm">
          <Link href="/admin/licensing/licenses/new">
            <Plus className="mr-1.5 h-4 w-4" />
            {t("Nova Licença")}
          </Link>
        </Button>
      </div>

      <LicensingNav />

      {/* Filters */}
      <div className="flex flex-col items-center justify-between gap-3 md:flex-row">
        <form onSubmit={handleSearchSubmit} className="flex w-full max-w-sm flex-1 gap-2 md:w-auto">
          <Input
            placeholder="Buscar por cliente ou ID..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
          <Button type="submit" variant="secondary" size="icon">
            <MagnifyingGlass className="h-4 w-4" />
          </Button>
        </form>

        <div className="flex w-full gap-2 md:w-auto">
          <select
            value={statusFilter}
            onChange={(e) => setStatusFilter(e.target.value)}
            className="h-9 rounded-md border border-input bg-background px-3 text-sm text-foreground focus:ring-1 focus:ring-ring focus:outline-hidden"
          >
            <option value="ALL">{t("Status: Todos")}</option>
            <option value="ACTIVE">Ativas</option>
            <option value="SUSPENDED">Suspensas</option>
            <option value="REVOKED">Revogadas</option>
          </select>

          <select
            value={typeFilter}
            onChange={(e) => setTypeFilter(e.target.value)}
            className="h-9 rounded-md border border-input bg-background px-3 text-sm text-foreground focus:ring-1 focus:ring-ring focus:outline-hidden"
          >
            <option value="ALL">{t("Tipo: Todos")}</option>
            <option value="enterprise">Enterprise</option>
            <option value="partner">Partner</option>
            <option value="internal">Internal</option>
          </select>
        </div>
      </div>

      {/* Licenses Table */}
      <div className="overflow-hidden rounded-lg border bg-card">
        {loading ? (
          <div className="flex items-center justify-center p-8 text-center text-muted-foreground">
            <CircleNotch className="mr-2 h-5 w-5 animate-spin" /> {t("Carregando licenças...")}
          </div>
        ) : licenses.length === 0 ? (
          <div className="p-8 text-center text-sm text-muted-foreground">
            {t("Nenhuma licença encontrada com os filtros aplicados.")}
          </div>
        ) : (
          <table className="w-full text-left text-sm">
            <thead className="border-b bg-muted/40 text-xs font-medium tracking-wider text-muted-foreground uppercase">
              <tr>
                <th className="px-4 py-3">Cliente / ID</th>
                <th className="px-4 py-3">Tipo</th>
                <th className="px-4 py-3">Status Admin</th>
                <th className="px-4 py-3">Status Temporal</th>
                <th className="px-4 py-3">{t("Instalações")}</th>
                <th className="px-4 py-3">Validade</th>
                <th className="px-4 py-3 text-right">{t("Ação")}</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {licenses.map((lic) => (
                <tr key={lic.id} className="hover:bg-muted/20">
                  <td className="px-4 py-3">
                    <div className="font-medium text-foreground">{lic.customer_name}</div>
                    <div className="font-mono text-xs text-muted-foreground">
                      {lic.id.slice(0, 8)}...
                    </div>
                  </td>
                  <td className="px-4 py-3">
                    <span className="capitalize">{lic.license_type}</span>
                  </td>
                  <td className="px-4 py-3">
                    <StatusBadge status={lic.status} />
                  </td>
                  <td className="px-4 py-3">
                    <TemporalStateBadge state={lic.temporal_state} />
                  </td>
                  <td className="px-4 py-3">
                    <span className="font-mono">{lic.active_installations_count}</span>
                    <span className="font-mono text-muted-foreground">
                      {" "}
                      / {lic.max_installations}
                    </span>
                  </td>
                  <td className="px-4 py-3 text-xs text-muted-foreground">
                    {new Date(lic.expires_at).toLocaleDateString(tag)}
                  </td>
                  <td className="px-4 py-3 text-right">
                    <Button asChild variant="outline" size="sm">
                      <Link href={`/admin/licensing/licenses/${lic.id}`}>{t("Detalhes")}</Link>
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
