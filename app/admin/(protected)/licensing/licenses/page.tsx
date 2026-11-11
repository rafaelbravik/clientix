"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { LicensingNav } from "@/components/admin/licensing/LicensingNav";
import { StatusBadge, TemporalStateBadge } from "@/components/admin/licensing/Badges";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useT } from "@/hooks/i18n/useT";
import { useTagDeIdioma } from "@/hooks/i18n/useLocaleDeData";
import { CircleNotch, DownloadSimple, MagnifyingGlass, Plus } from "@/lib/ui/icons";

type Plan = "standard" | "pro" | "enterprise";
interface LicenseItem {
  id: string;
  customer_id: string;
  customer_name: string;
  serial: string;
  plan: Plan;
  status: "DRAFT" | "ACTIVE" | "EXPIRED" | "SUSPENDED" | "REVOKED";
  temporal_state: "VALID" | "GRACE" | "EXPIRED" | "NOT_YET_VALID";
  max_installations: number;
  active_installations_count: number;
  last_validation_at: string | null;
  clone_status?: "SUSPECTED_CLONE" | "CLONE_CONFIRMED" | "TRANSFER_PENDING" | null;
  valid_from: string;
  expires_at: string;
  days_remaining: number;
}
interface Summary {
  total_customers: number;
  active_licenses: number;
  grace_licenses: number;
  expired_licenses: number;
  suspended_licenses: number;
  revoked_licenses: number;
  expiring_30_days: number;
  expiring_15_days: number;
  expiring_7_days: number;
  expiring_1_day: number;
  active_installations: number;
  suspicious_clones: number;
  upcoming_expirations: Array<{
    id: string;
    serial: string;
    customer_name: string;
    plan: Plan;
    status: string;
    expires_at: string;
    days_remaining: number;
  }>;
}
interface CustomerFilterOption {
  id: string;
  name: string;
}

const PLAN_LABEL: Record<Plan, string> = {
  standard: "Essencial",
  pro: "Profissional",
  enterprise: "Escala",
};

function SummaryCard({
  label,
  value,
  warning = false,
}: {
  label: string;
  value: number;
  warning?: boolean;
}) {
  return (
    <div className="min-w-0 rounded-lg border bg-card p-4">
      <div className="text-xs font-medium tracking-wide text-muted-foreground uppercase">
        {label}
      </div>
      <div
        className={`mt-2 text-2xl font-semibold tabular-nums ${warning ? "text-amber-600" : "text-foreground"}`}
      >
        {value}
      </div>
    </div>
  );
}

