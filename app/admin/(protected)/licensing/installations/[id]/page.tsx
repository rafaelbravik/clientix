"use client";
import React, { useState, useEffect } from "react";
import { useParams } from "next/navigation";
import Link from "next/link";
import { LicensingNav } from "@/components/admin/licensing/LicensingNav";
import { StatusBadge } from "@/components/admin/licensing/Badges";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  ArrowLeft,
  CircleNotch,
  Pause,
  Play,
  Warning,
  Copy,
  Check,
} from "@/lib/ui/icons";

interface InstallationEvent {
  id: string;
  event_type: string;
  actor: string;
  payload: Record<string, unknown>;
  created_at: string;
}

interface InstallationDetailData {
  installation: {
    id: string;
    license_id: string;
    public_key: string;
    public_key_fingerprint: string;
    status: "ACTIVE" | "SUSPENDED" | "REVOKED" | "DEACTIVATED";
    app_version: string | null;
    environment: string | null;
    last_heartbeat_at: string | null;
    heartbeat_count: number;
    created_at: string;
    updated_at: string;
  };
  license: {
    id: string;
    status: "ACTIVE" | "SUSPENDED" | "REVOKED";
    license_type: string;
    valid_from: string;
    expires_at: string;
    maintenance_until: string | null;
    grace_period_days: number;
  };
  customer: {
    id: string;
    name: string;
    billing_email: string;
  };
  events: InstallationEvent[];
}

