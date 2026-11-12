"use client";

import Link from "next/link";
import { useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useT } from "@/hooks/i18n/useT";
import { useTagDeIdioma } from "@/hooks/i18n/useLocaleDeData";
import type { LicenseAdminSummary } from "@/lib/licensing/admin-view";

interface Props {
  initialLicense: LicenseAdminSummary;
}

const STATUS_LABEL: Record<LicenseAdminSummary["status"], string> = {
  ACTIVE: "Ativa",
  GRACE: "Em período de carência",
  EXPIRED: "Expirada",
  SUSPENDED: "Suspensa",
  REVOKED: "Revogada",
  INVALID: "Inválida ou ausente",
};

const PLAN_LABEL: Record<NonNullable<LicenseAdminSummary["plan"]>, string> = {
  standard: "Essencial",
  pro: "Profissional",
  enterprise: "Escala",
};

function formatarData(value: string | null, locale: string): string {
  if (!value) return "—";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "—";
  return new Intl.DateTimeFormat(locale, {
    dateStyle: "short",
    timeStyle: "short",
    timeZone: "America/Sao_Paulo",
  }).format(date);
}

function alertas(license: LicenseAdminSummary): { text: string; tone: string }[] {
  if (license.clone_status === "CLONE_CONFIRMED" || license.clone_status === "TRANSFER_PENDING")
    return [
      {
        text: "Foi detectado um conflito de identidade desta instalação. As operações licenciadas estão restritas; contacte o fornecedor para regularização.",
        tone: "danger",
      },
    ];
  if (license.clone_status === "SUSPECTED_CLONE")
    return [
      {
        text: "Há uma validação simultânea desta identidade. A instalação continua disponível enquanto o fornecedor verifica o conflito.",
        tone: "warning",
      },
    ];
  if (license.status === "REVOKED")
    return [
      {
        text: "Esta licença foi revogada. As operações comerciais licenciadas estão restritas.",
        tone: "danger",
      },
    ];
  if (license.status === "EXPIRED")
    return [
      {
        text: "O período de carência terminou. As operações comerciais licenciadas estão restritas.",
        tone: "danger",
      },
    ];
  if (license.status === "SUSPENDED")
    return [
      {
        text: "O License Server suspendeu esta instalação; as operações comerciais estão restritas.",
        tone: "danger",
      },
    ];
  if (license.error_code === "LICENSE_ONLINE_VALIDATION_STALE")
    return [
      {
        text: "A tolerância offline da validação online terminou. Reconecte ao License Server.",
        tone: "danger",
      },
    ];
  if (license.status === "GRACE")
    return [
      {
        text: `A licença venceu. O período de carência de ${license.grace_period_days} dias mantém a operação temporariamente disponível.`,
        tone: "warning",
      },
    ];
  if (license.status === "INVALID")
    return [
      {
        text: "Não há uma licença local válida. Atualize o arquivo assinado para liberar as operações licenciadas.",
        tone: license.restricted_mode_active ? "danger" : "warning",
      },
    ];
  if ([30, 15, 7, 1].includes(license.days_remaining ?? -1)) {
    return [
      {
        text: `A licença vence em ${license.days_remaining} ${license.days_remaining === 1 ? "dia" : "dias"}.`,
        tone: "warning",
      },
    ];
  }
  return [];
}

