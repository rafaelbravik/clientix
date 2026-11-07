"use client";
import React, { useState, useEffect, useRef } from "react";
import { useT } from "@/lib/i18n/IdiomaProvider";
import { useRouter } from "next/navigation";
import { useSearchParams } from "next/navigation";
import Link from "next/link";
import { LicensingNav } from "@/components/admin/licensing/LicensingNav";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { ArrowLeft, CircleNotch } from "@/lib/ui/icons";

interface CustomerOption {
  id: string;
  name: string;
  billing_email: string;
}

export default function NewLicensePage() {
  const t = useT();
  const router = useRouter();
  const searchParams = useSearchParams();
  const requestedCustomerId = searchParams.get("customer_id");
  const [customers, setCustomers] = useState<CustomerOption[]>([]);
  const [loadingCustomers, setLoadingCustomers] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const lastSubmission = useRef<{ fingerprint: string; key: string } | null>(null);

  // Form states
  const [customerId, setCustomerId] = useState("");
  const [licenseType, setLicenseType] = useState<"enterprise" | "partner" | "internal">(
    "enterprise",
  );
  const [plan, setPlan] = useState<"standard" | "pro" | "enterprise">("pro");
  const [maxInstallations, setMaxInstallations] = useState(1);
  const [maxTenants, setMaxTenants] = useState<string>("");
  const [validFrom, setValidFrom] = useState(() => new Date().toISOString().slice(0, 10));
  const [expiresAt, setExpiresAt] = useState(() => {
    const d = new Date();
    d.setFullYear(d.getFullYear() + 1);
    return d.toISOString().slice(0, 10);
  });
  const [termPreset, setTermPreset] = useState("12");
  const [graceDays, setGraceDays] = useState(7);
  const [resaleAllowed, setResaleAllowed] = useState(false);
  const [whiteLabel, setWhiteLabel] = useState(false);
  const [features, setFeatures] = useState("");

  const chooseTerm = (term: string) => {
    setTermPreset(term);
    if (term === "custom") return;
    const date = new Date(`${validFrom}T12:00:00.000Z`);
    if (term.endsWith("d")) date.setUTCDate(date.getUTCDate() + Number(term.slice(0, -1)));
    else date.setUTCMonth(date.getUTCMonth() + Number(term));
    setExpiresAt(date.toISOString().slice(0, 10));
  };

  useEffect(() => {
    async function loadCustomers() {
      try {
        const res = await fetch("/api/v1/admin/customers?limit=100");
        if (res.ok) {
          const json = await res.json();
          setCustomers(json.data || []);
          if (
            requestedCustomerId &&
            json.data?.some((customer: CustomerOption) => customer.id === requestedCustomerId)
          ) {
            setCustomerId(requestedCustomerId);
          }
        }
      } catch (err) {
        console.error(err);
      } finally {
        setLoadingCustomers(false);
      }
    }
    loadCustomers();
  }, [requestedCustomerId]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setSubmitting(true);

    try {
      const payload = {
        customer_id: customerId,
        license_type: licenseType,
        plan,
        max_installations: Number(maxInstallations),
        max_tenants: maxTenants ? Number(maxTenants) : null,
        valid_from: new Date(validFrom).toISOString(),
        expires_at: new Date(expiresAt).toISOString(),
        grace_days: Number(graceDays),
        resale_allowed: resaleAllowed,
        white_label: whiteLabel,
        features: features
          .split(",")
          .map((f) => f.trim())
          .filter(Boolean),
      };

      const fingerprint = JSON.stringify(payload);
      if (!lastSubmission.current || lastSubmission.current.fingerprint !== fingerprint) {
        lastSubmission.current = { fingerprint, key: crypto.randomUUID() };
      }
      const res = await fetch("/api/v1/admin/licenses", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Idempotency-Key": lastSubmission.current.key,
        },
        body: JSON.stringify(payload),
      });

      const json = await res.json();
      if (!res.ok) {
        setError(json.error?.message || t("Erro ao criar licença."));
        return;
      }

      router.push(`/admin/licenses/${json.data.id}`);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : t("Erro desconhecido"));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="max-w-2xl space-y-6">
      <div className="flex items-center gap-3">
        <Button asChild variant="outline" size="icon">
          <Link href="/admin/licensing/licenses">
            <ArrowLeft className="h-4 w-4" />
          </Link>
        </Button>
        <div>
          <h1 className="text-2xl font-bold tracking-tight">{t("Emitir Nova Licença")}</h1>
          <p className="text-sm text-muted-foreground">
            {t("Configure parâmetros comerciais, vigência e limites de instalação.")}
          </p>
        </div>
      </div>

      <LicensingNav />

      {error && (
        <div className="rounded-md border border-rose-500/20 bg-rose-500/10 p-3 text-sm text-rose-500">
          {error}
        </div>
      )}

      <form onSubmit={handleSubmit} className="space-y-4 rounded-lg border bg-card p-6">
        <div>
          <label className="mb-1 block text-xs font-medium tracking-wider text-muted-foreground uppercase">
            Cliente Comercial
          </label>
          {loadingCustomers ? (
            <div className="text-sm text-muted-foreground">Carregando clientes...</div>
          ) : customers.length === 0 ? (
            <div className="space-y-2 text-sm text-amber-700">
              <p>{t("Nenhum cliente cadastrado. Cadastre um cliente primeiro em Clientes.")}</p>
              <Button asChild variant="outline" size="sm">
                <Link href="/admin/customers/new">Cadastrar cliente</Link>
              </Button>
            </div>
          ) : (
            <select
              value={customerId}
              onChange={(e) => setCustomerId(e.target.value)}
              className="h-9 w-full rounded-md border border-input bg-background px-3 text-sm text-foreground focus:ring-1 focus:ring-ring focus:outline-hidden"
              required
            >
              <option value="" disabled>
                Selecione um cliente
              </option>
              {customers.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name} ({c.billing_email})
                </option>
              ))}
            </select>
          )}
        </div>

        <div>
          <label className="mb-1 block text-xs font-medium tracking-wider text-muted-foreground uppercase">
            Plano comercial da instalação
          </label>
          <select
            value={plan}
            onChange={(e) => setPlan(e.target.value as "standard" | "pro" | "enterprise")}
            className="h-9 w-full rounded-md border border-input bg-background px-3 text-sm text-foreground focus:ring-1 focus:ring-ring focus:outline-hidden"
          >
            <option value="standard">Essencial</option>
            <option value="pro">Profissional</option>
            <option value="enterprise">Escala</option>
          </select>
          <p className="mt-1 text-xs text-muted-foreground">
            Este plano comercial da instalação é independente dos planos dos tenants.
          </p>
        </div>

        <div className="grid grid-cols-2 gap-4">
          <div>
            <label className="mb-1 block text-xs font-medium tracking-wider text-muted-foreground uppercase">
              {t("Tipo de Licença")}
            </label>
            <select
              value={licenseType}
              onChange={(e) =>
                setLicenseType(e.target.value as "enterprise" | "partner" | "internal")
              }
              className="h-9 w-full rounded-md border border-input bg-background px-3 text-sm text-foreground focus:ring-1 focus:ring-ring focus:outline-hidden"
            >
              <option value="enterprise">Enterprise</option>
              <option value="partner">Partner</option>
              <option value="internal">Internal</option>
            </select>
          </div>

          <div>
            <label className="mb-1 block text-xs font-medium tracking-wider text-muted-foreground uppercase">
              {t("Máx. Instalações")}
            </label>
            <Input
              type="number"
              min="1"
              max="10000"
              value={maxInstallations}
              onChange={(e) => setMaxInstallations(Number(e.target.value))}
              required
            />
          </div>
        </div>

        <div className="grid grid-cols-2 gap-4">
          <div>
            <label className="mb-1 block text-xs font-medium tracking-wider text-muted-foreground uppercase">
              {t("Válido a partir de")}
            </label>
            <Input
              type="date"
              value={validFrom}
              onChange={(e) => setValidFrom(e.target.value)}
              required
            />
          </div>

          <div>
            <label className="mb-1 block text-xs font-medium tracking-wider text-muted-foreground uppercase">
              {t("Data de Expiração")}
            </label>
            <select
              value={termPreset}
              onChange={(event) => chooseTerm(event.target.value)}
              className="mb-2 h-9 w-full rounded-md border border-input bg-background px-3 text-sm"
            >
              <option value="30d">30 dias</option>
              <option value="90d">90 dias</option>
              <option value="6">6 meses</option>
              <option value="12">12 meses (padrão)</option>
              <option value="24">24 meses</option>
              <option value="custom">Data personalizada</option>
            </select>
            <Input
              type="date"
              value={expiresAt}
              onChange={(e) => {
                setTermPreset("custom");
                setExpiresAt(e.target.value);
              }}
              required
            />
          </div>
        </div>

        <div className="grid grid-cols-2 gap-4">
          <div>
            <label className="mb-1 block text-xs font-medium tracking-wider text-muted-foreground uppercase">
              {t("Dias de Carência (Grace)")}
            </label>
            <Input
              type="number"
              min="0"
              max="90"
              value={graceDays}
              onChange={(e) => setGraceDays(Number(e.target.value))}
              required
            />
          </div>

          <div>
            <label className="mb-1 block text-xs font-medium tracking-wider text-muted-foreground uppercase">
              {t("Máx. Tenants (Vazio = Ilimitado)")}
            </label>
            <Input
              type="number"
              min="1"
              placeholder="Ilimitado"
              value={maxTenants}
              onChange={(e) => setMaxTenants(e.target.value)}
            />
          </div>
        </div>

        <div>
          <label className="mb-1 block text-xs font-medium tracking-wider text-muted-foreground uppercase">
            {t("Features / Entitlements (separadas por vírgula)")}
          </label>
          <Input
            value={features}
            onChange={(e) => setFeatures(e.target.value)}
            placeholder="ai_agent, analytics, automation"
          />
        </div>

        <div className="flex items-center gap-6 pt-2">
          <label className="flex cursor-pointer items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={whiteLabel}
              onChange={(e) => setWhiteLabel(e.target.checked)}
              className="rounded-md border-input text-primary"
            />
            White Label Autorizado
          </label>

          <label className="flex cursor-pointer items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={resaleAllowed}
              onChange={(e) => setResaleAllowed(e.target.checked)}
              className="rounded-md border-input text-primary"
            />
            Revenda Autorizada (Partner)
          </label>
        </div>

        <div className="flex justify-end gap-3 border-t pt-4">
          <Button asChild variant="outline" type="button">
            <Link href="/admin/licenses">Cancelar</Link>
          </Button>
          <Button type="submit" disabled={submitting || customers.length === 0}>
            {submitting && <CircleNotch className="mr-1.5 h-4 w-4 animate-spin" />}
            Criar rascunho
          </Button>
        </div>
      </form>
    </div>
  );
}
