import { getWahaClient } from "@/lib/waha/client";

/**
 * Transporta a leitura de histórico para o seam de canais. Por enquanto só o
 * adapter que oferece histórico do aparelho implementa esse contrato; provider
 * desconhecido ou sem suporte falha fechado.
 */
export function getHistoryProvider(provider: string) {
  if (provider !== "waha") return null;
  return getWahaClient();
}
