"use client";
import React, { useState, useEffect } from "react";
import { useT } from "@/lib/i18n/IdiomaProvider";
import { useParams } from "next/navigation";
import Link from "next/link";
import { LicensingNav } from "@/components/admin/licensing/LicensingNav";
import { BillingSummary } from "@/components/admin/billing/BillingSummary";
import { StatusBadge, TemporalStateBadge } from "@/components/admin/licensing/Badges";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { copyToClipboard as copyTextToClipboard } from "@/lib/clipboard";
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
import { useTagDeIdioma } from "@/hooks/i18n/useLocaleDeData";
import { randomId } from "@/lib/random-id";

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
  status: "ACTIVE" | "SUSPENDED" | "REVOKED" | "DEACTIVATED" | "TRANSFERRED" | "DISABLED";
  app_version: string | null;
  environment: string | null;
  last_heartbeat_at: string | null;
  last_validation_at?: string | null;
  heartbeat_count: number;
  created_at: string;
}

interface LicenseDetailData {
  license: {
    id: string;
    serial: string;
    customer_id: string;
    product: "clientix";
    deployment: "self-hosted";
    plan: "standard" | "pro" | "enterprise";
    license_type: string;
    status: "DRAFT" | "ACTIVE" | "EXPIRED" | "SUSPENDED" | "REVOKED";
    temporal_state: "VALID" | "GRACE" | "EXPIRED" | "NOT_YET_VALID";
    signing_key_id: string;
    issued_at: string | null;
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
  events: Array<{
    id: string;
    event_type: string;
    actor_type?: string;
    actor_id?: string | null;
    created_at: string;
  }>;
}

const commercialPlanLabels = {
  standard: "Essencial",
  pro: "Profissional",
  enterprise: "Escala",
} as const;

export default function LicenseDetailPage() {
  const t = useT();
  const tag = useTagDeIdioma();
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
  const [revokeReason, setRevokeReason] = useState("");
  const [showTransferModal, setShowTransferModal] = useState(false);
  const [showRenewModal, setShowRenewModal] = useState(false);
  const [renewalTerm, setRenewalTerm] = useState("12m");
  const [renewalBasis, setRenewalBasis] = useState<"" | "previous_expiration" | "today">("");
  const [renewalDate, setRenewalDate] = useState("");
  const [renewalReason, setRenewalReason] = useState("");
  const [showSuspendModal, setShowSuspendModal] = useState(false);
  const [suspendReason, setSuspendReason] = useState("");
  const [suspendNote, setSuspendNote] = useState("");
  const [transferFrom, setTransferFrom] = useState("");
  const [transferTo, setTransferTo] = useState("");
  const [transferPublicKey, setTransferPublicKey] = useState("");
  const [transferReason, setTransferReason] = useState("");
  const [renewalIdempotencyKey, setRenewalIdempotencyKey] = useState<string | null>(null);
  const renewalNeedsBasis =
    data?.license.temporal_state === "GRACE" || data?.license.temporal_state === "EXPIRED";

  const loadData = async () => {
    try {
      const res = await fetch(`/api/v1/admin/licenses/${id}`);
      if (res.ok) {
        const json = await res.json();
        setData(json.data);
      } else {
        setError(t("Licença não encontrada."));
      }
    } catch (err) {
      console.error(err);
      setError(t("Erro ao carregar licença."));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (id) loadData();
  }, [id]);

  const handleRenew = async () => {
    if (!data) return;
    if (!renewalTerm || (renewalNeedsBasis && !renewalBasis)) return;
    setActionLoading(true);
    try {
      const idempotencyKey = renewalIdempotencyKey ?? randomId();
      setRenewalIdempotencyKey(idempotencyKey);
      const renewalPayload: Record<string, unknown> = {};
      if (renewalTerm === "custom")
        renewalPayload.new_expires_at = new Date(renewalDate).toISOString();
      else if (renewalTerm.endsWith("d"))
        renewalPayload.duration_days = Number(renewalTerm.slice(0, -1));
      else renewalPayload.duration_months = Number(renewalTerm.slice(0, -1));
      if (renewalNeedsBasis) renewalPayload.renewal_basis = renewalBasis;
      renewalPayload.reason = renewalReason.trim();
      const res = await fetch(`/api/v1/admin/licenses/${id}/renew`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "Idempotency-Key": idempotencyKey },
        body: JSON.stringify(renewalPayload),
      });
      if (res.ok) {
        setRenewalIdempotencyKey(null);
        setShowRenewModal(false);
        await loadData();
      } else {
        const json = await res.json();
        alert(json.error?.message || "Erro ao renovar");
      }
    } finally {
      setActionLoading(false);
    }
  };

  const handleIssue = async () => {
    if (!confirm("Emitir esta licença agora? Ela ficará disponível para ativação.")) return;
    setActionLoading(true);
    try {
      const res = await fetch(`/api/v1/admin/licenses/${id}/issue`, { method: "POST" });
      if (res.ok) await loadData();
      else alert("Não foi possível emitir a licença.");
    } finally {
      setActionLoading(false);
    }
  };

  const handleSuspend = async () => {
    if (!suspendReason.trim()) return;
    setActionLoading(true);
    try {
      const res = await fetch(`/api/v1/admin/licenses/${id}/suspend`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          reason: suspendReason.trim(),
          note: suspendNote.trim() || undefined,
        }),
      });
      if (res.ok) {
        setShowSuspendModal(false);
        setSuspendReason("");
        setSuspendNote("");
        await loadData();
      } else {
        const json = await res.json();
        alert(json.error?.message || "Não foi possível suspender a licença.");
      }
    } finally {
      setActionLoading(false);
    }
  };

  const handleReactivate = async () => {
    setActionLoading(true);
    try {
      const res = await fetch(`/api/v1/admin/licenses/${id}/reactivate`, {
        method: "POST",
      });
      if (res.ok) await loadData();
      else alert("Não foi possível reativar a licença.");
    } finally {
      setActionLoading(false);
    }
  };

  const handleRevoke = async () => {
    if (revokeConfirmText !== "REVOKE" || !revokeReason.trim()) return;
    setActionLoading(true);
    try {
      const res = await fetch(`/api/v1/admin/licenses/${id}/revoke`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ reason: revokeReason, confirm: true }),
      });
      if (res.ok) {
        setShowRevokeModal(false);
        await loadData();
      }
    } finally {
      setActionLoading(false);
    }
  };

  const handleTransfer = async () => {
    if (
      !data ||
      !transferFrom ||
      !transferTo.trim() ||
      !transferPublicKey.trim() ||
      !transferReason.trim()
    )
      return;
    if (
      !confirm("Transferir esta licença? A instalação atual será desativada e a nova será ativada.")
    )
      return;
    setActionLoading(true);
    try {
      const res = await fetch(`/api/v1/admin/licenses/${id}/transfer`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          from_installation_id: transferFrom,
          to_installation_id: transferTo.trim(),
          to_public_key: transferPublicKey.trim(),
          reason: transferReason.trim(),
          clientix_version: "unknown",
          confirm: true,
        }),
      });
      if (res.ok) {
        setShowTransferModal(false);
        setTransferTo("");
        setTransferPublicKey("");
        setTransferReason("");
        await loadData();
      } else {
        alert("Não foi possível transferir a instalação.");
      }
    } finally {
      setActionLoading(false);
    }
  };

  const handleDownloadLicense = async (installationId: string) => {
    setActionLoading(true);
    try {
      const response = await fetch(
        `/api/v1/admin/licenses/${id}/installations/${encodeURIComponent(installationId)}/license`,
        { method: "POST" },
      );
      if (!response.ok) {
        const json = await response.json();
        alert(json.error?.message || "Não foi possível gerar o arquivo de licença.");
        return;
      }
      const blob = await response.blob();
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = "license.json";
      anchor.click();
      URL.revokeObjectURL(url);
      await loadData();
    } finally {
      setActionLoading(false);
    }
  };

  const handleCreateCode = async (e: React.FormEvent) => {
    e.preventDefault();
    setActionLoading(true);
    try {
      const res = await fetch(`/api/v1/admin/licenses/${id}/activation-codes`, {
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
        alert(json.error?.message || t("Erro ao gerar código"));
      }
    } finally {
      setActionLoading(false);
    }
  };

  const handleRevokeCode = async (codeId: string) => {
    if (!confirm(t("Deseja revogar este código de ativação?"))) return;
    try {
      const res = await fetch(`/api/v1/admin/licensing/activation-codes/${codeId}/revoke`, {
        method: "POST",
      });
      if (res.ok) await loadData();
    } catch (err) {
      console.error(err);
    }
  };

  const copyToClipboard = async (text: string) => {
    const copied = await copyTextToClipboard(text);
    if (!copied) {
      alert(t("Não foi possível copiar o conteúdo."));
      return;
    }
    setCopiedCode(true);
    setTimeout(() => setCopiedCode(false), 2000);
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center p-8 text-center text-muted-foreground">
        <CircleNotch className="mr-2 h-5 w-5 animate-spin" />{" "}
        {t("Carregando detalhes da licença...")}
      </div>
    );
  }

  if (error || !data) {
    return (
      <div className="space-y-4">
        <Button asChild variant="outline" size="sm">
          <Link href="/admin/licenses">
            <ArrowLeft className="mr-1.5 h-4 w-4" /> Voltar
          </Link>
        </Button>
        <div className="rounded-md bg-rose-500/10 p-4 text-rose-500">
          {error || t("Não encontrada")}
        </div>
      </div>
    );
  }

  const { license, customer, installations, activationCodes, events } = data;

  return (
    <div className="space-y-6">
      {/* Top Header */}
      <div className="flex flex-col justify-between gap-4 sm:flex-row sm:items-center">
        <div className="flex items-center gap-3">
          <Button asChild variant="outline" size="icon">
            <Link href="/admin/licenses">
              <ArrowLeft className="h-4 w-4" />
            </Link>
          </Button>
          <div>
            <div className="flex items-center gap-2">
              <h1 className="text-2xl font-bold tracking-tight">{customer.name}</h1>
              <StatusBadge status={license.status} />
              <TemporalStateBadge state={license.temporal_state} />
            </div>
            <p className="mt-0.5 font-mono text-xs text-muted-foreground">
              {license.serial} · {license.id}
            </p>
          </div>
        </div>

        {/* Action Controls */}
        <div className="flex flex-wrap items-center gap-2">
          {license.status === "DRAFT" ? (
            <Button size="sm" onClick={handleIssue} disabled={actionLoading}>
              {t("Emitir licença")}
            </Button>
          ) : (
            <>
              {license.status !== "REVOKED" && (
                <>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => {
                      setRenewalBasis("");
                      setRenewalReason("");
                      setRenewalIdempotencyKey(null);
                      setShowRenewModal(true);
                    }}
                    disabled={actionLoading}
                  >
                    <ArrowsClockwise className="mr-1.5 h-3.5 w-3.5" /> Renovar
                  </Button>
                  {(license.status === "ACTIVE" || license.status === "EXPIRED") && (
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => setShowSuspendModal(true)}
                      disabled={actionLoading}
                    >
                      <Pause className="mr-1.5 h-3.5 w-3.5" /> Suspender
                    </Button>
                  )}
                  {license.status === "SUSPENDED" && (
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={handleReactivate}
                      disabled={actionLoading}
                    >
                      <Play className="mr-1.5 h-3.5 w-3.5" /> Reativar
                    </Button>
                  )}
                  {license.status === "ACTIVE" &&
                    installations.some((installation) => installation.status === "ACTIVE") && (
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => setShowTransferModal(true)}
                        disabled={actionLoading}
                      >
                        Transferir
                      </Button>
                    )}
                  <Button
                    variant="destructive"
                    size="sm"
                    onClick={() => {
                      setRevokeConfirmText("");
                      setRevokeReason("");
                      setShowRevokeModal(true);
                    }}
                    disabled={actionLoading}
                  >
                    Revogar
                  </Button>
                </>
              )}
            </>
          )}
        </div>
      </div>

      <LicensingNav />
      <BillingSummary kind="licenses" id={id} />

      {/* Grid: Details & Metrics */}
      <div className="grid grid-cols-1 gap-6 md:grid-cols-3">
        {/* Card 1: Informações da Licença */}
        <div className="space-y-3 rounded-lg border bg-card p-5">
          <h2 className="text-xs font-semibold tracking-wider text-muted-foreground uppercase">
            {t("Contrato & Vigência")}
          </h2>
          <div className="space-y-1.5 text-sm">
            <div className="flex justify-between border-b border-border/50 py-1">
              <span className="text-muted-foreground">Serial:</span>
              <span className="font-mono">{license.serial}</span>
            </div>
            <div className="flex justify-between border-b border-border/50 py-1">
              <span className="text-muted-foreground">Plano comercial:</span>
              <span>{commercialPlanLabels[license.plan]}</span>
            </div>
            <div className="flex justify-between border-b border-border/50 py-1">
              <span className="text-muted-foreground">{t("Tipo de Licença:")}</span>
              <span className="font-medium capitalize">{license.license_type}</span>
            </div>
            <div className="flex justify-between border-b border-border/50 py-1">
              <span className="text-muted-foreground">{t("Válido a partir de:")}</span>
              <span>{new Date(license.valid_from).toLocaleDateString(tag)}</span>
            </div>
            <div className="flex justify-between border-b border-border/50 py-1">
              <span className="text-muted-foreground">{t("Data de Expiração:")}</span>
              <span>{new Date(license.expires_at).toLocaleDateString(tag)}</span>
            </div>
            <div className="flex justify-between border-b border-border/50 py-1">
              <span className="text-muted-foreground">{t("Período de Carência:")}</span>
              <span>{license.grace_days} dias</span>
            </div>
            <div className="flex justify-between border-b border-border/50 py-1">
              <span className="text-muted-foreground">Chave de Assinatura:</span>
              <span className="font-mono text-xs">{license.signing_key_id}</span>
            </div>
            <div className="flex justify-between py-1">
              <span className="text-muted-foreground">Emitida em:</span>
              <span>
                {license.issued_at
                  ? new Date(license.issued_at).toLocaleString(tag)
                  : t("Rascunho")}
              </span>
            </div>
          </div>
        </div>

        {/* Card 2: Entitlements */}
        <div className="space-y-3 rounded-lg border bg-card p-5">
          <h2 className="text-xs font-semibold tracking-wider text-muted-foreground uppercase">
            Capacidades & Limites
          </h2>
          <div className="space-y-1.5 text-sm">
            <div className="flex justify-between border-b border-border/50 py-1">
              <span className="text-muted-foreground">{t("Instalações Ativas:")}</span>
              <span className="font-semibold">
                {license.active_installations_count} / {license.max_installations}
              </span>
            </div>
            <div className="flex justify-between border-b border-border/50 py-1">
              <span className="text-muted-foreground">{t("Máx. Tenants / Org:")}</span>
              <span>{license.max_tenants ?? "Ilimitado"}</span>
            </div>
            <div className="flex justify-between border-b border-border/50 py-1">
              <span className="text-muted-foreground">White Label:</span>
              <span>{license.white_label ? "Sim" : t("Não")}</span>
            </div>
            <div className="flex justify-between border-b border-border/50 py-1">
              <span className="text-muted-foreground">Revenda Autorizada:</span>
              <span>{license.resale_allowed ? "Sim" : t("Não")}</span>
            </div>
            <div className="pt-1">
              <span className="mb-1 block text-xs text-muted-foreground">
                Features Habilitadas:
              </span>
              <div className="flex flex-wrap gap-1">
                {license.features && license.features.length > 0 ? (
                  license.features.map((f: string) => (
                    <span key={f} className="rounded-md bg-muted px-2 py-0.5 font-mono text-xs">
                      {f}
                    </span>
                  ))
                ) : (
                  <span className="text-xs text-muted-foreground">
                    {t("Nenhuma feature restrita")}
                  </span>
                )}
              </div>
            </div>
          </div>
        </div>

        {/* Card 3: Cliente */}
        <div className="space-y-3 rounded-lg border bg-card p-5">
          <h2 className="text-xs font-semibold tracking-wider text-muted-foreground uppercase">
            Dados do Cliente
          </h2>
          <div className="space-y-1.5 text-sm">
            <div className="flex justify-between border-b border-border/50 py-1">
              <span className="text-muted-foreground">{t("Razão Social:")}</span>
              <span>{customer.legal_name || "—"}</span>
            </div>
            <div className="flex justify-between border-b border-border/50 py-1">
              <span className="text-muted-foreground">E-mail Financeiro:</span>
              <span>{customer.billing_email}</span>
            </div>
            <div className="flex justify-between border-b border-border/50 py-1">
              <span className="text-muted-foreground">{t("País:")}</span>
              <span>{customer.country || "—"}</span>
            </div>
            <div className="pt-2">
              <Button asChild variant="outline" size="sm" className="w-full">
                <Link href={`/admin/licensing/customers/${customer.id}`}>
                  Ver Perfil do Cliente
                </Link>
              </Button>
            </div>
          </div>
        </div>
      </div>

      {/* Activation Codes Section */}
      <div className="space-y-4 rounded-lg border bg-card p-6">
        <div className="flex items-center justify-between">
          <div>
            <h2 className="text-base font-semibold">{t("Códigos de Ativação")}</h2>
            <p className="text-xs text-muted-foreground">
              {t(
                "Códigos pré-gerados para vincular instalações à licença via Proof-of-Possession.",
              )}
            </p>
          </div>
          {license.status === "ACTIVE" && (
            <Button
              size="sm"
              onClick={() => {
                setGeneratedCode(null);
                setShowCodeModal(true);
              }}
            >
              <Key className="mr-1.5 h-3.5 w-3.5" /> {t("Gerar Novo Código")}
            </Button>
          )}
        </div>

        {activationCodes.length === 0 ? (
          <div className="rounded-lg border border-dashed py-6 text-center text-sm text-muted-foreground">
            {t("Nenhum código de ativação gerado para esta licença.")}
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left text-sm">
              <thead className="border-b bg-muted/40 text-xs text-muted-foreground uppercase">
                <tr>
                  <th className="px-3 py-2">{t("ID do Código")}</th>
                  <th className="px-3 py-2">Usos</th>
                  <th className="px-3 py-2">{t("Válido até")}</th>
                  <th className="px-3 py-2">Status</th>
                  <th className="px-3 py-2 text-right">{t("Ação")}</th>
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
                      {new Date(code.expires_at).toLocaleString(tag)}
                    </td>
                    <td className="px-3 py-2.5">
                      {code.revoked_at ? (
                        <span className="text-xs font-medium text-rose-500">REVOGADO</span>
                      ) : code.is_valid ? (
                        <span className="text-xs font-medium text-emerald-500">
                          {t("DISPONÍVEL")}
                        </span>
                      ) : (
                        <span className="text-xs font-medium text-amber-500">
                          EXPIRADO / ESGOTADO
                        </span>
                      )}
                    </td>
                    <td className="px-3 py-2.5 text-right">
                      {!code.revoked_at && (
                        <Button
                          variant="ghost"
                          size="sm"
                          className="h-7 text-xs text-rose-500 hover:text-rose-600"
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
      <div className="space-y-4 rounded-lg border bg-card p-6">
        <div>
          <h2 className="text-base font-semibold">{t("Instalações Vinculadas")}</h2>
          <p className="text-xs text-muted-foreground">
            {t("Instalações autenticadas por chave Ed25519 e certificadas pelo Control Plane.")}
          </p>
        </div>

        {installations.length === 0 ? (
          <div className="rounded-lg border border-dashed py-6 text-center text-sm text-muted-foreground">
            {t("Nenhuma instalação conectada ainda com esta licença.")}
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left text-sm">
              <thead className="border-b bg-muted/40 text-xs text-muted-foreground uppercase">
                <tr>
                  <th className="px-3 py-2">{t("ID da Instalação")}</th>
                  <th className="px-3 py-2">Fingerprint Ed25519</th>
                  <th className="px-3 py-2">Status</th>
                  <th className="px-3 py-2">{t("Versão")}</th>
                  <th className="px-3 py-2">{t("Última validação")}</th>
                  <th className="px-3 py-2 text-right">{t("Ação")}</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {installations.map((inst) => (
                  <tr key={inst.id} className="hover:bg-muted/10">
                    <td className="px-3 py-2.5 font-mono text-xs" title={inst.id}>
                      {inst.id.length > 18
                        ? `${inst.id.slice(0, 12)}…${inst.id.slice(-4)}`
                        : inst.id}
                    </td>
                    <td className="px-3 py-2.5 font-mono text-xs text-muted-foreground">
                      {inst.public_key_fingerprint.slice(0, 16)}...
                    </td>
                    <td className="px-3 py-2.5">
                      <StatusBadge status={inst.status} />
                    </td>
                    <td className="px-3 py-2.5 text-xs">{inst.app_version || "—"}</td>
                    <td className="px-3 py-2.5 text-xs text-muted-foreground">
                      {inst.last_validation_at
                        ? new Date(inst.last_validation_at).toLocaleString(tag)
                        : t("Nunca")}
                    </td>
                    <td className="px-3 py-2.5 text-right">
                      <div className="flex justify-end gap-2">
                        {inst.status === "ACTIVE" && license.status === "ACTIVE" && (
                          <Button
                            size="sm"
                            variant="outline"
                            className="h-7 text-xs"
                            disabled={actionLoading}
                            onClick={() => void handleDownloadLicense(inst.id)}
                          >
                            license.json
                          </Button>
                        )}
                        <Button asChild variant="outline" size="sm" className="h-7 text-xs">
                          <Link href={`/admin/licensing/installations/${inst.id}`}>
                            {t("Detalhes")}
                          </Link>
                        </Button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <section className="space-y-4 rounded-lg border bg-card p-6">
        <div>
          <h2 className="text-base font-semibold">{t("Histórico de eventos")}</h2>
          <p className="text-xs text-muted-foreground">
            {t("Eventos administrativos e validações registradas para esta licença.")}
          </p>
        </div>
        {events.length === 0 ? (
          <p className="text-sm text-muted-foreground">{t("Nenhum evento registrado.")}</p>
        ) : (
          <ol className="space-y-3">
            {events.map((event) => (
              <li
                key={event.id}
                className="flex flex-col gap-1 border-l-2 border-primary/30 pl-3 sm:flex-row sm:items-center sm:justify-between"
              >
                <span className="font-mono text-xs">{event.event_type}</span>
                <span className="text-xs text-muted-foreground">
                  {event.actor_type || "SYSTEM"}
                  {event.actor_id ? ` · ${event.actor_id.slice(0, 8)}` : ""} ·{" "}
                  {new Date(event.created_at).toLocaleString(tag)}
                </span>
              </li>
            ))}
          </ol>
        )}
      </section>

      {/* Code Generation Modal */}
      {showCodeModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4">
          <div className="w-full max-w-md space-y-4 rounded-lg border bg-card p-6 shadow-xl">
            <div className="flex items-center justify-between">
              <h3 className="text-lg font-bold">
                {generatedCode ? t("Código Gerado com Sucesso") : t("Novo Código de Ativação")}
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
                <div className="rounded-md border border-amber-500/20 bg-amber-500/10 p-3 text-xs text-amber-500">
                  <Warning className="mr-1 inline-block h-3.5 w-3.5" />
                  <strong>{t("ATENÇÃO:")}</strong>{" "}
                  {t(
                    "Este código é exibido apenas UMA VEZ. Copie agora e envie ao operador da instalação. Apenas o hash HMAC-SHA256 foi salvo no banco.",
                  )}
                </div>

                <div className="flex items-center gap-2 rounded-md border bg-muted p-3 font-mono text-xs break-all">
                  <span>{generatedCode}</span>
                  <Button
                    size="icon"
                    variant="ghost"
                    className="ml-auto h-8 w-8 shrink-0"
                    onClick={() => copyToClipboard(generatedCode)}
                  >
                    {copiedCode ? (
                      <Check className="h-4 w-4 text-emerald-500" />
                    ) : (
                      <Copy className="h-4 w-4" />
                    )}
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
                  <label className="mb-1 block text-xs font-medium tracking-wider text-muted-foreground uppercase">
                    {t("Máximo de Usos")}
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
                  <label className="mb-1 block text-xs font-medium tracking-wider text-muted-foreground uppercase">
                    {t("Data Limite de Expiração")}
                  </label>
                  <Input
                    type="date"
                    value={codeExpiresAt}
                    onChange={(e) => setCodeExpiresAt(e.target.value)}
                    required
                  />
                </div>

                <div className="flex justify-end gap-2 border-t pt-2">
                  <Button type="button" variant="outline" onClick={() => setShowCodeModal(false)}>
                    Cancelar
                  </Button>
                  <Button type="submit" disabled={actionLoading}>
                    {actionLoading && <CircleNotch className="mr-1.5 h-4 w-4 animate-spin" />}
                    {t("Gerar Código")}
                  </Button>
                </div>
              </form>
            )}
          </div>
        </div>
      )}

      {showRenewModal && data && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4">
          <section
            role="dialog"
            aria-modal="true"
            aria-labelledby="renew-license-title"
            className="max-h-[90vh] w-full max-w-lg space-y-4 overflow-y-auto rounded-lg border bg-card p-6 shadow-xl"
          >
            <div>
              <h3 id="renew-license-title" className="text-lg font-bold">
                {t("Renovar licença")}
              </h3>
              <p className="text-sm text-muted-foreground">
                {t(
                  "Renovação sem cobrança. A nova licença será assinada novamente. Informe o motivo para auditoria.",
                )}
              </p>
            </div>
            <div>
              <label className="mb-1 block text-sm font-medium">Prazo</label>
              <select
                value={renewalTerm}
                onChange={(event) => {
                  setRenewalTerm(event.target.value);
                  setRenewalIdempotencyKey(null);
                }}
                className="h-10 w-full rounded-md border border-input bg-background px-3 text-sm"
              >
                <option value="30d">+30 dias</option>
                <option value="90d">+90 dias</option>
                <option value="6m">+6 meses</option>
                <option value="12m">+12 meses</option>
                <option value="24m">+24 meses</option>
                <option value="custom">{t("Data específica")}</option>
              </select>
            </div>
            {renewalTerm === "custom" && (
              <div>
                <label className="mb-1 block text-sm font-medium">Nova validade</label>
                <Input
                  type="date"
                  value={renewalDate}
                  onChange={(event) => {
                    setRenewalDate(event.target.value);
                    setRenewalIdempotencyKey(null);
                  }}
                />
              </div>
            )}
            {renewalNeedsBasis && (
              <fieldset className="space-y-2 rounded-md border p-3">
                <legend className="px-1 text-sm font-medium">
                  {t("Licença vencida: escolha a base do novo prazo")}
                </legend>
                <label className="flex items-start gap-2 text-sm">
                  <input
                    type="radio"
                    name="renewal-basis"
                    value="previous_expiration"
                    checked={renewalBasis === "previous_expiration"}
                    onChange={() => {
                      setRenewalBasis("previous_expiration");
                      setRenewalIdempotencyKey(null);
                    }}
                  />
                  <span>
                    A partir do vencimento anterior (
                    {new Date(data.license.expires_at).toLocaleDateString(tag)})
                  </span>
                </label>
                <label className="flex items-start gap-2 text-sm">
                  <input
                    type="radio"
                    name="renewal-basis"
                    value="today"
                    checked={renewalBasis === "today"}
                    onChange={() => {
                      setRenewalBasis("today");
                      setRenewalIdempotencyKey(null);
                    }}
                  />
                  <span>A partir de hoje</span>
                </label>
              </fieldset>
            )}
            <div>
              <label className="mb-1 block text-sm font-medium" htmlFor="renewal-reason">
                {t("Motivo obrigatório")}
              </label>
              <textarea
                id="renewal-reason"
                value={renewalReason}
                maxLength={500}
                onChange={(event) => {
                  setRenewalReason(event.target.value);
                  setRenewalIdempotencyKey(null);
                }}
                rows={3}
                className="w-full rounded-md border border-input bg-background p-3 text-sm"
                placeholder="Registre a justificativa comercial"
              />
            </div>
            <div className="flex justify-end gap-2 border-t pt-3">
              <Button variant="outline" onClick={() => setShowRenewModal(false)}>
                Cancelar
              </Button>
              <Button
                onClick={() => void handleRenew()}
                disabled={
                  actionLoading ||
                  !renewalReason.trim() ||
                  (renewalTerm === "custom" && !renewalDate) ||
                  (renewalNeedsBasis && !renewalBasis)
                }
              >
                {actionLoading ? "Renovando…" : t("Confirmar renovação")}
              </Button>
            </div>
          </section>
        </div>
      )}

      {showSuspendModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4">
          <section
            role="dialog"
            aria-modal="true"
            aria-labelledby="suspend-license-title"
            className="max-h-[90vh] w-full max-w-md space-y-4 overflow-y-auto rounded-lg border bg-card p-6 shadow-xl"
          >
            <h3 id="suspend-license-title" className="text-lg font-bold">
              {t("Suspender licença")}
            </h3>
            <p className="text-sm text-muted-foreground">
              {t("A suspensão é reversível e encerra as sessões ativas registradas.")}
            </p>
            <label className="block text-sm font-medium">
              {t("Motivo obrigatório")}
              <Input
                className="mt-1"
                value={suspendReason}
                onChange={(event) => setSuspendReason(event.target.value)}
                maxLength={500}
              />
            </label>
            <label className="block text-sm font-medium">
              {t("Observação interna opcional")}
              <textarea
                className="mt-1 w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
                rows={3}
                maxLength={1000}
                value={suspendNote}
                onChange={(event) => setSuspendNote(event.target.value)}
              />
            </label>
            <div className="flex justify-end gap-2 border-t pt-3">
              <Button variant="outline" onClick={() => setShowSuspendModal(false)}>
                Cancelar
              </Button>
              <Button
                variant="destructive"
                disabled={actionLoading || !suspendReason.trim()}
                onClick={() => void handleSuspend()}
              >
                {actionLoading ? "Suspending…" : t("Suspender licença")}
              </Button>
            </div>
          </section>
        </div>
      )}

      {/* Revocation Modal */}
      {showTransferModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4">
          <div className="w-full max-w-xl space-y-4 rounded-lg border bg-card p-6 shadow-xl">
            <h3 className="text-lg font-bold">{t("Transferir instalação")}</h3>
            <p className="text-sm text-muted-foreground">
              {t(
                "A instalação atual será marcada como transferida e a instalação de destino será ativada na mesma transação. Informe o ID e a chave pública que o novo runtime gerou localmente.",
              )}
            </p>
            <div>
              <label className="mb-1 block text-xs font-medium text-muted-foreground">
                {t("Instalação atual")}
              </label>
              <select
                value={transferFrom}
                onChange={(event) => setTransferFrom(event.target.value)}
                className="h-9 w-full rounded-md border border-input bg-background px-3 text-sm"
              >
                <option value="">Selecione</option>
                {installations
                  .filter((installation) => installation.status === "ACTIVE")
                  .map((installation) => (
                    <option key={installation.id} value={installation.id}>
                      {installation.id}
                    </option>
                  ))}
              </select>
            </div>
            <div>
              <label className="mb-1 block text-xs font-medium text-muted-foreground">
                {t("ID da nova instalação")}
              </label>
              <Input
                value={transferTo}
                onChange={(event) => setTransferTo(event.target.value)}
                placeholder="inst_<UUIDv4>"
              />
            </div>
            <div>
              <label className="mb-1 block text-xs font-medium text-muted-foreground">
                {t("Chave pública Ed25519 da nova instalação")}
              </label>
              <textarea
                value={transferPublicKey}
                onChange={(event) => setTransferPublicKey(event.target.value)}
                rows={4}
                className="w-full rounded-md border border-input bg-background px-3 py-2 font-mono text-xs"
                autoComplete="off"
              />
            </div>
            <div>
              <label className="mb-1 block text-xs font-medium text-muted-foreground">
                {t("Motivo da transferência")}
              </label>
              <Input
                value={transferReason}
                onChange={(event) => setTransferReason(event.target.value)}
                maxLength={500}
              />
            </div>
            <div className="flex justify-end gap-2 border-t pt-2">
              <Button variant="outline" onClick={() => setShowTransferModal(false)}>
                Cancelar
              </Button>
              <Button
                onClick={handleTransfer}
                disabled={
                  actionLoading ||
                  !transferFrom ||
                  !transferTo.trim() ||
                  !transferPublicKey.trim() ||
                  !transferReason.trim()
                }
              >
                {t("Transferir com confirmação")}
              </Button>
            </div>
          </div>
        </div>
      )}

      {showRevokeModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4">
          <div className="w-full max-w-md space-y-4 rounded-lg border bg-card p-6 shadow-xl">
            <h3 className="flex items-center gap-2 text-lg font-bold text-rose-500">
              <Warning className="h-5 w-5" /> {t("Revogação Permanente de Licença")}
            </h3>
            <p className="text-sm text-muted-foreground">
              {t("A revogação de uma licença é")} <strong>{t("permanente e irreversível")}</strong>
              {t(
                ". Todas as instalações perderão autorização de renewal e download de atualizações.",
              )}
            </p>
            <div>
              <label className="mb-1 block text-xs font-medium text-muted-foreground">
                {t("Motivo da revogação")}
              </label>
              <Input
                value={revokeReason}
                onChange={(e) => setRevokeReason(e.target.value)}
                maxLength={500}
              />
            </div>
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
                disabled={revokeConfirmText !== "REVOKE" || !revokeReason.trim() || actionLoading}
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
