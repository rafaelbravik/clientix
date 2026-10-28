import { createHash } from "node:crypto";

import { splitForSend } from "@/lib/agent-engine/agent/split-message";

export const MAXIMO_BALOES_POR_DESTINATARIO = 3;

/** Usa o splitter canônico; campanhas não têm modo de template aprovado. */
export function separarMensagemDeCampanha(
  body: string,
  enabled: boolean,
  channel: "whatsapp" | "telegram" | "email",
): string[] {
  if (!enabled || channel !== "whatsapp") return [body];
  const partes = splitForSend(body, true, Number.POSITIVE_INFINITY, MAXIMO_BALOES_POR_DESTINATARIO);
  return partes.length > 0 ? partes : [body];
}

/** ID estável por campanha, destinatário e posição; retries leem a mesma mensagem. */
export function idDaMensagemDaBolha(campaignId: string, recipientId: string, index: number): string {
  const bytes = createHash("sha256")
    .update(`campaign:${campaignId}:recipient:${recipientId}:bubble:${index + 1}`)
    .digest()
    .subarray(0, 16);
  bytes[6] = (bytes[6]! & 0x0f) | 0x50;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export function chaveDaBolha(campaignId: string, recipientId: string, index: number): string {
  return `campaign:${campaignId}:recipient:${recipientId}:bubble:${index + 1}`;
}

export async function enviarBaloesEmSequencia<T extends { status?: string }>(
  baloes: readonly string[],
  enviar: (body: string, index: number) => Promise<T>,
  esperarEntre: () => Promise<void>,
): Promise<{ completa: boolean; enviados: number; ultimo: T | undefined }> {
  let ultimo: T | undefined;
  let enviados = 0;
  for (let index = 0; index < baloes.length; index += 1) {
    if (index > 0) await esperarEntre();
    ultimo = await enviar(baloes[index]!, index);
    if (!ultimo.status || !["sent", "delivered", "read"].includes(ultimo.status)) {
      return { completa: false, enviados, ultimo };
    }
    enviados += 1;
  }
  return { completa: true, enviados, ultimo };
}
