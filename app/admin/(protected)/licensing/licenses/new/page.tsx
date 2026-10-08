"use client";
import React, { useState, useEffect } from "react";
import { useRouter } from "next/navigation";
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
  const router = useRouter();
  const [customers, setCustomers] = useState<CustomerOption[]>([]);
  const [loadingCustomers, setLoadingCustomers] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Form states
  const [customerId, setCustomerId] = useState("");
  const [licenseType, setLicenseType] = useState<"enterprise" | "partner" | "internal">("enterprise");
  const [maxInstallations, setMaxInstallations] = useState(1);
  const [maxTenants, setMaxTenants] = useState<string>("");
  const [validFrom, setValidFrom] = useState(() => new Date().toISOString().slice(0, 10));
  const [expiresAt, setExpiresAt] = useState(() => {
    const d = new Date();
    d.setFullYear(d.getFullYear() + 1);
    return d.toISOString().slice(0, 10);
  });
  const [graceDays, setGraceDays] = useState(7);
  const [resaleAllowed, setResaleAllowed] = useState(false);
  const [whiteLabel, setWhiteLabel] = useState(false);
  const [features, setFeatures] = useState("ai_agent, analytics, automation");

  useEffect(() => {
    async function loadCustomers() {
      try {
        const res = await fetch("/api/v1/admin/licensing/customers?limit=100");
        if (res.ok) {
          const json = await res.json();
          setCustomers(json.data || []);
          if (json.data && json.data.length > 0) {
            setCustomerId(json.data[0].id);
          }
        }
      } catch (err) {
        console.error(err);
      } finally {
        setLoadingCustomers(false);
      }
    }
    loadCustomers();
  }, []);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setSubmitting(true);

    try {
      const payload = {
        customer_id: customerId,
        license_type: licenseType,
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

      const res = await fetch("/api/v1/admin/licensing/licenses", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });

      const json = await res.json();
      if (!res.ok) {
        setError(json.error?.message || "Erro ao criar licença.");
        return;
      }

      router.push(`/admin/licensing/licenses/${json.data.id}`);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "Erro desconhecido");
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="space-y-6 max-w-2xl">
      <div className="flex items-center gap-3">
        <Button asChild variant="outline" size="icon">
          <Link href="/admin/licensing/licenses">
            <ArrowLeft className="h-4 w-4" />
          </Link>
        </Button>
        <div>
          <h1 className="text-2xl font-bold tracking-tight">Emitir Nova Licença</h1>
          <p className="text-sm text-muted-foreground">
            Configure parâmetros comerciais, vigência e limites de instalação.
          </p>
        </div>
      </div>

      <LicensingNav />

      {error && (
        <div className="p-3 text-sm rounded bg-rose-500/10 text-rose-500 border border-rose-500/20">
          {error}
        </div>
      )}

      <form onSubmit={handleSubmit} className="border rounded-lg bg-card p-6 space-y-4">
        <div>
          <label className="text-xs font-medium text-muted-foreground uppercase tracking-wider block mb-1">
            Cliente Comercial
          </label>
          {loadingCustomers ? (
            <div className="text-sm text-muted-foreground">Carregando clientes...</div>
          ) : customers.length === 0 ? (
            <div className="text-sm text-amber-500">
              Nenhum cliente cadastrado. Cadastre um cliente primeiro em Clientes.
            </div>
          ) : (
            <select
              value={customerId}
              onChange={(e) => setCustomerId(e.target.value)}
              className="w-full h-9 px-3 rounded-md border border-input bg-background text-sm text-foreground focus:outline-none focus:ring-1 focus:ring-ring"
              required
            >
              {customers.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name} ({c.billing_email})
                </option>
              ))}
            </select>
          )}
        </div>

        <div className="grid grid-cols-2 gap-4">
          <div>
            <label className="text-xs font-medium text-muted-foreground uppercase tracking-wider block mb-1">
              Tipo de Licença
            </label>
            <select
              value={licenseType}
              onChange={(e) => setLicenseType(e.target.value as "enterprise" | "partner" | "internal")}
              className="w-full h-9 px-3 rounded-md border border-input bg-background text-sm text-foreground focus:outline-none focus:ring-1 focus:ring-ring"
            >
              <option value="enterprise">Enterprise</option>
              <option value="partner">Partner</option>
              <option value="internal">Internal</option>
            </select>
          </div>

          <div>
            <label className="text-xs font-medium text-muted-foreground uppercase tracking-wider block mb-1">
              Máx. Instalações
            </label>
            <Input
              type="number"
              min="1"
              value={maxInstallations}
              onChange={(e) => setMaxInstallations(Number(e.target.value))}
              required
            />
          </div>
        </div>

        <div className="grid grid-cols-2 gap-4">
          <div>
            <label className="text-xs font-medium text-muted-foreground uppercase tracking-wider block mb-1">
              Válido a partir de
            </label>
            <Input
              type="date"
              value={validFrom}
              onChange={(e) => setValidFrom(e.target.value)}
              required
            />
          </div>

          <div>
            <label className="text-xs font-medium text-muted-foreground uppercase tracking-wider block mb-1">
              Data de Expiração
            </label>
            <Input
              type="date"
              value={expiresAt}
              onChange={(e) => setExpiresAt(e.target.value)}
              required
            />
          </div>
        </div>

        <div className="grid grid-cols-2 gap-4">
          <div>
            <label className="text-xs font-medium text-muted-foreground uppercase tracking-wider block mb-1">
              Dias de Carência (Grace)
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
            <label className="text-xs font-medium text-muted-foreground uppercase tracking-wider block mb-1">
              Máx. Tenants (Vazio = Ilimitado)
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
          <label className="text-xs font-medium text-muted-foreground uppercase tracking-wider block mb-1">
            Features / Entitlements (separadas por vírgula)
          </label>
          <Input
            value={features}
            onChange={(e) => setFeatures(e.target.value)}
            placeholder="ai_agent, analytics, automation"
          />
        </div>

        <div className="flex items-center gap-6 pt-2">
          <label className="flex items-center gap-2 text-sm cursor-pointer">
            <input
              type="checkbox"
              checked={whiteLabel}
              onChange={(e) => setWhiteLabel(e.target.checked)}
              className="rounded border-input text-primary"
            />
            White Label Autorizado
          </label>

          <label className="flex items-center gap-2 text-sm cursor-pointer">
            <input
              type="checkbox"
              checked={resaleAllowed}
              onChange={(e) => setResaleAllowed(e.target.checked)}
              className="rounded border-input text-primary"
            />
            Revenda Autorizada (Partner)
          </label>
        </div>

        <div className="pt-4 flex justify-end gap-3 border-t">
          <Button asChild variant="outline" type="button">
            <Link href="/admin/licensing/licenses">Cancelar</Link>
          </Button>
          <Button type="submit" disabled={submitting || customers.length === 0}>
            {submitting && <CircleNotch className="h-4 w-4 animate-spin mr-1.5" />}
            Emitir Licença
          </Button>
        </div>
      </form>
    </div>
  );
}
