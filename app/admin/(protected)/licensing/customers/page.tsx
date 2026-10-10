"use client";
import React, { useState, useEffect } from "react";
import { useT } from "@/lib/i18n/IdiomaProvider";
import Link from "next/link";
import { LicensingNav } from "@/components/admin/licensing/LicensingNav";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Plus, MagnifyingGlass, CircleNotch, X } from "@/lib/ui/icons";
import { useTagDeIdioma } from "@/hooks/i18n/useLocaleDeData";

interface CustomerItem {
  id: string;
  name: string;
  legal_name: string | null;
  billing_email: string;
  country: string | null;
  created_at: string;
}

export default function AdminCustomersPage() {
  const t = useT();
  const tag = useTagDeIdioma();
  const [customers, setCustomers] = useState<CustomerItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState("");

  // Modal create
  const [showCreateModal, setShowCreateModal] = useState(false);
  const [name, setName] = useState("");
  const [legalName, setLegalName] = useState("");
  const [billingEmail, setBillingEmail] = useState("");
  const [country, setCountry] = useState("BR");
  const [submitting, setSubmitting] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);

  const fetchCustomers = async () => {
    setLoading(true);
    try {
      const params = new URLSearchParams();
      if (search) params.set("search", search);

      const res = await fetch(`/api/v1/admin/licensing/customers?${params.toString()}`);
      if (res.ok) {
        const json = await res.json();
        setCustomers(json.data || []);
      }
    } catch (err) {
      console.error(err);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchCustomers();
  }, []);

  const handleSearchSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    fetchCustomers();
  };

  const handleCreateCustomer = async (e: React.FormEvent) => {
    e.preventDefault();
    setCreateError(null);
    setSubmitting(true);
    try {
      const res = await fetch("/api/v1/admin/licensing/customers", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name,
          legal_name: legalName || null,
          billing_email: billingEmail,
          country: country ? country.toUpperCase() : null,
        }),
      });
      const json = await res.json();
      if (res.ok) {
        setShowCreateModal(false);
        setName("");
        setLegalName("");
        setBillingEmail("");
        await fetchCustomers();
      } else {
        setCreateError(json.error?.message || "Erro ao cadastrar cliente.");
      }
    } catch (err: unknown) {
      setCreateError(err instanceof Error ? err.message : t("Erro desconhecido"));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="space-y-6">
      <div className="flex flex-col justify-between gap-4 sm:flex-row sm:items-center">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">Clientes Comerciais</h1>
          <p className="text-sm text-muted-foreground">
            {t("Entidades contratantes de licenças comerciais.")}
          </p>
        </div>
        <Button size="sm" onClick={() => setShowCreateModal(true)}>
          <Plus className="mr-1.5 h-4 w-4" /> Novo Cliente
        </Button>
      </div>

      <LicensingNav />

      {/* Search */}
      <form onSubmit={handleSearchSubmit} className="flex max-w-sm gap-2">
        <Input
          placeholder={t("Buscar por nome, razão social ou e-mail...")}
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
        <Button type="submit" variant="secondary" size="icon">
          <MagnifyingGlass className="h-4 w-4" />
        </Button>
      </form>

      {/* Table */}
      <div className="overflow-hidden rounded-lg border bg-card">
        {loading ? (
          <div className="flex items-center justify-center p-8 text-center text-muted-foreground">
            <CircleNotch className="mr-2 h-5 w-5 animate-spin" /> Carregando clientes...
          </div>
        ) : customers.length === 0 ? (
          <div className="p-8 text-center text-sm text-muted-foreground">
            {t("Nenhum cliente cadastrado.")}
          </div>
        ) : (
          <table className="w-full text-left text-sm">
            <thead className="border-b bg-muted/40 text-xs font-medium tracking-wider text-muted-foreground uppercase">
              <tr>
                <th className="px-4 py-3">{t("Nome / Razão Social")}</th>
                <th className="px-4 py-3">E-mail Financeiro</th>
                <th className="px-4 py-3">{t("País")}</th>
                <th className="px-4 py-3">Cadastrado em</th>
                <th className="px-4 py-3 text-right">{t("Ação")}</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {customers.map((c) => (
                <tr key={c.id} className="hover:bg-muted/20">
                  <td className="px-4 py-3">
                    <div className="font-medium text-foreground">{c.name}</div>
                    {c.legal_name && (
                      <div className="text-xs text-muted-foreground">{c.legal_name}</div>
                    )}
                  </td>
                  <td className="px-4 py-3 text-foreground">{c.billing_email}</td>
                  <td className="px-4 py-3 font-mono text-xs">{c.country || "—"}</td>
                  <td className="px-4 py-3 text-xs text-muted-foreground">
                    {new Date(c.created_at).toLocaleDateString(tag)}
                  </td>
                  <td className="px-4 py-3 text-right">
                    <Button asChild variant="outline" size="sm">
                      <Link href={`/admin/licensing/customers/${c.id}`}>{t("Detalhes")}</Link>
                    </Button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {/* Create Modal */}
      {showCreateModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4">
          <div className="w-full max-w-md space-y-4 rounded-lg border bg-card p-6 shadow-xl">
            <div className="flex items-center justify-between">
              <h3 className="text-lg font-bold">Cadastrar Cliente Comercial</h3>
              <Button variant="ghost" size="icon" onClick={() => setShowCreateModal(false)}>
                <X className="h-4 w-4" />
              </Button>
            </div>

            {createError && (
              <div className="rounded-md border border-rose-500/20 bg-rose-500/10 p-3 text-xs text-rose-500">
                {createError}
              </div>
            )}

            <form onSubmit={handleCreateCustomer} className="space-y-3">
              <div>
                <label className="mb-1 block text-xs font-medium tracking-wider text-muted-foreground uppercase">
                  Nome Fantasia / Empresa
                </label>
                <Input
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder={t("Ex: Agência Alfa")}
                  required
                />
              </div>

              <div>
                <label className="mb-1 block text-xs font-medium tracking-wider text-muted-foreground uppercase">
                  {t("Razão Social (Opcional)")}
                </label>
                <Input
                  value={legalName}
                  onChange={(e) => setLegalName(e.target.value)}
                  placeholder={t("Ex: Alfa Soluções Digitais LTDA")}
                />
              </div>

              <div>
                <label className="mb-1 block text-xs font-medium tracking-wider text-muted-foreground uppercase">
                  {t("E-mail Financeiro / Cobrança")}
                </label>
                <Input
                  type="email"
                  value={billingEmail}
                  onChange={(e) => setBillingEmail(e.target.value)}
                  placeholder="financeiro@alfa.com"
                  required
                />
              </div>

              <div>
                <label className="mb-1 block text-xs font-medium tracking-wider text-muted-foreground uppercase">
                  {t("País (Código ISO 2 Letras)")}
                </label>
                <Input
                  maxLength={2}
                  value={country}
                  onChange={(e) => setCountry(e.target.value.toUpperCase())}
                  placeholder="BR"
                />
              </div>

              <div className="flex justify-end gap-2 border-t pt-3">
                <Button type="button" variant="outline" onClick={() => setShowCreateModal(false)}>
                  Cancelar
                </Button>
                <Button type="submit" disabled={submitting}>
                  {submitting && <CircleNotch className="mr-1.5 h-4 w-4 animate-spin" />}
                  Salvar Cliente
                </Button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}
