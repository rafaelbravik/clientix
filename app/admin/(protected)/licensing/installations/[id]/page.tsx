"use client";
import React, { useState, useEffect } from "react";
import { useT } from "@/lib/i18n/IdiomaProvider";
import { useParams } from "next/navigation";
import Link from "next/link";
import { LicensingNav } from "@/components/admin/licensing/LicensingNav";
import { StatusBadge } from "@/components/admin/licensing/Badges";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { copyToClipboard as copyTextToClipboard } from "@/lib/clipboard";
import { ArrowLeft, CircleNotch, Pause, Play, Warning, Copy, Check } from "@/lib/ui/icons";
import { useTagDeIdioma } from "@/hooks/i18n/useLocaleDeData";

interface InstallationEvent {
  id: string;
  event_type: string;
  actor: string;
  payload: Record<string, unknown>;
  created_at: string;
}

interface InstallationSession {
  session_id: string;
  status: "ACTIVE" | "ENDED";
  boot_started_at: string;
  started_at: string;
  last_heartbeat_at: string;
  ended_at: string | null;
  clientix_version: string | null;
  heartbeat_fresh: boolean;
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
    clone_status: "NORMAL" | "SUSPECTED_CLONE" | "CLONE_CONFIRMED" | "TRANSFER_PENDING";
    clone_conflict_count: number;
    last_clone_conflict_at: string | null;
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
  sessions: InstallationSession[];
}

