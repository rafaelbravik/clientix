"use client";
import React, { useState, useEffect } from "react";
import { useParams } from "next/navigation";
import Link from "next/link";
import { LicensingNav } from "@/components/admin/licensing/LicensingNav";
import { StatusBadge, TemporalStateBadge } from "@/components/admin/licensing/Badges";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  ArrowLeft,
  CircleNotch,
  Key,
  Copy,
  Check,
  Warning,
  ArrowsClockwise,
  Pause,
  Play,
  X,
} from "@/lib/ui/icons";

interface ActivationCodeItem {
  id: string;
  license_id: string;
  max_uses: number;
  used_count: number;
  expires_at: string;
  revoked_at: string | null;
  created_at: string;
  is_valid: boolean;
}

interface InstallationItem {
  id: string;
  public_key_fingerprint: string;
  status: "ACTIVE" | "SUSPENDED" | "REVOKED";
  app_version: string | null;
  environment: string | null;
  last_heartbeat_at: string | null;
  heartbeat_count: number;
  created_at: string;
}

interface LicenseDetailData {
  license: {
    id: string;
    customer_id: string;
    license_type: string;
    status: "ACTIVE" | "SUSPENDED" | "REVOKED";
    temporal_state: string;
    signing_key_id: string;
    issued_at: string;
    valid_from: string;
    expires_at: string;
    maintenance_until: string | null;
    grace_days: number;
    max_installations: number;
    max_tenants: number | null;
    features: string[];
    resale_allowed: boolean;
    white_label: boolean;
    active_installations_count?: number;
    created_at: string;
    updated_at: string;
  };
  customer: {
    id: string;
    name: string;
    legal_name: string | null;
    billing_email: string;
    country: string | null;
  };
  installations: InstallationItem[];
  activationCodes: ActivationCodeItem[];
  events: Array<Record<string, unknown>>;
}

