import type { Lead } from "@/lib/types/leads";

/** Limite seguro e comum à configuração, validação e recorte do quadro. */
export const DIAS_MAXIMO_DO_RECORTE = 3650;
export const DIAS_MINIMO_DO_RECORTE = 1;
export const DIAS_PADRAO_DO_RECORTE = 30;

const MILISSEGUNDOS_POR_DIA = 24 * 60 * 60 * 1000;

/** Valor configurado para este funil; null cobre ausência, zero e settings inválido. */
export function diasDeRecorte(
  settings: Record<string, unknown> | null | undefined,
): number | null {
  const valor = settings?.ocultar_encerrados_dias;
  if (
    typeof valor !== "number" ||
    !Number.isInteger(valor) ||
    valor < DIAS_MINIMO_DO_RECORTE ||
    valor > DIAS_MAXIMO_DO_RECORTE
  ) {
    return null;
  }
  return valor;
}

/** Filtra apenas a exibição do Kanban; nunca altera nem arquiva negócios. */
export function recortaEncerradosAntigos<
  T extends Pick<Lead, "id" | "status" | "closed_at">,
>(
  leads: readonly T[],
  dias: number | null | undefined,
  agora: Date = new Date(),
  manter: string | null = null,
): T[] {
  if (dias == null || !Number.isInteger(dias) || dias < DIAS_MINIMO_DO_RECORTE || dias > DIAS_MAXIMO_DO_RECORTE) {
    return [...leads];
  }

  const corte = agora.getTime() - dias * MILISSEGUNDOS_POR_DIA;
  return leads.filter((lead) => {
    if (
      (lead.status !== "won" && lead.status !== "lost") ||
      (manter !== null && lead.id === manter) ||
      !lead.closed_at
    ) {
      return true;
    }
    const encerradoEm = Date.parse(lead.closed_at);
    return Number.isNaN(encerradoEm) || encerradoEm >= corte;
  });
}