export function LicenseAdminClient({ initialLicense }: Props) {
  const t = useT();
  const locale = useTagDeIdioma();
  const [license, setLicense] = useState(initialLicense);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [activationCode, setActivationCode] = useState("");
  const [recoveryCode, setRecoveryCode] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);

  async function validarAgora() {
    setBusy(true);
    setMessage(null);
    try {
      const response = await fetch("/api/v1/admin/license/validate", {
        method: "POST",
        cache: "no-store",
      });
      const body = await response.json();
      if (!response.ok)
        throw new Error(body?.error?.message ?? "Não foi possível validar a licença.");
      setLicense(body.data.license as LicenseAdminSummary);
      setMessage(
        body.data.online_validation?.status === "VALIDATED"
          ? "Validação online concluída e resposta assinada confirmada."
          : body.data.online_validation?.status === "NOT_CONFIGURED"
            ? "Validação local concluída. O endereço do License Server não está configurado."
            : "Validação local concluída; a tolerância offline foi aplicada.",
      );
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Não foi possível validar a licença.");
    } finally {
      setBusy(false);
    }
  }

  async function ativarOnline(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!activationCode.trim()) return;
    setBusy(true);
    setMessage(null);
    try {
      const response = await fetch("/api/v1/admin/license/activate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ activation_code: activationCode }),
      });
      const body = await response.json();
      if (!response.ok)
        throw new Error(body?.error?.message ?? "Não foi possível ativar a licença.");
      setLicense(body.data as LicenseAdminSummary);
      setActivationCode("");
      setMessage("Licença ativada e assinatura do License Server confirmada.");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Não foi possível ativar a licença.");
    } finally {
      setBusy(false);
    }
  }

  async function atualizarArquivo(file: File | undefined) {
    if (!file) return;
    setBusy(true);
    setMessage(null);
    try {
      const text = await file.text();
      const document: unknown = JSON.parse(text);
      const response = await fetch("/api/v1/admin/license/update", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ document }),
      });
      const body = await response.json();
      if (!response.ok)
        throw new Error(
          body?.error?.message ?? "A licença foi recusada; o arquivo atual foi preservado.",
        );
      setLicense(body.data.license as LicenseAdminSummary);
      setMessage("Licença atualizada e validada.");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Não foi possível atualizar a licença.");
    } finally {
      setBusy(false);
      if (inputRef.current) inputRef.current.value = "";
    }
  }

  async function recuperarIdentidade(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!recoveryCode.trim()) return;
    setBusy(true);
    setMessage(null);
    try {
      const response = await fetch("/api/v1/admin/license/recover", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ recovery_code: recoveryCode.trim() }),
      });
      const body = await response.json();
      if (!response.ok)
        throw new Error(body?.error?.message ?? "Não foi possível recuperar a instalação.");
      setLicense(body.data.license as LicenseAdminSummary);
      setRecoveryCode("");
      setMessage("Identidade da instalação recuperada e validada pelo fornecedor.");
    } catch (error) {
      setMessage(
        error instanceof Error ? error.message : "Não foi possível recuperar a instalação.",
      );
    } finally {
      setBusy(false);
    }
  }

  const notices = alertas(license);
  const data = [
    ["Serial", license.serial_masked ?? "Não informado"],
    ["Plano contratado", license.plan ? PLAN_LABEL[license.plan] : "Não informado"],
    ["Validade", formatarData(license.expires_at, locale)],
    ["Dias restantes", license.days_remaining === null ? "—" : String(license.days_remaining)],
    ["Carência", `${license.grace_period_days} dias`],
    ["Identificador da instalação", license.installation_id_masked ?? "Indisponível"],
    ["Última validação local", formatarData(license.last_validated_at, locale)],
    ["Última validação online", formatarData(license.last_successful_online_validation, locale)],
    ["Próxima validação online", formatarData(license.next_online_validation_at, locale)],
  ];

  return (
    <section className="mx-auto max-w-4xl space-y-6" aria-labelledby="license-title">
      <Link
        href="/app/settings"
        className="text-sm text-muted-foreground underline-offset-4 hover:underline"
      >
        {t("Voltar para Configurações")}
      </Link>
      <header>
        <h1 id="license-title" className="text-2xl font-semibold tracking-tight">
          {t("Licença da instalação")}
        </h1>
        <p className="mt-1 text-sm text-muted-foreground">
          {t(
            "Estado local da autorização comercial. O Bootstrap Token do primeiro acesso é independente desta licença.",
          )}
        </p>
      </header>

      <div
        className={`rounded-lg border p-4 ${license.status === "ACTIVE" ? "border-emerald-500/40 bg-emerald-500/5" : license.status === "GRACE" ? "border-amber-500/50 bg-amber-500/5" : "border-destructive/40 bg-destructive/5"}`}
        role="status"
      >
        <p className="text-sm font-semibold">Status: {STATUS_LABEL[license.status]}</p>
        <p className="mt-1 text-sm text-muted-foreground">
          {license.restricted_mode_active
            ? t(
                "Modo restrito ativo. Login, administração da plataforma, leitura, backup, exportação e atualização da licença continuam disponíveis.",
              )
            : license.enforcement_mode === "warn" && !license.usable
              ? t(
                  "Modo de desenvolvimento: a licença é acompanhada no painel e as operações ainda não são bloqueadas.",
                )
              : license.status === "ACTIVE"
                ? t("A licença está válida para esta instalação.")
                : t("A situação da licença requer atenção do administrador da plataforma.")}
        </p>
      </div>

      {notices.map((notice) => (
        <div
          key={notice.text}
          className={`rounded-lg border p-3 text-sm ${notice.tone === "danger" ? "border-destructive/40 bg-destructive/5 text-destructive" : "border-amber-500/50 bg-amber-500/5"}`}
          role="alert"
        >
          {notice.text}
        </div>
      ))}

      {license.clock_rollback_suspected && (
        <div
          className="rounded-lg border border-amber-500/50 bg-amber-500/5 p-3 text-sm"
          role="alert"
        >
          {t(
            "O relógio local parece ter regredido. A operação não foi bloqueada; uma futura revalidação online será necessária.",
          )}
        </div>
      )}

      <dl className="grid gap-3 sm:grid-cols-2">
        {data.map(([label, value]) => (
          <div key={label} className="min-w-0 rounded-lg border bg-card p-4">
            <dt className="text-xs font-medium text-muted-foreground">{label}</dt>
            <dd className="mt-1 text-sm font-medium break-words">{value}</dd>
          </div>
        ))}
      </dl>

      {!license.clock_baseline_available && (
        <p className="text-xs text-muted-foreground">
          {t(
            "O registro local de horário ainda não está disponível; a validação da assinatura continua independente dele.",
          )}
        </p>
      )}

      <div className="flex flex-wrap gap-3">
        <Button type="button" variant="outline" disabled={busy} onClick={() => void validarAgora()}>
          {busy ? "Aguarde…" : t("Validar agora")}
        </Button>
        <Button type="button" disabled={busy} onClick={() => inputRef.current?.click()}>
          {t("Atualizar licença")}
        </Button>
        <Input
          ref={inputRef}
          type="file"
          accept="application/json,.json"
          className="sr-only h-px w-px p-0"
          aria-label={t("Selecionar arquivo de licença assinado")}
          onChange={(event) => void atualizarArquivo(event.currentTarget.files?.[0])}
        />
      </div>
      {license.status === "INVALID" && !license.serial_masked && (
        <form
          className="space-y-3 rounded-lg border bg-card p-4"
          onSubmit={(event) => void ativarOnline(event)}
        >
          <div>
            <h2 className="text-sm font-semibold">{t("Ativar instalação online")}</h2>
            <p className="mt-1 text-xs text-muted-foreground">
              {t(
                "Use o código fornecido pelo operador. Ele será enviado somente ao License Server configurado.",
              )}
            </p>
          </div>
          <div className="flex flex-col gap-2 sm:flex-row">
            <Input
              value={activationCode}
              onChange={(event) => setActivationCode(event.target.value)}
              autoComplete="off"
              spellCheck={false}
              aria-label={t("Código de ativação da licença")}
              placeholder="ACT_…"
              className="min-w-0 font-mono"
            />
            <Button type="submit" disabled={busy || activationCode.trim().length === 0}>
              {busy ? "Aguarde…" : t("Ativar instalação")}
            </Button>
          </div>
        </form>
      )}
      {["SUSPECTED_CLONE", "CLONE_CONFIRMED", "TRANSFER_PENDING"].includes(
        license.clone_status ?? "",
      ) && (
        <form
          className="space-y-3 rounded-lg border bg-card p-4"
          onSubmit={(event) => void recuperarIdentidade(event)}
        >
          <div>
            <h2 className="text-sm font-semibold">{t("Recuperar identidade da instalação")}</h2>
            <p className="mt-1 text-xs text-muted-foreground">
              {t(
                "Solicite ao fornecedor um código de recuperação. A nova chave permanece nesta instalação e não é enviada ao fornecedor.",
              )}
            </p>
          </div>
          <div className="flex flex-col gap-2 sm:flex-row">
            <Input
              type="password"
              value={recoveryCode}
              onChange={(event) => setRecoveryCode(event.target.value)}
              autoComplete="off"
              spellCheck={false}
              aria-label={t("Código de recuperação emitido pelo fornecedor")}
              placeholder="REC_…"
              className="min-w-0 font-mono"
            />
            <Button type="submit" disabled={busy || recoveryCode.trim().length === 0}>
              {busy ? "Aguarde…" : "Recuperar identidade"}
            </Button>
          </div>
        </form>
      )}
      {message && (
        <p className="text-sm" role="status" aria-live="polite">
          {message}
        </p>
      )}
    </section>
  );
}