export default function LicenseDetailPage() {
  const params = useParams();
  const id = params?.id as string;

  const [data, setData] = useState<LicenseDetailData | null>(null);
  const [loading, setLoading] = useState(true);
  const [actionLoading, setActionLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Activation Code Generator modal
  const [showCodeModal, setShowCodeModal] = useState(false);
  const [codeMaxUses, setCodeMaxUses] = useState(1);
  const [codeExpiresAt, setCodeExpiresAt] = useState(() => {
    const d = new Date();
    d.setDate(d.getDate() + 30);
    return d.toISOString().slice(0, 10);
  });
  const [generatedCode, setGeneratedCode] = useState<string | null>(null);
  const [copiedCode, setCopiedCode] = useState(false);

  // Revocation modal
  const [showRevokeModal, setShowRevokeModal] = useState(false);
  const [revokeConfirmText, setRevokeConfirmText] = useState("");

  const loadData = async () => {
    try {
      const res = await fetch(`/api/v1/admin/licensing/licenses/${id}`);
      if (res.ok) {
        const json = await res.json();
        setData(json.data);
      } else {
        setError("Licença não encontrada.");
      }
    } catch (err) {
      console.error(err);
      setError("Erro ao carregar licença.");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (id) loadData();
  }, [id]);

  const handleRenew = async () => {
    if (!confirm("Deseja renovar esta licença por mais 1 ano a partir de hoje/expiração?")) return;
    setActionLoading(true);
    try {
      const res = await fetch(`/api/v1/admin/licensing/licenses/${id}/renew`, {
        method: "POST",
      });
      if (res.ok) {
        await loadData();
      } else {
        const json = await res.json();
        alert(json.error?.message || "Erro ao renovar");
      }
    } finally {
      setActionLoading(false);
    }
  };

  const handleSuspend = async () => {
    if (!confirm("Deseja suspender esta licença? Instalações associadas terão renovação e downloads bloqueados.")) return;
    setActionLoading(true);
    try {
      const res = await fetch(`/api/v1/admin/licensing/licenses/${id}/suspend`, {
        method: "POST",
      });
      if (res.ok) await loadData();
    } finally {
      setActionLoading(false);
    }
  };

  const handleReactivate = async () => {
    setActionLoading(true);
    try {
      const res = await fetch(`/api/v1/admin/licensing/licenses/${id}/reactivate`, {
        method: "POST",
      });
      if (res.ok) await loadData();
    } finally {
      setActionLoading(false);
    }
  };

  const handleRevoke = async () => {
    if (revokeConfirmText !== "REVOKE") return;
    setActionLoading(true);
    try {
      const res = await fetch(`/api/v1/admin/licensing/licenses/${id}/revoke`, {
        method: "POST",
      });
      if (res.ok) {
        setShowRevokeModal(false);
        await loadData();
      }
    } finally {
      setActionLoading(false);
    }
  };

  const handleCreateCode = async (e: React.FormEvent) => {
    e.preventDefault();
    setActionLoading(true);
    try {
      const res = await fetch(`/api/v1/admin/licensing/licenses/${id}/activation-codes`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          max_uses: Number(codeMaxUses),
          expires_at: new Date(codeExpiresAt).toISOString(),
        }),
      });
      const json = await res.json();
      if (res.ok) {
        setGeneratedCode(json.data.raw_activation_code);
        await loadData();
      } else {
        alert(json.error?.message || "Erro ao gerar código");
      }
    } finally {
      setActionLoading(false);
    }
  };

  const handleRevokeCode = async (codeId: string) => {
    if (!confirm("Deseja revogar este código de ativação?")) return;
    try {
      const res = await fetch(`/api/v1/admin/licensing/activation-codes/${codeId}/revoke`, {
        method: "POST",
      });
      if (res.ok) await loadData();
    } catch (err) {
      console.error(err);
    }
  };

  const copyToClipboard = (text: string) => {
    navigator.clipboard.writeText(text);
    setCopiedCode(true);
    setTimeout(() => setCopiedCode(false), 2000);
  };

  if (loading) {
    return (
      <div className="p-8 text-center flex items-center justify-center text-muted-foreground">
        <CircleNotch className="h-5 w-5 animate-spin mr-2" /> Carregando detalhes da licença...
      </div>
    );
  }

  if (error || !data) {
    return (
      <div className="space-y-4">
        <Button asChild variant="outline" size="sm">
          <Link href="/admin/licensing/licenses">
            <ArrowLeft className="mr-1.5 h-4 w-4" /> Voltar
          </Link>
        </Button>
        <div className="p-4 rounded bg-rose-500/10 text-rose-500">{error || "Não encontrada"}</div>
      </div>
    );
  }

  const { license, customer, installations, activationCodes, events: _events } = data;

  return (
    <div className="space-y-6">
      {/* Top Header */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div className="flex items-center gap-3">
          <Button asChild variant="outline" size="icon">
            <Link href="/admin/licensing/licenses">
              <ArrowLeft className="h-4 w-4" />
            </Link>
          </Button>
          <div>
            <div className="flex items-center gap-2">
              <h1 className="text-2xl font-bold tracking-tight">{customer.name}</h1>
              <StatusBadge status={license.status} />
              <TemporalStateBadge state={license.temporal_state} />
            </div>
            <p className="text-xs text-muted-foreground font-mono mt-0.5">ID: {license.id}</p>
          </div>
        </div>

        {/* Action Controls */}
        <div className="flex items-center gap-2">
          {license.status !== "REVOKED" && (
            <>
              <Button
                variant="outline"
                size="sm"
                onClick={handleRenew}
                disabled={actionLoading}
              >
                <ArrowsClockwise className="mr-1.5 h-3.5 w-3.5" /> Renovar
              </Button>

              {license.status === "ACTIVE" ? (
                <Button
                  variant="outline"
                  size="sm"
                  onClick={handleSuspend}
                  disabled={actionLoading}
                >
                  <Pause className="mr-1.5 h-3.5 w-3.5" /> Suspender
                </Button>
              ) : (
                <Button
                  variant="outline"
                  size="sm"
                  onClick={handleReactivate}
                  disabled={actionLoading}
                >
                  <Play className="mr-1.5 h-3.5 w-3.5" /> Reativar
                </Button>
              )}

              <Button
                variant="destructive"
                size="sm"
                onClick={() => {
                  setRevokeConfirmText("");
                  setShowRevokeModal(true);
                }}
                disabled={actionLoading}
              >
                Revogar
              </Button>
            </>
          )}
        </div>
      </div>

      <LicensingNav />

      {/* Grid: Details & Metrics */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
        {/* Card 1: Informações da Licença */}
        <div className="border rounded-lg bg-card p-5 space-y-3">
          <h2 className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">
            Contrato & Vigência
          </h2>
          <div className="space-y-1.5 text-sm">
            <div className="flex justify-between py-1 border-b border-border/50">
              <span className="text-muted-foreground">Tipo de Licença:</span>
              <span className="font-medium capitalize">{license.license_type}</span>
            </div>
            <div className="flex justify-between py-1 border-b border-border/50">
              <span className="text-muted-foreground">Válido a partir de:</span>
              <span>{new Date(license.valid_from).toLocaleDateString("pt-BR")}</span>
            </div>
            <div className="flex justify-between py-1 border-b border-border/50">
              <span className="text-muted-foreground">Data de Expiração:</span>
              <span>{new Date(license.expires_at).toLocaleDateString("pt-BR")}</span>
            </div>
            <div className="flex justify-between py-1 border-b border-border/50">
              <span className="text-muted-foreground">Período de Carência:</span>
              <span>{license.grace_days} dias</span>
            </div>
            <div className="flex justify-between py-1 border-b border-border/50">
              <span className="text-muted-foreground">Chave de Assinatura:</span>
              <span className="font-mono text-xs">{license.signing_key_id}</span>
            </div>
            <div className="flex justify-between py-1">
              <span className="text-muted-foreground">Emitida em:</span>
              <span>{new Date(license.issued_at).toLocaleString("pt-BR")}</span>
            </div>
          </div>
        </div>

        {/* Card 2: Entitlements */}
        <div className="border rounded-lg bg-card p-5 space-y-3">
          <h2 className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">
            Capacidades & Limites
          </h2>
          <div className="space-y-1.5 text-sm">
            <div className="flex justify-between py-1 border-b border-border/50">
              <span className="text-muted-foreground">Instalações Ativas:</span>
              <span className="font-semibold">
                {license.active_installations_count} / {license.max_installations}
              </span>
            </div>
            <div className="flex justify-between py-1 border-b border-border/50">
              <span className="text-muted-foreground">Máx. Tenants / Org:</span>
              <span>{license.max_tenants ?? "Ilimitado"}</span>
            </div>
            <div className="flex justify-between py-1 border-b border-border/50">
              <span className="text-muted-foreground">White Label:</span>
              <span>{license.white_label ? "Sim" : "Não"}</span>
            </div>
            <div className="flex justify-between py-1 border-b border-border/50">
              <span className="text-muted-foreground">Revenda Autorizada:</span>
              <span>{license.resale_allowed ? "Sim" : "Não"}</span>
            </div>
            <div className="pt-1">
              <span className="text-muted-foreground text-xs block mb-1">Features Habilitadas:</span>
              <div className="flex flex-wrap gap-1">
                {license.features && license.features.length > 0 ? (
                  license.features.map((f: string) => (
                    <span key={f} className="px-2 py-0.5 rounded text-xs bg-muted font-mono">
                      {f}
                    </span>
                  ))
                ) : (
                  <span className="text-xs text-muted-foreground">Nenhuma feature restrita</span>
                )}
              </div>
            </div>
          </div>
        </div>

        {/* Card 3: Cliente */}
        <div className="border rounded-lg bg-card p-5 space-y-3">
          <h2 className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">
            Dados do Cliente
          </h2>
          <div className="space-y-1.5 text-sm">
            <div className="flex justify-between py-1 border-b border-border/50">
              <span className="text-muted-foreground">Razão Social:</span>
              <span>{customer.legal_name || "—"}</span>
            </div>
            <div className="flex justify-between py-1 border-b border-border/50">
              <span className="text-muted-foreground">E-mail Financeiro:</span>
              <span>{customer.billing_email}</span>
            </div>
            <div className="flex justify-between py-1 border-b border-border/50">
              <span className="text-muted-foreground">País:</span>
              <span>{customer.country || "—"}</span>
            </div>
            <div className="pt-2">
              <Button asChild variant="outline" size="sm" className="w-full">
                <Link href={`/admin/licensing/customers/${customer.id}`}>Ver Perfil do Cliente</Link>
              </Button>
            </div>
          </div>
        </div>
      </div>

      {/* Activation Codes Section */}
      <div className="border rounded-lg bg-card p-6 space-y-4">
        <div className="flex items-center justify-between">
          <div>
            <h2 className="text-base font-semibold">Códigos de Ativação</h2>
            <p className="text-xs text-muted-foreground">
              Códigos pré-gerados para vincular instalações à licença via Proof-of-Possession.
            </p>
          </div>
          {license.status !== "REVOKED" && (
            <Button
              size="sm"
              onClick={() => {
                setGeneratedCode(null);
                setShowCodeModal(true);
              }}
            >
              <Key className="mr-1.5 h-3.5 w-3.5" /> Gerar Novo Código
            </Button>
          )}
        </div>

        {activationCodes.length === 0 ? (
          <div className="text-center py-6 text-sm text-muted-foreground border border-dashed rounded-lg">
            Nenhum código de ativação gerado para esta licença.
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm text-left">
              <thead className="bg-muted/40 text-muted-foreground text-xs uppercase border-b">
                <tr>
                  <th className="px-3 py-2">ID do Código</th>
                  <th className="px-3 py-2">Usos</th>
                  <th className="px-3 py-2">Válido até</th>
                  <th className="px-3 py-2">Status</th>
                  <th className="px-3 py-2 text-right">Ação</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {activationCodes.map((code) => (
                  <tr key={code.id} className="hover:bg-muted/10">
                    <td className="px-3 py-2.5 font-mono text-xs">{code.id}</td>
                    <td className="px-3 py-2.5">
                      {code.used_count} / {code.max_uses}
                    </td>
                    <td className="px-3 py-2.5 text-xs text-muted-foreground">
                      {new Date(code.expires_at).toLocaleString("pt-BR")}
                    </td>
                    <td className="px-3 py-2.5">
                      {code.revoked_at ? (
                        <span className="text-xs text-rose-500 font-medium">REVOGADO</span>
                      ) : code.is_valid ? (
                        <span className="text-xs text-emerald-500 font-medium">DISPONÍVEL</span>
                      ) : (
                        <span className="text-xs text-amber-500 font-medium">EXPIRADO / ESGOTADO</span>
                      )}
                    </td>
                    <td className="px-3 py-2.5 text-right">
                      {!code.revoked_at && (
                        <Button
                          variant="ghost"
                          size="sm"
                          className="text-rose-500 hover:text-rose-600 h-7 text-xs"
                          onClick={() => handleRevokeCode(code.id)}
                        >
                          Revogar
                        </Button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* Installations Section */}
      <div className="border rounded-lg bg-card p-6 space-y-4">
        <div>
          <h2 className="text-base font-semibold">Instalações Vinculadas</h2>
          <p className="text-xs text-muted-foreground">
            Instalações autenticadas por chave Ed25519 e certificadas pelo Control Plane.
          </p>
        </div>

        {installations.length === 0 ? (
          <div className="text-center py-6 text-sm text-muted-foreground border border-dashed rounded-lg">
            Nenhuma instalação conectada ainda com esta licença.
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm text-left">
              <thead className="bg-muted/40 text-muted-foreground text-xs uppercase border-b">
                <tr>
                  <th className="px-3 py-2">ID da Instalação</th>
                  <th className="px-3 py-2">Fingerprint Ed25519</th>
                  <th className="px-3 py-2">Status</th>
                  <th className="px-3 py-2">Versão</th>
                  <th className="px-3 py-2">Último Heartbeat</th>
                  <th className="px-3 py-2 text-right">Ação</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {installations.map((inst) => (
                  <tr key={inst.id} className="hover:bg-muted/10">
                    <td className="px-3 py-2.5 font-mono text-xs">{inst.id}</td>
                    <td className="px-3 py-2.5 font-mono text-xs text-muted-foreground">
                      {inst.public_key_fingerprint.slice(0, 16)}...
                    </td>
                    <td className="px-3 py-2.5">
                      <StatusBadge status={inst.status} />
                    </td>
                    <td className="px-3 py-2.5 text-xs">{inst.app_version || "—"}</td>
                    <td className="px-3 py-2.5 text-xs text-muted-foreground">
                      {inst.last_heartbeat_at
                        ? new Date(inst.last_heartbeat_at).toLocaleString("pt-BR")
                        : "Nunca"}
                    </td>
                    <td className="px-3 py-2.5 text-right">
                      <Button asChild variant="outline" size="sm" className="h-7 text-xs">
                        <Link href={`/admin/licensing/installations/${inst.id}`}>Detalhes</Link>
                      </Button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* Code Generation Modal */}
      {showCodeModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4">
          <div className="bg-card border rounded-lg max-w-md w-full p-6 space-y-4 shadow-xl">
            <div className="flex items-center justify-between">
              <h3 className="text-lg font-bold">
                {generatedCode ? "Código Gerado com Sucesso" : "Novo Código de Ativação"}
              </h3>
              <Button
                variant="ghost"
                size="icon"
                onClick={() => {
                  setShowCodeModal(false);
                  setGeneratedCode(null);
                }}
              >
                <X className="h-4 w-4" />
              </Button>
            </div>

            {generatedCode ? (
              <div className="space-y-4">
                <div className="p-3 bg-amber-500/10 border border-amber-500/20 rounded text-xs text-amber-500">
                  <Warning className="inline-block mr-1 h-3.5 w-3.5" />
                  <strong>ATENÇÃO:</strong> Este código é exibido apenas UMA VEZ. Copie agora e envie
                  ao operador da instalação. Apenas o hash HMAC-SHA256 foi salvo no banco.
                </div>

                <div className="flex items-center gap-2 p-3 bg-muted rounded-md border font-mono text-xs break-all">
                  <span>{generatedCode}</span>
                  <Button
                    size="icon"
                    variant="ghost"
                    className="shrink-0 h-8 w-8 ml-auto"
                    onClick={() => copyToClipboard(generatedCode)}
                  >
                    {copiedCode ? <Check className="h-4 w-4 text-emerald-500" /> : <Copy className="h-4 w-4" />}
                  </Button>
                </div>

                <div className="flex justify-end">
                  <Button
                    onClick={() => {
                      setShowCodeModal(false);
                      setGeneratedCode(null);
                    }}
                  >
                    Concluir e Fechar
                  </Button>
                </div>
              </div>
            ) : (
              <form onSubmit={handleCreateCode} className="space-y-4">
                <div>
                  <label className="text-xs font-medium text-muted-foreground uppercase tracking-wider block mb-1">
                    Máximo de Usos
                  </label>
                  <Input
                    type="number"
                    min="1"
                    value={codeMaxUses}
                    onChange={(e) => setCodeMaxUses(Number(e.target.value))}
                    required
                  />
                </div>

                <div>
                  <label className="text-xs font-medium text-muted-foreground uppercase tracking-wider block mb-1">
                    Data Limite de Expiração
                  </label>
                  <Input
                    type="date"
                    value={codeExpiresAt}
                    onChange={(e) => setCodeExpiresAt(e.target.value)}
                    required
                  />
                </div>

                <div className="flex justify-end gap-2 pt-2 border-t">
                  <Button
                    type="button"
                    variant="outline"
                    onClick={() => setShowCodeModal(false)}
                  >
                    Cancelar
                  </Button>
                  <Button type="submit" disabled={actionLoading}>
                    {actionLoading && <CircleNotch className="h-4 w-4 animate-spin mr-1.5" />}
                    Gerar Código
                  </Button>
                </div>
              </form>
            )}
          </div>
        </div>
      )}

      {/* Revocation Modal */}
      {showRevokeModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4">
          <div className="bg-card border rounded-lg max-w-md w-full p-6 space-y-4 shadow-xl">
            <h3 className="text-lg font-bold text-rose-500 flex items-center gap-2">
              <Warning className="h-5 w-5" /> Revogação Permanente de Licença
            </h3>
            <p className="text-sm text-muted-foreground">
              A revogação de uma licença é <strong>permanente e irreversível</strong>. Todas as
              instalações perderão autorização de renewal e download de atualizações.
            </p>
            <div>
              <label className="text-xs font-medium text-muted-foreground block mb-1">
                Digite <strong>REVOKE</strong> para confirmar:
              </label>
              <Input
                value={revokeConfirmText}
                onChange={(e) => setRevokeConfirmText(e.target.value)}
                placeholder="REVOKE"
              />
            </div>
            <div className="flex justify-end gap-2 pt-2 border-t">
              <Button variant="outline" onClick={() => setShowRevokeModal(false)}>
                Cancelar
              </Button>
              <Button
                variant="destructive"
                disabled={revokeConfirmText !== "REVOKE" || actionLoading}
                onClick={handleRevoke}
              >
                {actionLoading && <CircleNotch className="h-4 w-4 animate-spin mr-1.5" />}
                Confirmar Revogação
              </Button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
