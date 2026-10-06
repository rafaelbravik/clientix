import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * Secret para assinatura de tokens do Web Widget.
 * Usa secrets existentes do ambiente com fallback para desenvolvimento local.
 */
function getWidgetSecret(): string {
  const secret =
    process.env.SUPABASE_JWT_SECRET ||
    process.env.INTERNAL_CRON_SECRET ||
    process.env.APP_SECRET;

  if (!secret) {
    if (process.env.NODE_ENV === "production") {
      throw new Error("WIDGET_SECRET_NOT_CONFIGURED: Defina SUPABASE_JWT_SECRET, INTERNAL_CRON_SECRET ou APP_SECRET em produção.");
    }
    return "clientix-widget-dev-only-salt-2026";
  }

  return secret;
}

export interface WidgetTokenPayload {
  conversationId: string;
  organizationId: string;
  createdAt: number;
}

/**
 * Gera um token seguro e assinado via HMAC-SHA256 para acesso público do cliente
 * à sua própria conversa no Web Widget.
 */
export function gerarTokenDeAcessoWidget(
  conversationId: string,
  organizationId: string,
): string {
  const payload: WidgetTokenPayload = {
    conversationId,
    organizationId,
    createdAt: Date.now(),
  };

  const payloadB64 = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const signature = createHmac("sha256", getWidgetSecret())
    .update(payloadB64)
    .digest("base64url");

  return `${payloadB64}.${signature}`;
}

/**
 * Valida o token recebido e decodifica os identificadores de conversa e organização.
 */
export function validarTokenDeAcessoWidget(token: string): {
  valido: boolean;
  payload?: WidgetTokenPayload;
  motivo?: string;
} {
  if (!token || typeof token !== "string") {
    return { valido: false, motivo: "token_ausente" };
  }

  const parts = token.split(".");
  if (parts.length !== 2) {
    return { valido: false, motivo: "formato_invalido" };
  }

  const [payloadB64, signature] = parts;
  if (!payloadB64 || !signature) {
    return { valido: false, motivo: "partes_invalidas" };
  }

  const expectedSignature = createHmac("sha256", getWidgetSecret())
    .update(payloadB64)
    .digest("base64url");

  const sigBuffer = Buffer.from(signature);
  const expectedBuffer = Buffer.from(expectedSignature);

  if (
    sigBuffer.length !== expectedBuffer.length ||
    !timingSafeEqual(sigBuffer, expectedBuffer)
  ) {
    return { valido: false, motivo: "assinatura_invalida" };
  }

  try {
    const raw = Buffer.from(payloadB64, "base64url").toString("utf-8");
    const payload = JSON.parse(raw) as WidgetTokenPayload;

    if (!payload.conversationId || !payload.organizationId) {
      return { valido: false, motivo: "conteudo_invalido" };
    }

    // Valida expiração: createdAt é estritamente obrigatório e expira em 30 dias
    if (!payload.createdAt || typeof payload.createdAt !== "number") {
      return { valido: false, motivo: "token_sem_timestamp" };
    }

    const MAX_TOKEN_AGE_MS = 30 * 24 * 60 * 60 * 1000;
    const agora = Date.now();
    if (agora - payload.createdAt > MAX_TOKEN_AGE_MS) {
      return { valido: false, motivo: "token_expirado" };
    }
    if (payload.createdAt > agora + 60_000) {
      return { valido: false, motivo: "timestamp_futuro" };
    }

    return { valido: true, payload };
  } catch {
    return { valido: false, motivo: "json_corrompido" };
  }
}