export default function InstallationDetailPage() {
  const t = useT();
  const tag = useTagDeIdioma();
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
  const [recoveryReason, setRecoveryReason] = useState("");
  const [recoveryCodeOnce, setRecoveryCodeOnce] = useState<string | null>(null);

  const loadInstallation = async () => {
    try {
      const res = await fetch(`/api/v1/admin/licensing/installations/${id}`);
      if (res.ok) {
        const json = await res.json();
        setData(json.data);
      } else {
        setError(t("Instalação não encontrada."));
      }
    } catch (err) {
      console.error(err);
      setError(t("Erro ao carregar dados da instalação."));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (id) loadInstallation();
  }, [id]);

  const handleSuspend = async () => {
    if (!confirm(t("Deseja suspender esta instalação?"))) return;
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
    if (
      !confirm(t("Deseja desativar forçadamente esta instalação? O slot de licença será liberado."))
    )
      return;
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

  const copyPublicKey = async (keyText: string) => {
    const copied = await copyTextToClipboard(keyText);
    if (!copied) {
      alert(t("Não foi possível copiar o conteúdo."));
      return;
    }
    setCopiedKey(true);
    setTimeout(() => setCopiedKey(false), 2000);
  };

  const handleAuthorizeRecovery = async () => {
    if (recoveryReason.trim().length < 3) return;
    if (
      !confirm(
        t(
          "Autorizar uma recuperação encerrará as sessões atuais. O código será mostrado uma única vez.",
        ),
      )
    )
      return;
    setActionLoading(true);
    try {
      const res = await fetch(`/api/v1/admin/licensing/installations/${id}/recovery`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ reason: recoveryReason.trim(), confirm: true }),
      });
      const body = await res.json();
      if (!res.ok)
        throw new Error(body?.error?.message ?? "Não foi possível autorizar a recuperação.");
      setRecoveryCodeOnce(body.data.recovery_code as string);
      setRecoveryReason("");
      await loadInstallation();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Não foi possível autorizar a recuperação.");
    } finally {
      setActionLoading(false);
    }
  };

  const handleEndSession = async (sessionId: string) => {
    if (!confirm(t("Encerrar esta sessão ativa?"))) return;
    setActionLoading(true);
    try {
      const res = await fetch(
        `/api/v1/admin/licensing/installations/${id}/sessions/${sessionId}/end`,
        { method: "POST" },
      );
      if (!res.ok) throw new Error("Não foi possível encerrar a sessão.");
      await loadInstallation();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Não foi possível encerrar a sessão.");
    } finally {
      setActionLoading(false);
    }
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center p-8 text-center text-muted-foreground">
        <CircleNotch className="mr-2 h-5 w-5 animate-spin" />{" "}
        {t("Carregando detalhes da instalação...")}
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
        <div className="rounded-md bg-rose-500/10 p-4 text-rose-500">
          {error || t("Não encontrada")}
        </div>
      </div>
    );
  }

  const { installation, license, customer, events, sessions } = data;

  return (
    <div className="space-y-6">
      <div className="flex flex-col justify-between gap-4 sm:flex-row sm:items-center">
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
            <p className="mt-0.5 text-xs text-muted-foreground">
              Cliente: {customer.name} {t("| Licença:")} {license.id.slice(0, 8)}...
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
                  {t("Forçar Desativação")}
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

      <section
        className="space-y-4 rounded-lg border bg-card p-5"
        aria-labelledby="clone-status-title"
      >
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h2 id="clone-status-title" className="text-base font-semibold">
              Atestação e sessões
            </h2>
            <p className="mt-1 text-sm text-muted-foreground">
              Estado de sobreposição de sessões recentes:{" "}
              <strong>{installation.clone_status}</strong>
            </p>
          </div>
          <span className="text-xs text-muted-foreground">
            Último conflito:{" "}
            {installation.last_clone_conflict_at
              ? new Date(installation.last_clone_conflict_at).toLocaleString(tag)
              : "nenhum"}
          </span>
        </div>
        <div className="flex flex-col gap-2 sm:flex-row">
          <Input
            value={recoveryReason}
            onChange={(event) => setRecoveryReason(event.target.value)}
            aria-label="Motivo da recuperação da instalação"
            placeholder="Motivo para autorizar recuperação"
            maxLength={500}
          />
          <Button
            type="button"
            variant="outline"
            disabled={
              actionLoading || recoveryReason.trim().length < 3 || installation.status !== "ACTIVE"
            }
            onClick={() => void handleAuthorizeRecovery()}
          >
            Autorizar recuperação
          </Button>
        </div>
        {recoveryCodeOnce && (
          <div
            className="space-y-2 rounded-md border border-amber-500/50 bg-amber-500/5 p-3"
            role="alert"
          >
            <p className="text-sm font-semibold">
              Código de uso único — entregue ao operador desta instalação.
            </p>
            <div className="flex flex-col gap-2 sm:flex-row">
              <Input
                readOnly
                value={recoveryCodeOnce}
                aria-label="Código de recuperação de uso único"
                className="font-mono"
              />
              <Button
                type="button"
                variant="outline"
                onClick={() => void copyPublicKey(recoveryCodeOnce)}
              >
                {copiedKey ? "Copiado" : "Copiar código"}
              </Button>
              <Button type="button" variant="ghost" onClick={() => setRecoveryCodeOnce(null)}>
                Ocultar
              </Button>
            </div>
          </div>
        )}
        {sessions.length === 0 ? (
          <p className="text-sm text-muted-foreground">Nenhuma sessão de boot registrada.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left text-sm">
              <thead className="border-b text-xs text-muted-foreground">
                <tr>
                  <th className="py-2">Sessão</th>
                  <th>Estado</th>
                  <th>Último heartbeat</th>
                  <th>Versão</th>
                  <th />
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {sessions.map((session) => (
                  <tr key={session.session_id}>
                    <td className="py-2 font-mono text-xs">{session.session_id}</td>
                    <td>
                      {session.heartbeat_fresh
                        ? "Ativa"
                        : session.status === "ENDED"
                          ? "Encerrada"
                          : "Sem heartbeat recente"}
                    </td>
                    <td>{new Date(session.last_heartbeat_at).toLocaleString(tag)}</td>
                    <td>{session.clientix_version || "—"}</td>
                    <td>
                      {session.heartbeat_fresh && (
                        <Button
                          type="button"
                          size="sm"
                          variant="outline"
                          disabled={actionLoading}
                          onClick={() => void handleEndSession(session.session_id)}
                        >
                          Encerrar sessão
                        </Button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {/* Grid: Overview & Crypto Details */}
      <div className="grid grid-cols-1 gap-6 md:grid-cols-2">
        {/* Card 1: Informações da Instalação */}
        <div className="space-y-3 rounded-lg border bg-card p-5">
          <h2 className="text-xs font-semibold tracking-wider text-muted-foreground uppercase">
            Telemetria & Ambiente
          </h2>
          <div className="space-y-1.5 text-sm">
            <div className="flex justify-between border-b border-border/50 py-1">
              <span className="text-muted-foreground">Ambiente:</span>
              <span className="font-medium capitalize">{installation.environment}</span>
            </div>
            <div className="flex justify-between border-b border-border/50 py-1">
              <span className="text-muted-foreground">{t("Versão da Aplicação:")}</span>
              <span className="font-mono">{installation.app_version || "—"}</span>
            </div>
            <div className="flex justify-between border-b border-border/50 py-1">
              <span className="text-muted-foreground">{t("Último Heartbeat:")}</span>
              <span>
                {installation.last_heartbeat_at
                  ? new Date(installation.last_heartbeat_at).toLocaleString(tag)
                  : t("Nunca")}
              </span>
            </div>
            <div className="flex justify-between border-b border-border/50 py-1">
              <span className="text-muted-foreground">Registrada em:</span>
              <span>{new Date(installation.created_at).toLocaleString(tag)}</span>
            </div>
            <div className="flex justify-between py-1">
              <span className="text-muted-foreground">Contrato Vinculado:</span>
              <Button asChild variant="link" size="sm" className="h-auto p-0">
                <Link href={`/admin/licensing/licenses/${license.id}`}>
                  {t("Ver Licença (")}
                  {license.license_type})
                </Link>
              </Button>
            </div>
          </div>
        </div>

        {/* Card 2: Identidade Criptográfica PoP */}
        <div className="space-y-3 rounded-lg border bg-card p-5">
          <h2 className="text-xs font-semibold tracking-wider text-muted-foreground uppercase">
            {t("Identidade Criptográfica (Ed25519)")}
          </h2>
          <div className="space-y-2 text-sm">
            <div>
              <span className="mb-1 block text-xs text-muted-foreground">
                {t("Fingerprint SHA-256 da Chave Pública:")}
              </span>
              <div className="rounded-md border bg-muted p-2 font-mono text-xs break-all">
                {installation.public_key_fingerprint}
              </div>
            </div>

            <div>
              <div className="mb-1 flex items-center justify-between">
                <span className="text-xs text-muted-foreground">{t("Chave Pública PEM:")}</span>
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-6 px-2 text-xs"
                  onClick={() => copyPublicKey(installation.public_key)}
                >
                  {copiedKey ? (
                    <Check className="mr-1 h-3.5 w-3.5 text-emerald-500" />
                  ) : (
                    <Copy className="mr-1 h-3.5 w-3.5" />
                  )}
                  {copiedKey ? "Copiada" : "Copiar"}
                </Button>
              </div>
              <textarea
                readOnly
                value={installation.public_key}
                rows={3}
                className="w-full resize-none rounded-md border bg-muted/60 p-2 font-mono text-xs focus:outline-hidden"
              />
            </div>
          </div>
        </div>
      </div>

      {/* Installation Events */}
      <div className="space-y-4 rounded-lg border bg-card p-6">
        <div>
          <h2 className="text-base font-semibold">Eventos Operacionais</h2>
          <p className="text-xs text-muted-foreground">
            {t("Trilha de ativação, renovação, heartbeat e status desta instalação.")}
          </p>
        </div>

        {events.length === 0 ? (
          <div className="rounded-lg border border-dashed py-6 text-center text-sm text-muted-foreground">
            {t("Nenhum evento registrado para esta instalação.")}
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left text-sm">
              <thead className="border-b bg-muted/40 text-xs text-muted-foreground uppercase">
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
                    <td className="px-3 py-2.5 text-xs whitespace-nowrap text-muted-foreground">
                      {new Date(evt.created_at).toLocaleString(tag)}
                    </td>
                    <td className="px-3 py-2.5 font-mono text-xs font-medium">{evt.event_type}</td>
                    <td className="px-3 py-2.5 text-xs text-muted-foreground">{evt.actor}</td>
                    <td className="max-w-md truncate px-3 py-2.5 font-mono text-xs text-muted-foreground">
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
          <div className="w-full max-w-md space-y-4 rounded-lg border bg-card p-6 shadow-xl">
            <h3 className="flex items-center gap-2 text-lg font-bold text-rose-500">
              <Warning className="h-5 w-5" /> {t("Revogação Permanente de Instalação")}
            </h3>
            <p className="text-sm text-muted-foreground">
              {t(
                "A revogação desta instalação rejeitará permanentemente assinaturas criptográficas PoP desta chave Ed25519.",
              )}
            </p>
            <div>
              <label className="mb-1 block text-xs font-medium text-muted-foreground">
                Digite <strong>REVOKE</strong> {t("para confirmar:")}
              </label>
              <Input
                value={revokeConfirmText}
                onChange={(e) => setRevokeConfirmText(e.target.value)}
                placeholder="REVOKE"
              />
            </div>
            <div className="flex justify-end gap-2 border-t pt-2">
              <Button variant="outline" onClick={() => setShowRevokeModal(false)}>
                Cancelar
              </Button>
              <Button
                variant="destructive"
                disabled={revokeConfirmText !== "REVOKE" || actionLoading}
                onClick={handleRevoke}
              >
                {actionLoading && <CircleNotch className="mr-1.5 h-4 w-4 animate-spin" />}
                {t("Confirmar Revogação")}
              </Button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