export default function AdminLicensesPage() {
  const t = useT();
  const tag = useTagDeIdioma();
  const [licenses, setLicenses] = useState<LicenseItem[]>([]);
  const [summary, setSummary] = useState<Summary | null>(null);
  const [customers, setCustomers] = useState<CustomerFilterOption[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [searchDraft, setSearchDraft] = useState("");
  const [search, setSearch] = useState("");
  const [status, setStatus] = useState("ALL");
  const [plan, setPlan] = useState("ALL");
  const [validity, setValidity] = useState("ALL");
  const [installationStatus, setInstallationStatus] = useState("ALL");
  const [cloneStatus, setCloneStatus] = useState("ALL");
  const [expiryDays, setExpiryDays] = useState("ALL");
  const [customerId, setCustomerId] = useState("ALL");
  const [sort, setSort] = useState("expires_at");
  const [direction, setDirection] = useState<"asc" | "desc">("asc");
  const [offset, setOffset] = useState(0);
  const limit = 25;

  const fetchData = useCallback(
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
        if (plan !== "ALL") params.set("plan", plan);
        if (validity !== "ALL") params.set("validity", validity);
        if (installationStatus !== "ALL") params.set("installation_status", installationStatus);
        if (cloneStatus !== "ALL") params.set("clone_status", cloneStatus);
        if (expiryDays !== "ALL") params.set("expires_in_days", expiryDays);
        if (customerId !== "ALL") params.set("customer_id", customerId);
        const [licenseResponse, summaryResponse, customersResponse] = await Promise.all([
          fetch(`/api/v1/admin/licenses?${params}`),
          fetch("/api/v1/admin/licensing/dashboard"),
          fetch("/api/v1/admin/licensing/customers?limit=100&sort=name&direction=asc"),
        ]);
        if (!licenseResponse.ok || !summaryResponse.ok || !customersResponse.ok)
          throw new Error("Não foi possível carregar o painel comercial.");
        const [licenseJson, summaryJson, customersJson] = await Promise.all([
          licenseResponse.json(),
          summaryResponse.json(),
          customersResponse.json(),
        ]);
        setLicenses(licenseJson.data ?? []);
        setTotal(licenseJson.meta?.total ?? 0);
        setSummary(summaryJson.data ?? null);
        setCustomers(customersJson.data ?? []);
        setOffset(nextOffset);
      } catch (caught) {
        setError(caught instanceof Error ? caught.message : "Erro ao carregar licenças.");
      } finally {
        setLoading(false);
      }
    },
    [
      search,
      status,
      plan,
      validity,
      installationStatus,
      cloneStatus,
      expiryDays,
      customerId,
      sort,
      direction,
    ],
  );

  useEffect(() => {
    void fetchData(0);
  }, [fetchData]);

  const exportParams = new URLSearchParams();
  if (search) exportParams.set("search", search);
  if (status !== "ALL") exportParams.set("status", status);
  if (plan !== "ALL") exportParams.set("plan", plan);
  if (customerId !== "ALL") exportParams.set("customer_id", customerId);
  if (validity !== "ALL") exportParams.set("validity", validity);
  if (cloneStatus !== "ALL") exportParams.set("clone_status", cloneStatus);
  if (expiryDays !== "ALL") exportParams.set("expires_in_days", expiryDays);

  return (
    <div className="space-y-6">
      <header className="flex flex-col justify-between gap-4 sm:flex-row sm:items-center">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">{t("Administração comercial")}</h1>
          <p className="text-sm text-muted-foreground">
            {t("Clientes, licenças e instalações do Control Plane do fornecedor.")}
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button asChild variant="outline" size="sm">
            <button
              type="button"
              onClick={() =>
                window.location.assign(`/api/v1/admin/licenses/export?${exportParams}`)
              }
            >
              <DownloadSimple className="mr-2 h-4 w-4" />
              Exportar CSV
            </button>
          </Button>
          <Button asChild size="sm">
            <Link href="/admin/licenses/new">
              <Plus className="mr-1.5 h-4 w-4" />
              {t("Nova licença")}
            </Link>
          </Button>
        </div>
      </header>

      <LicensingNav />

      {summary && (
        <section
          aria-label="Resumo comercial"
          className="grid grid-cols-2 gap-3 sm:grid-cols-3 xl:grid-cols-5"
        >
          <SummaryCard label="Clientes" value={summary.total_customers} />
          <SummaryCard label="Ativas" value={summary.active_licenses} />
          <SummaryCard
            label="Em grace"
            value={summary.grace_licenses}
            warning={summary.grace_licenses > 0}
          />
          <SummaryCard
            label="Expiradas"
            value={summary.expired_licenses}
            warning={summary.expired_licenses > 0}
          />
          <SummaryCard
            label="Vencem em 30 dias"
            value={summary.expiring_30_days}
            warning={summary.expiring_30_days > 0}
          />
          <SummaryCard label="Suspensas" value={summary.suspended_licenses} />
          <SummaryCard label="Revogadas" value={summary.revoked_licenses} />
          <SummaryCard
            label="Vencem em 15 dias"
            value={summary.expiring_15_days}
            warning={summary.expiring_15_days > 0}
          />
          <SummaryCard
            label="Vencem em 7 dias"
            value={summary.expiring_7_days}
            warning={summary.expiring_7_days > 0}
          />
          <SummaryCard
            label="Vencem em 1 dia"
            value={summary.expiring_1_day}
            warning={summary.expiring_1_day > 0}
          />
          <SummaryCard label={t("Instalações ativas")} value={summary.active_installations} />
          <SummaryCard
            label="Clones suspeitos"
            value={summary.suspicious_clones}
            warning={summary.suspicious_clones > 0}
          />
        </section>
      )}

      {summary?.upcoming_expirations.length ? (
        <section className="rounded-lg border bg-card p-4">
          <h2 className="mb-3 text-sm font-semibold">{t("Próximos vencimentos")}</h2>
          <div className="grid gap-2 sm:grid-cols-2 xl:grid-cols-3">
            {summary.upcoming_expirations.map((item) => (
              <Link
                key={item.id}
                href={`/admin/licenses/${item.id}`}
                className="flex min-w-0 items-center justify-between gap-3 rounded-md border p-3 hover:bg-muted/40"
              >
                <span className="min-w-0">
                  <span className="block truncate text-sm font-medium">{item.customer_name}</span>
                  <span className="font-mono text-xs text-muted-foreground">
                    {item.serial} · {PLAN_LABEL[item.plan]}
                  </span>
                </span>
                <span className="shrink-0 text-right text-xs">
                  <span className="block">{new Date(item.expires_at).toLocaleDateString(tag)}</span>
                  <span className="text-amber-700">{item.days_remaining} dias</span>
                </span>
              </Link>
            ))}
          </div>
        </section>
      ) : null}

      <section className="space-y-3 rounded-lg border bg-card p-4">
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
            placeholder={t("Serial, cliente, documento, e-mail ou ID de instalação")}
            aria-label={t("Buscar licenças")}
          />
          <Button type="submit" variant="secondary" size="icon" aria-label="Buscar">
            <MagnifyingGlass className="h-4 w-4" />
          </Button>
        </form>
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 xl:grid-cols-6">
          <select
            aria-label="Filtrar cliente"
            value={customerId}
            onChange={(event) => setCustomerId(event.target.value)}
            className="h-9 min-w-0 rounded-md border bg-background px-2 text-sm"
          >
            <option value="ALL">{t("Todos os clientes")}</option>
            {customers.map((customer) => (
              <option key={customer.id} value={customer.id}>
                {customer.name}
              </option>
            ))}
          </select>
          <select
            aria-label="Filtrar status"
            value={status}
            onChange={(event) => setStatus(event.target.value)}
            className="h-9 min-w-0 rounded-md border bg-background px-2 text-sm"
          >
            <option value="ALL">{t("Todos os status")}</option>
            {["DRAFT", "ACTIVE", "SUSPENDED", "EXPIRED", "REVOKED"].map((value) => (
              <option key={value}>{value}</option>
            ))}
          </select>
          <select
            aria-label="Filtrar plano"
            value={plan}
            onChange={(event) => setPlan(event.target.value)}
            className="h-9 min-w-0 rounded-md border bg-background px-2 text-sm"
          >
            <option value="ALL">{t("Todos os planos")}</option>
            <option value="standard">Essencial</option>
            <option value="pro">Profissional</option>
            <option value="enterprise">Escala</option>
          </select>
          <select
            aria-label="Filtrar validade"
            value={validity}
            onChange={(event) => setValidity(event.target.value)}
            className="h-9 min-w-0 rounded-md border bg-background px-2 text-sm"
          >
            <option value="ALL">Qualquer validade</option>
            <option value="VALID">{t("Válida")}</option>
            <option value="GRACE">Grace</option>
            <option value="EXPIRED">Expirada</option>
            <option value="NOT_YET_VALID">Futura</option>
          </select>
          <select
            aria-label={t("Filtrar instalação")}
            value={installationStatus}
            onChange={(event) => setInstallationStatus(event.target.value)}
            className="h-9 min-w-0 rounded-md border bg-background px-2 text-sm"
          >
            <option value="ALL">{t("Instalações: todas")}</option>
            <option value="ACTIVE">{t("Com ativa")}</option>
            <option value="INACTIVE">{t("Sem ativa")}</option>
          </select>
          <select
            aria-label="Filtrar clone"
            value={cloneStatus}
            onChange={(event) => setCloneStatus(event.target.value)}
            className="h-9 min-w-0 rounded-md border bg-background px-2 text-sm"
          >
            <option value="ALL">{t("Clone: todos")}</option>
            <option value="SUSPECTED_CLONE">Suspeito</option>
            <option value="CLONE_CONFIRMED">Confirmado</option>
            <option value="TRANSFER_PENDING">{t("Transferência")}</option>
          </select>
          <select
            aria-label="Filtrar vencimento"
            value={expiryDays}
            onChange={(event) => setExpiryDays(event.target.value)}
            className="h-9 min-w-0 rounded-md border bg-background px-2 text-sm"
          >
            <option value="ALL">{t("Vencimento: todos")}</option>
            <option value="1">{t("Até 1 dia")}</option>
            <option value="7">{t("Até 7 dias")}</option>
            <option value="15">{t("Até 15 dias")}</option>
            <option value="30">{t("Até 30 dias")}</option>
          </select>
          <select
            aria-label={t("Ordenar licenças")}
            value={sort}
            onChange={(event) => setSort(event.target.value)}
            className="h-9 min-w-0 rounded-md border bg-background px-2 text-sm"
          >
            <option value="customer">Cliente</option>
            <option value="status">Status</option>
            <option value="expires_at">Validade</option>
            <option value="created_at">{t("Criação")}</option>
            <option value="last_validation">{t("Última validação")}</option>
          </select>
          <Button
            type="button"
            variant="outline"
            onClick={() => setDirection((current) => (current === "asc" ? "desc" : "asc"))}
          >
            Ordem {direction === "asc" ? "↑" : "↓"}
          </Button>
        </div>
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
            {t("Carregando licenças…")}
          </div>
        ) : licenses.length === 0 ? (
          <div className="p-10 text-center text-sm text-muted-foreground">
            {t("Nenhuma licença corresponde aos filtros.")}
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[900px] text-left text-sm">
              <thead className="border-b bg-muted/40 text-xs tracking-wide text-muted-foreground uppercase">
                <tr>
                  <th className="px-4 py-3">Cliente / serial</th>
                  <th className="px-4 py-3">Plano</th>
                  <th className="px-4 py-3">Status</th>
                  <th className="px-4 py-3">Validade</th>
                  <th className="px-4 py-3">{t("Instalações")}</th>
                  <th className="px-4 py-3">{t("Última validação")}</th>
                  <th className="px-4 py-3">Clone</th>
                  <th className="px-4 py-3 text-right">{t("Ação")}</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {licenses.map((license) => {
                  return (
                    <tr key={license.id} className="hover:bg-muted/20">
                      <td className="px-4 py-3">
                        <span className="block font-medium">{license.customer_name}</span>
                        <span className="font-mono text-xs text-muted-foreground">
                          {license.serial}
                        </span>
                      </td>
                      <td className="px-4 py-3">{PLAN_LABEL[license.plan]}</td>
                      <td className="px-4 py-3">
                        <div className="space-y-1">
                          <StatusBadge status={license.status} />
                          <TemporalStateBadge state={license.temporal_state} />
                        </div>
                      </td>
                      <td className="px-4 py-3 text-xs">
                        {new Date(license.expires_at).toLocaleDateString(tag)}
                        <span className="block text-muted-foreground">
                          {license.days_remaining >= 0
                            ? `${license.days_remaining} dias`
                            : `${Math.abs(license.days_remaining)} dias vencida`}
                        </span>
                      </td>
                      <td className="px-4 py-3 tabular-nums">
                        {license.active_installations_count}/{license.max_installations}
                      </td>
                      <td className="px-4 py-3 text-xs">
                        {license.last_validation_at
                          ? new Date(license.last_validation_at).toLocaleString(tag)
                          : t("Nunca")}
                      </td>
                      <td className="px-4 py-3 text-xs">{license.clone_status ?? "NORMAL"}</td>
                      <td className="px-4 py-3 text-right">
                        <Button asChild size="sm" variant="outline">
                          <Link href={`/admin/licenses/${license.id}`}>{t("Detalhes")}</Link>
                        </Button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
        <footer className="flex items-center justify-between gap-3 border-t px-4 py-3 text-xs text-muted-foreground">
          <span>
            {total
              ? `${offset + 1}–${Math.min(offset + licenses.length, total)} de ${total}`
              : "0 resultados"}
          </span>
          <div className="flex gap-2">
            <Button
              size="sm"
              variant="outline"
              disabled={offset === 0 || loading}
              onClick={() => void fetchData(Math.max(0, offset - limit))}
            >
              Anterior
            </Button>
            <Button
              size="sm"
              variant="outline"
              disabled={offset + limit >= total || loading}
              onClick={() => void fetchData(offset + limit)}
            >
              {t("Próxima")}
            </Button>
          </div>
        </footer>
      </section>
    </div>
  );
}
