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
  /** Presente apenas nos tokens curtos emitidos pelo bootstrap WebChat. */
  widgetPublicId?: string;
  /** Epoch em milissegundos; obrigatório junto com widgetPublicId. */
  expiresAt?: number;
}

export const WEBCHAT_TOKEN_TTL_MS = 24 * 60 * 60 * 1000;

/**
 * Gera um token seguro e assinado via HMAC-SHA256 para acesso público do cliente
 * à sua própria conversa no Web Widget.
 */
export function gerarTokenDeAcessoWidget(
  conversationId: string,
  organizationId: string,
  options?: { widgetPublicId: string },
): string {
  const createdAt = Date.now();
  const payload: WidgetTokenPayload = {
    conversationId,
    organizationId,
    createdAt,
    ...(options
      ? {
          widgetPublicId: options.widgetPublicId,
          expiresAt: createdAt + WEBCHAT_TOKEN_TTL_MS,
        }
      : {}),
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

    // Tokens legados expiram em 30 dias. Os novos do bootstrap têm escopo de
    // widget e expiração explícita de 24 horas.
    if (!payload.createdAt || typeof payload.createdAt !== "number") {
      return { valido: false, motivo: "token_sem_timestamp" };
    }

    const agora = Date.now();
    if (payload.createdAt > agora + 60_000) {
      return { valido: false, motivo: "timestamp_futuro" };
    }

    if (payload.widgetPublicId !== undefined) {
      if (
        typeof payload.widgetPublicId !== "string" ||
        !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(payload.widgetPublicId) ||
        typeof payload.expiresAt !== "number"
      ) {
        return { valido: false, motivo: "escopo_widget_invalido" };
      }
      if (
        payload.expiresAt <= agora ||
        payload.expiresAt <= payload.createdAt ||
        payload.expiresAt - payload.createdAt > WEBCHAT_TOKEN_TTL_MS
      ) {
        return { valido: false, motivo: "token_expirado" };
      }
    } else {
      if (payload.expiresAt !== undefined) {
        return { valido: false, motivo: "escopo_widget_invalido" };
      }
      const MAX_TOKEN_AGE_MS = 30 * 24 * 60 * 60 * 1000;
      if (agora - payload.createdAt > MAX_TOKEN_AGE_MS) {
        return { valido: false, motivo: "token_expirado" };
      }
    }

    return { valido: true, payload };
  } catch {
    return { valido: false, motivo: "json_corrompido" };
  }
}
