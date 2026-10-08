import React from "react";

export function TemporalStateBadge({ state }: { state?: string }) {
  switch (state) {
    case "VALID":
      return (
        <span className="inline-flex items-center px-2 py-0.5 rounded text-xs font-medium bg-emerald-500/10 text-emerald-500 border border-emerald-500/20">
          VÁLIDA
        </span>
      );
    case "GRACE":
      return (
        <span className="inline-flex items-center px-2 py-0.5 rounded text-xs font-medium bg-amber-500/10 text-amber-500 border border-amber-500/20">
          CARÊNCIA (GRACE)
        </span>
      );
    case "EXPIRED":
      return (
        <span className="inline-flex items-center px-2 py-0.5 rounded text-xs font-medium bg-rose-500/10 text-rose-500 border border-rose-500/20">
          EXPIRADA
        </span>
      );
    case "NOT_YET_VALID":
      return (
        <span className="inline-flex items-center px-2 py-0.5 rounded text-xs font-medium bg-zinc-500/10 text-zinc-400 border border-zinc-500/20">
          NÃO INICIADA
        </span>
      );
    default:
      return (
        <span className="inline-flex items-center px-2 py-0.5 rounded text-xs font-medium bg-zinc-500/10 text-zinc-400 border border-zinc-500/20">
          {state || "DESCONHECIDO"}
        </span>
      );
  }
}

export function StatusBadge({ status }: { status?: string }) {
  switch (status) {
    case "ACTIVE":
      return (
        <span className="inline-flex items-center px-2 py-0.5 rounded text-xs font-medium bg-emerald-500/10 text-emerald-500 border border-emerald-500/20">
          ATIVO
        </span>
      );
    case "SUSPENDED":
      return (
        <span className="inline-flex items-center px-2 py-0.5 rounded text-xs font-medium bg-amber-500/10 text-amber-500 border border-amber-500/20">
          SUSPENSO
        </span>
      );
    case "REVOKED":
      return (
        <span className="inline-flex items-center px-2 py-0.5 rounded text-xs font-medium bg-rose-500/10 text-rose-500 border border-rose-500/20">
          REVOGADO
        </span>
      );
    case "DEACTIVATED":
      return (
        <span className="inline-flex items-center px-2 py-0.5 rounded text-xs font-medium bg-zinc-500/10 text-zinc-400 border border-zinc-500/20">
          DESATIVADO
        </span>
      );
    default:
      return (
        <span className="inline-flex items-center px-2 py-0.5 rounded text-xs font-medium bg-zinc-500/10 text-zinc-400 border border-zinc-500/20">
          {status || "—"}
        </span>
      );
  }
}