export default function InstallationDetailPage() {
  const params = useParams();
  const id = params?.id as string;

  const [data, setData] = useState<InstallationDetailData | null>(null);
  const [loading, setLoading] = useState(true);
  const [actionLoading, setActionLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Modals
  const [showRevokeModal, setShowRevokeModal] = useState(false);
  const [revokeConfirmText, setRevokeConfirmText] = useState("");
  const [copiedKey, setCopiedKey] = useState(false);

  const loadInstallation = async () => {
    try {
      const res = await fetch(`/api/v1/admin/licensing/installations/${id}`);
      if (res.ok) {
        const json = await res.json();
        setData(json.data);
      } else {
        setError("Instalação não encontrada.");
      }
    } catch (err) {
      console.error(err);
      setError("Erro ao carregar dados da instalação.");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (id) loadInstallation();
  }, [id]);

  const handleSuspend = async () => {
    if (!confirm("Deseja suspender esta instalação?")) return;
    setActionLoading(true);
    try {
      const res = await fetch(`/api/v1/admin/licensing/installations/${id}/suspend`, {
        method: "POST",
      });
      if (res.ok) await loadInstallation();
    } finally {
      setActionLoading(false);
    }
  };

  const handleReactivate = async () => {
    setActionLoading(true);
    try {
      const res = await fetch(`/api/v1/admin/licensing/installations/${id}/reactivate`, {
        method: "POST",
      });
      if (res.ok) await loadInstallation();
    } finally {
      setActionLoading(false);
    }
  };

  const handleForceDeactivate = async () => {
    if (!confirm("Deseja desativar forçadamente esta instalação? O slot de licença será liberado.")) return;
    setActionLoading(true);
    try {
      const res = await fetch(`/api/v1/admin/licensing/installations/${id}/deactivate`, {
        method: "POST",
      });
      if (res.ok) await loadInstallation();
    } finally {
      setActionLoading(false);
    }
  };

  const handleRevoke = async () => {
    if (revokeConfirmText !== "REVOKE") return;
    setActionLoading(true);
    try {
      const res = await fetch(`/api/v1/admin/licensing/installations/${id}/revoke`, {
        method: "POST",
      });
      if (res.ok) {
        setShowRevokeModal(false);
        await loadInstallation();
      }
    } finally {
      setActionLoading(false);
    }
  };

  const copyPublicKey = (keyText: string) => {
    navigator.clipboard.writeText(keyText);
    setCopiedKey(true);
    setTimeout(() => setCopiedKey(false), 2000);
  };

  if (loading) {
    return (
      <div className="p-8 text-center flex items-center justify-center text-muted-foreground">
        <CircleNotch className="h-5 w-5 animate-spin mr-2" /> Carregando detalhes da instalação...
      </div>
    );
  }

  if (error || !data) {
    return (
      <div className="space-y-4">
        <Button asChild variant="outline" size="sm">
          <Link href="/admin/licensing/installations">
            <ArrowLeft className="mr-1.5 h-4 w-4" /> Voltar
          </Link>
        </Button>
        <div className="p-4 rounded bg-rose-500/10 text-rose-500">{error || "Não encontrada"}</div>
      </div>
    );
  }

  const { installation, license, customer, events } = data;

  return (
    <div className="space-y-6">
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div className="flex items-center gap-3">
          <Button asChild variant="outline" size="icon">
            <Link href="/admin/licensing/installations">
              <ArrowLeft className="h-4 w-4" />
            </Link>
          </Button>
          <div>
            <div className="flex items-center gap-2">
              <h1 className="text-2xl font-bold tracking-tight">{installation.id}</h1>
              <StatusBadge status={installation.status} />
            </div>
            <p className="text-xs text-muted-foreground mt-0.5">
              Cliente: {customer.name} | Licença: {license.id.slice(0, 8)}...
            </p>
          </div>
        </div>

        {/* Action Controls */}
        <div className="flex items-center gap-2">
          {installation.status !== "REVOKED" && (
            <>
              {installation.status === "ACTIVE" ? (
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

              {installation.status !== "DEACTIVATED" && (
                <Button
                  variant="outline"
                  size="sm"
                  onClick={handleForceDeactivate}
                  disabled={actionLoading}
                >
                  Forçar Desativação
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

      {/* Grid: Overview & Crypto Details */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
        {/* Card 1: Informações da Instalação */}
        <div className="border rounded-lg bg-card p-5 space-y-3">
          <h2 className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">
            Telemetria & Ambiente
          </h2>
          <div className="space-y-1.5 text-sm">
            <div className="flex justify-between py-1 border-b border-border/50">
              <span className="text-muted-foreground">Ambiente:</span>
              <span className="font-medium capitalize">{installation.environment}</span>
            </div>
            <div className="flex justify-between py-1 border-b border-border/50">
              <span className="text-muted-foreground">Versão da Aplicação:</span>
              <span className="font-mono">{installation.app_version || "—"}</span>
            </div>
            <div className="flex justify-between py-1 border-b border-border/50">
              <span className="text-muted-foreground">Último Heartbeat:</span>
              <span>
                {installation.last_heartbeat_at
                  ? new Date(installation.last_heartbeat_at).toLocaleString("pt-BR")
                  : "Nunca"}
              </span>
            </div>
            <div className="flex justify-between py-1 border-b border-border/50">
              <span className="text-muted-foreground">Registrada em:</span>
              <span>{new Date(installation.created_at).toLocaleString("pt-BR")}</span>
            </div>
            <div className="flex justify-between py-1">
              <span className="text-muted-foreground">Contrato Vinculado:</span>
              <Button asChild variant="link" size="sm" className="p-0 h-auto">
                <Link href={`/admin/licensing/licenses/${license.id}`}>
                  Ver Licença ({license.license_type})
                </Link>
              </Button>
            </div>
          </div>
        </div>

        {/* Card 2: Identidade Criptográfica PoP */}
        <div className="border rounded-lg bg-card p-5 space-y-3">
          <h2 className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">
            Identidade Criptográfica (Ed25519)
          </h2>
          <div className="space-y-2 text-sm">
            <div>
              <span className="text-muted-foreground text-xs block mb-1">
                Fingerprint SHA-256 da Chave Pública:
              </span>
              <div className="p-2 rounded bg-muted font-mono text-xs break-all border">
                {installation.public_key_fingerprint}
              </div>
            </div>

            <div>
              <div className="flex items-center justify-between mb-1">
                <span className="text-muted-foreground text-xs">Chave Pública PEM:</span>
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-6 text-xs px-2"
                  onClick={() => copyPublicKey(installation.public_key)}
                >
                  {copiedKey ? <Check className="h-3.5 w-3.5 text-emerald-500 mr-1" /> : <Copy className="h-3.5 w-3.5 mr-1" />}
                  {copiedKey ? "Copiada" : "Copiar"}
                </Button>
              </div>
              <textarea
                readOnly
                value={installation.public_key}
                rows={3}
                className="w-full p-2 rounded bg-muted/60 font-mono text-xs border resize-none focus:outline-none"
              />
            </div>
          </div>
        </div>
      </div>

      {/* Installation Events */}
      <div className="border rounded-lg bg-card p-6 space-y-4">
        <div>
          <h2 className="text-base font-semibold">Eventos Operacionais</h2>
          <p className="text-xs text-muted-foreground">
            Trilha de ativação, renovação, heartbeat e status desta instalação.
          </p>
        </div>

        {events.length === 0 ? (
          <div className="text-center py-6 text-sm text-muted-foreground border border-dashed rounded-lg">
            Nenhum evento registrado para esta instalação.
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm text-left">
              <thead className="bg-muted/40 text-muted-foreground text-xs uppercase border-b">
                <tr>
                  <th className="px-3 py-2">Data / Hora</th>
                  <th className="px-3 py-2">Tipo de Evento</th>
                  <th className="px-3 py-2">Ator</th>
                  <th className="px-3 py-2">Payload</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {events.map((evt) => (
                  <tr key={evt.id} className="hover:bg-muted/10">
                    <td className="px-3 py-2.5 text-xs text-muted-foreground whitespace-nowrap">
                      {new Date(evt.created_at).toLocaleString("pt-BR")}
                    </td>
                    <td className="px-3 py-2.5 font-mono text-xs font-medium">{evt.event_type}</td>
                    <td className="px-3 py-2.5 text-xs text-muted-foreground">{evt.actor}</td>
                    <td className="px-3 py-2.5 font-mono text-xs text-muted-foreground max-w-md truncate">
                      {JSON.stringify(evt.payload)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* Revocation Modal */}
      {showRevokeModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4">
          <div className="bg-card border rounded-lg max-w-md w-full p-6 space-y-4 shadow-xl">
            <h3 className="text-lg font-bold text-rose-500 flex items-center gap-2">
              <Warning className="h-5 w-5" /> Revogação Permanente de Instalação
            </h3>
            <p className="text-sm text-muted-foreground">
              A revogação desta instalação rejeitará permanentemente assinaturas criptográficas PoP
              desta chave Ed25519.
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
