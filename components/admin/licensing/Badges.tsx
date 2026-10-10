"use client";
import React from "react";
import { useT } from "@/lib/i18n/IdiomaProvider";

export function TemporalStateBadge({ state }: { state?: string }) {
  const t = useT();
  switch (state) {
    case "VALID":
      return (
        <span className="inline-flex items-center rounded-md border border-emerald-500/20 bg-emerald-500/10 px-2 py-0.5 text-xs font-medium text-emerald-500">
          {t("VÁLIDA")}
        </span>
      );
    case "GRACE":
      return (
        <span className="inline-flex items-center rounded-md border border-amber-500/20 bg-amber-500/10 px-2 py-0.5 text-xs font-medium text-amber-500">
          {t("CARÊNCIA (GRACE)")}
        </span>
      );
    case "EXPIRED":
      return (
        <span className="inline-flex items-center rounded-md border border-rose-500/20 bg-rose-500/10 px-2 py-0.5 text-xs font-medium text-rose-500">
          {t("EXPIRADA")}
        </span>
      );
    case "NOT_YET_VALID":
      return (
        <span className="inline-flex items-center rounded-md border border-zinc-500/20 bg-zinc-500/10 px-2 py-0.5 text-xs font-medium text-zinc-400">
          {t("NÃO INICIADA")}
        </span>
      );
    default:
      return (
        <span className="inline-flex items-center rounded-md border border-zinc-500/20 bg-zinc-500/10 px-2 py-0.5 text-xs font-medium text-zinc-400">
          {state || t("DESCONHECIDO")}
        </span>
      );
  }
}

export function StatusBadge({ status }: { status?: string }) {
  const t = useT();
  switch (status) {
    case "ACTIVE":
      return (
        <span className="inline-flex items-center rounded-md border border-emerald-500/20 bg-emerald-500/10 px-2 py-0.5 text-xs font-medium text-emerald-500">
          {t("ATIVO")}
        </span>
      );
    case "SUSPENDED":
      return (
        <span className="inline-flex items-center rounded-md border border-amber-500/20 bg-amber-500/10 px-2 py-0.5 text-xs font-medium text-amber-500">
          {t("SUSPENSO")}
        </span>
      );
    case "REVOKED":
      return (
        <span className="inline-flex items-center rounded-md border border-rose-500/20 bg-rose-500/10 px-2 py-0.5 text-xs font-medium text-rose-500">
          {t("REVOGADO")}
        </span>
      );
    case "DEACTIVATED":
      return (
        <span className="inline-flex items-center rounded-md border border-zinc-500/20 bg-zinc-500/10 px-2 py-0.5 text-xs font-medium text-zinc-400">
          {t("DESATIVADO")}
        </span>
      );
    default:
      return (
        <span className="inline-flex items-center rounded-md border border-zinc-500/20 bg-zinc-500/10 px-2 py-0.5 text-xs font-medium text-zinc-400">
          {status || "—"}
        </span>
      );
  }
}
