"use client";
import React, { useState, useEffect } from "react";
import { useParams } from "next/navigation";
import Link from "next/link";
import { LicensingNav } from "@/components/admin/licensing/LicensingNav";
import { StatusBadge, TemporalStateBadge } from "@/components/admin/licensing/Badges";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { ArrowLeft, CircleNotch, Plus, PencilSimple, X } from "@/lib/ui/icons";
import { useTagDeIdioma } from "@/hooks/i18n/useLocaleDeData";

interface CustomerLicenseItem {
  id: string;
  license_type: string;
  status: "ACTIVE" | "SUSPENDED" | "REVOKED";
  temporal_state: string;
  max_installations: number;
  active_installations_count: number;
  expires_at: string;
}

interface CustomerDetailData {
  customer: {
    id: string;
    name: string;
    legal_name: string | null;
    billing_email: string;
    country: string | null;
    created_at: string;
    updated_at: string;
  };
  licenses: CustomerLicenseItem[];
}

export default function CustomerDetailPage() {
  const tag = useTagDeIdioma();
  const params = useParams();
  const id = params?.id as string;

  const [data, setData] = useState<CustomerDetailData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Edit customer modal
  const [showEditModal, setShowEditModal] = useState(false);
  const [name, setName] = useState("");
  const [legalName, setLegalName] = useState("");
  const [billingEmail, setBillingEmail] = useState("");
  const [country, setCountry] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [editError, setEditError] = useState<string | null>(null);

  const loadCustomer = async () => {
    try {
      const res = await fetch(`/api/v1/admin/licensing/customers/${id}`);
      if (res.ok) {
        const json = await res.json();
        setData(json.data);
        setName(json.data.customer.name);
        setLegalName(json.data.customer.legal_name || "");
        setBillingEmail(json.data.customer.billing_email);
        setCountry(json.data.customer.country || "");
      } else {
        setError("Cliente não encontrado.");
      }
    } catch (err) {
      console.error(err);
      setError("Erro ao carregar dados do cliente.");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (id) loadCustomer();
  }, [id]);

  const handleUpdate = async (e: React.FormEvent) => {
    e.preventDefault();
    setEditError(null);
    setSubmitting(true);
    try {
      const res = await fetch(`/api/v1/admin/licensing/customers/${id}`, {
        method: "PATCH",
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
        setShowEditModal(false);
        await loadCustomer();
      } else {
        setEditError(json.error?.message || "Erro ao atualizar dados.");
      }
    } catch (err: unknown) {
      setEditError(err instanceof Error ? err.message : "Erro desconhecido");
    } finally {
      setSubmitting(false);
    }
  };

  if (loading) {
    return (
      <div className="p-8 text-center flex items-center justify-center text-muted-foreground">
        <CircleNotch className="h-5 w-5 animate-spin mr-2" /> Carregando perfil do cliente...
      </div>
    );
  }

  if (error || !data) {
    return (
      <div className="space-y-4">
        <Button asChild variant="outline" size="sm">
          <Link href="/admin/licensing/customers">
            <ArrowLeft className="mr-1.5 h-4 w-4" /> Voltar
          </Link>
        </Button>
        <div className="p-4 rounded-md bg-rose-500/10 text-rose-500">{error || "Não encontrado"}</div>
      </div>
    );
  }

  const { customer, licenses } = data;

  return (
    <div className="space-y-6">
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div className="flex items-center gap-3">
          <Button asChild variant="outline" size="icon">
            <Link href="/admin/licensing/customers">
              <ArrowLeft className="h-4 w-4" />
            </Link>
          </Button>
          <div>
            <h1 className="text-2xl font-bold tracking-tight">{customer.name}</h1>
            <p className="text-xs text-muted-foreground font-mono">ID: {customer.id}</p>
          </div>
        </div>

        <div className="flex items-center gap-2">
          <Button variant="outline" size="sm" onClick={() => setShowEditModal(true)}>
            <PencilSimple className="mr-1.5 h-3.5 w-3.5" /> Editar Dados
          </Button>
          <Button asChild size="sm">
            <Link href={`/admin/licensing/licenses/new`}>
              <Plus className="mr-1.5 h-3.5 w-3.5" /> Nova Licença
            </Link>
          </Button>
        </div>
      </div>

      <LicensingNav />

      {/* Overview Cards */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
        <div className="border rounded-lg bg-card p-5 space-y-3">
          <h2 className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">
            Dados Cadastrais
          </h2>
          <div className="space-y-1.5 text-sm">
            <div className="flex justify-between py-1 border-b border-border/50">
              <span className="text-muted-foreground">Razão Social:</span>
              <span>{customer.legal_name || "—"}</span>
            </div>
            <div className="flex justify-between py-1 border-b border-border/50">
              <span className="text-muted-foreground">E-mail de Faturamento:</span>
              <span className="font-medium">{customer.billing_email}</span>
            </div>
            <div className="flex justify-between py-1 border-b border-border/50">
              <span className="text-muted-foreground">País (ISO):</span>
              <span className="font-mono">{customer.country || "—"}</span>
            </div>
            <div className="flex justify-between py-1">
              <span className="text-muted-foreground">Data de Cadastro:</span>
              <span>{new Date(customer.created_at).toLocaleString(tag)}</span>
            </div>
          </div>
        </div>

        <div className="border rounded-lg bg-card p-5 space-y-3">
          <h2 className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">
            Resumo de Contratos
          </h2>
          <div className="space-y-1.5 text-sm">
            <div className="flex justify-between py-1 border-b border-border/50">
              <span className="text-muted-foreground">Total de Licenças:</span>
              <span className="font-semibold">{licenses.length}</span>
            </div>
            <div className="flex justify-between py-1 border-b border-border/50">
              <span className="text-muted-foreground">Licenças Ativas:</span>
              <span className="font-semibold text-emerald-500">
                {licenses.filter((l) => l.status === "ACTIVE").length}
              </span>
            </div>
            <div className="flex justify-between py-1">
              <span className="text-muted-foreground">Instalações em Operação:</span>
              <span className="font-semibold">
                {licenses.reduce((acc: number, l) => acc + (l.active_installations_count || 0), 0)}
              </span>
            </div>
          </div>
        </div>
      </div>

      {/* Licenses list */}
      <div className="border rounded-lg bg-card p-6 space-y-4">
        <div>
          <h2 className="text-base font-semibold">Licenças Emitidas</h2>
          <p className="text-xs text-muted-foreground">
            Todas as licenças atribuídas a este cliente comercial.
          </p>
        </div>

        {licenses.length === 0 ? (
          <div className="text-center py-6 text-sm text-muted-foreground border border-dashed rounded-lg">
            Nenhuma licença emitida para este cliente.
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm text-left">
              <thead className="bg-muted/40 text-muted-foreground text-xs uppercase border-b">
                <tr>
                  <th className="px-3 py-2">ID</th>
                  <th className="px-3 py-2">Tipo</th>
                  <th className="px-3 py-2">Status Admin</th>
                  <th className="px-3 py-2">Status Temporal</th>
                  <th className="px-3 py-2">Instalações</th>
                  <th className="px-3 py-2">Expiração</th>
                  <th className="px-3 py-2 text-right">Ação</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {licenses.map((lic) => (
                  <tr key={lic.id} className="hover:bg-muted/10">
                    <td className="px-3 py-2.5 font-mono text-xs">{lic.id.slice(0, 8)}...</td>
                    <td className="px-3 py-2.5 capitalize">{lic.license_type}</td>
                    <td className="px-3 py-2.5">
                      <StatusBadge status={lic.status} />
                    </td>
                    <td className="px-3 py-2.5">
                      <TemporalStateBadge state={lic.temporal_state} />
                    </td>
                    <td className="px-3 py-2.5">
                      {lic.active_installations_count || 0} / {lic.max_installations}
                    </td>
                    <td className="px-3 py-2.5 text-xs text-muted-foreground">
                      {new Date(lic.expires_at).toLocaleDateString(tag)}
                    </td>
                    <td className="px-3 py-2.5 text-right">
                      <Button asChild variant="outline" size="sm" className="h-7 text-xs">
                        <Link href={`/admin/licensing/licenses/${lic.id}`}>Ver Licença</Link>
                      </Button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* Edit Modal */}
      {showEditModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4">
          <div className="bg-card border rounded-lg max-w-md w-full p-6 space-y-4 shadow-xl">
            <div className="flex items-center justify-between">
              <h3 className="text-lg font-bold">Editar Dados do Cliente</h3>
              <Button variant="ghost" size="icon" onClick={() => setShowEditModal(false)}>
                <X className="h-4 w-4" />
              </Button>
            </div>

            {editError && (
              <div className="p-3 text-xs rounded-md bg-rose-500/10 text-rose-500 border border-rose-500/20">
                {editError}
              </div>
            )}

            <form onSubmit={handleUpdate} className="space-y-3">
              <div>
                <label className="text-xs font-medium text-muted-foreground uppercase tracking-wider block mb-1">
                  Nome Fantasia
                </label>
                <Input
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  required
                />
              </div>

              <div>
                <label className="text-xs font-medium text-muted-foreground uppercase tracking-wider block mb-1">
                  Razão Social
                </label>
                <Input
                  value={legalName}
                  onChange={(e) => setLegalName(e.target.value)}
                />
              </div>

              <div>
                <label className="text-xs font-medium text-muted-foreground uppercase tracking-wider block mb-1">
                  E-mail Financeiro
                </label>
                <Input
                  type="email"
                  value={billingEmail}
                  onChange={(e) => setBillingEmail(e.target.value)}
                  required
                />
              </div>

              <div>
                <label className="text-xs font-medium text-muted-foreground uppercase tracking-wider block mb-1">
                  País (Código ISO 2 Letras)
                </label>
                <Input
                  maxLength={2}
                  value={country}
                  onChange={(e) => setCountry(e.target.value.toUpperCase())}
                />
              </div>

              <div className="flex justify-end gap-2 pt-3 border-t">
                <Button type="button" variant="outline" onClick={() => setShowEditModal(false)}>
                  Cancelar
                </Button>
                <Button type="submit" disabled={submitting}>
                  {submitting && <CircleNotch className="h-4 w-4 animate-spin mr-1.5" />}
                  Atualizar
                </Button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}
