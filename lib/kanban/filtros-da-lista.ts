import { z } from "zod";

import { AGENT_OWNER_PREFIX, type LeadFilters, marcadoresDoFiltro } from "@/lib/kanban/filters";

export interface FiltrosDaLista {
  /** UUID de pessoa, `agent:<uuid>` ou `unassigned`. */
  owner?: string;
  status?: "open" | "won" | "lost";
}

export type FiltroForaDaLista = "busca" | "etiqueta" | "atrasados" | "motivo" | "categoria";

export type DonoDoFiltro =
  | { coluna: "owner_user_id" | "owner_agent_id"; id: string }
  | "ninguem";

const uuid = z.string().uuid();

/** Recorta somente os filtros que a consulta paginada da Lista aplica. */
export function filtrosDaLista(filters: LeadFilters): FiltrosDaLista {
  const filtros: FiltrosDaLista = {};
  if (filters.owner && filters.owner !== "any") filtros.owner = filters.owner;
  if (filters.status && filters.status !== "all") filtros.status = filters.status;
  return filtros;
}

/** Serialização estável: owner antes de status. Também identifica o cache. */
export function paramsDosFiltrosDaLista(filters: FiltrosDaLista): string {
  const params = new URLSearchParams();
  if (filters.owner) params.set("owner", filters.owner);
  if (filters.status) params.set("status", filters.status);
  return params.toString();
}

export function filtrosForaDaLista(filters: LeadFilters): FiltroForaDaLista[] {
  const fora: FiltroForaDaLista[] = [];
  if (filters.search?.trim()) fora.push("busca");
  if (marcadoresDoFiltro(filters.tag).length > 0) fora.push("etiqueta");
  if (filters.overdueOnly) fora.push("atrasados");
  if (filters.lostReason) fora.push("motivo");
  if (filters.lostCategory) fora.push("categoria");
  return fora;
}

export function donoDoFiltro(owner: string): DonoDoFiltro {
  if (owner === "unassigned") return "ninguem";
  if (owner.startsWith(AGENT_OWNER_PREFIX)) {
    return { coluna: "owner_agent_id", id: owner.slice(AGENT_OWNER_PREFIX.length) };
  }
  return { coluna: "owner_user_id", id: owner };
}

type LeituraDeFiltros =
  | { ok: true; filtros: FiltrosDaLista }
  | { ok: false; campo: "owner" | "status" };

/** Valida a query antes de abrir qualquer consulta de leads. */
export function lerFiltrosDaLista(searchParams: URLSearchParams): LeituraDeFiltros {
  const filtros: FiltrosDaLista = {};
  const owners = searchParams.getAll("owner");
  const statuses = searchParams.getAll("status");

  if (owners.length > 1) return { ok: false, campo: "owner" };
  if (statuses.length > 1) return { ok: false, campo: "status" };

  if (owners.length === 1) {
    const owner = owners[0] ?? "";
    if (owner === "") return { ok: false, campo: "owner" };
    if (owner !== "any") {
      const agentId = owner.startsWith(AGENT_OWNER_PREFIX)
        ? owner.slice(AGENT_OWNER_PREFIX.length)
        : null;
      const valido =
        owner === "unassigned" ||
        (agentId !== null ? uuid.safeParse(agentId).success : uuid.safeParse(owner).success);
      if (!valido) return { ok: false, campo: "owner" };
      filtros.owner = owner;
    }
  }

  if (statuses.length === 1) {
    const status = statuses[0] ?? "";
    if (status === "all") return { ok: true, filtros };
    if (status !== "open" && status !== "won" && status !== "lost") {
      return { ok: false, campo: "status" };
    }
    filtros.status = status;
  }

  return { ok: true, filtros };
}
