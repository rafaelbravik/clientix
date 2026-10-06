/**
 * Utilitários para extração e leitura segura de webhooks da Nuvemshop.
 */

import type { NextRequest } from "next/server";

/** Teto de 256KB para payloads de webhook (alinhado a MAX_WEBHOOK_PAYLOAD_BYTES do canal) */
export const MAX_NUVEMSHOP_PAYLOAD_BYTES = 256 * 1024;

export type ReadLimitedBodyResult =
  | { ok: true; body: string }
  | { ok: false; error: "payload_too_large" };

/**
 * Lê o corpo da requisição com limite estrito de bytes antes de permitir qualquer bufferização gigante.
 * Rejeita preventivamente se Content-Length declarado exceder o teto, ou se o stream ultrapassar em tempo de leitura.
 */
export async function readLimitedBody(
  req: NextRequest,
  maxBytes: number = MAX_NUVEMSHOP_PAYLOAD_BYTES,
): Promise<ReadLimitedBodyResult> {
  const contentLength = req.headers.get("content-length");
  if (contentLength) {
    const parsed = parseInt(contentLength, 10);
    if (!Number.isNaN(parsed) && parsed > maxBytes) {
      return { ok: false, error: "payload_too_large" };
    }
  }

  if (req.body) {
    const reader = req.body.getReader();
    const decoder = new TextDecoder();
    let totalBytes = 0;
    let result = "";

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        totalBytes += value.byteLength;
        if (totalBytes > maxBytes) {
          await reader.cancel().catch(() => undefined);
          return { ok: false, error: "payload_too_large" };
        }
        result += decoder.decode(value, { stream: true });
      }
      result += decoder.decode();
      return { ok: true, body: result };
    } catch (err) {
      // Se já passou do limite, garante retorno adequado
      if (totalBytes > maxBytes) {
        return { ok: false, error: "payload_too_large" };
      }
      throw err;
    }
  }

  const text = await req.text();
  if (Buffer.byteLength(text, "utf8") > maxBytes) {
    return { ok: false, error: "payload_too_large" };
  }
  return { ok: true, body: text };
}

/**
 * Extrai store_id do corpo do JSON cru com inspeção segura e mínima,
 * antes de executar operações pesadas de negócio.
 * 
 * Nuvemshop sempre inclui `store_id` na raiz de seus webhooks.
 * Retorna string do store_id ou null se ausente/inválido.
 */
export function extractStoreId(rawBody: string): string | null {
  if (!rawBody || typeof rawBody !== "string") return null;

  // 1. Tenta extração via regex rápida para evitar JSON.parse de payloads maliciosos complexos
  const match = /"store_id"\s*:\s*("([^"]+)"|(\d+))/.exec(rawBody);
  if (match) {
    const val = match[2] ?? match[3];
    if (val && val.trim().length > 0) {
      return val.trim();
    }
  }

  // 2. Fallback seguro via JSON.parse restrito
  try {
    const parsed = JSON.parse(rawBody) as { store_id?: number | string };
    if (parsed && parsed.store_id !== undefined && parsed.store_id !== null) {
      const s = String(parsed.store_id).trim();
      return s.length > 0 ? s : null;
    }
  } catch {
    return null;
  }

  return null;
}
