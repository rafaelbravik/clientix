import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * Verificação oficial de webhook do TikTok segundo a especificação de Webhooks da TikTok Messaging API:
 * https://developers.tiktok.com/docs/en/webhooks-verification
 *
 * Header: `TikTok-Signature` (ou `tiktok-signature`)
 * Formato: `t=<timestamp_seconds>,s=<hex_hmac>`
 * Assinatura esperada: HMAC-SHA256 de `<timestamp>.<rawBody>` com a chave do webhook/app_secret.
 * Inclui validação de janela anti-replay de 5 minutos (300 segundos).
 */
export function verifyTikTokSignature(
  rawBody: string,
  signatureHeader: string | null,
  secret: string,
  toleranceSeconds = 300,
): boolean {
  if (!signatureHeader || !secret) return false;

  let timestampStr: string | null = null;
  let signature: string | null = null;

  // Header pode vir como "t=1695843241,s=..." ou separado por vírgula/ponto-e-vírgula
  const parts = signatureHeader.split(/[,;]\s*/);
  for (const part of parts) {
    const [k, v] = part.split("=");
    if (k && v) {
      const key = k.trim().toLowerCase();
      const val = v.trim();
      if (key === "t" || key === "timestamp") timestampStr = val;
      if (key === "s" || key === "signature") signature = val;
    }
  }

  // Falha fechado se não vier o par estruturado (t e s)
  if (!timestampStr || !signature) {
    return false;
  }

  const timestamp = Number.parseInt(timestampStr, 10);
  if (Number.isNaN(timestamp)) return false;

  // Proteção contra replay: tolerância máxima padrão de 5 minutos (300 segundos)
  const now = Math.floor(Date.now() / 1000);
  if (Math.abs(now - timestamp) > toleranceSeconds) {
    return false;
  }

  // String assinada: `${timestamp}.${rawBody}`
  const signedPayload = `${timestampStr}.${rawBody}`;
  const expected = createHmac("sha256", secret).update(signedPayload, "utf8").digest("hex");

  if (signature.length !== expected.length) return false;

  try {
    return timingSafeEqual(Buffer.from(signature, "hex"), Buffer.from(expected, "hex"));
  } catch {
    return false;
  }
}
