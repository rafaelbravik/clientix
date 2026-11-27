import { randomUUID } from "node:crypto";
import type { NextRequest, NextResponse } from "next/server";
import { z } from "zod";

import { fail, ok } from "@/lib/api/wrappers";
import { audit } from "@/lib/audit";
import { requireRole } from "@/lib/auth/require-role";
import { requireSupportWrite } from "@/lib/impersonate/support";
import { createAdminClient } from "@/lib/supabase/admin";
import { encryptWebhookSecret } from "@/lib/webhooks/secrets";
import { checkChannelQuota } from "@/lib/tenant/plan-limits";
import { logger } from "@/lib/logger";
import { getTelegramAppCredentials } from "@/lib/channels/telegram-user/app-credentials";
import {
  diagnosticoErroTelegram,
  mensagemErroTelegram,
} from "@/lib/channels/telegram-user/auth-errors";
import {
  telegramUserCheckPassword,
  telegramUserSendCode,
  telegramUserSignIn,
} from "@/lib/channels/telegram-user/client";
import { sessionCiphertextForDatabase } from "@/lib/channels/telegram-user/session-storage";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const sendCodeSchema = z.object({
  action: z.literal("send_code"),
  phone: z
    .string()
    .trim()
    .regex(/^\+[1-9]\d{7,14}$/),
});

const signInSchema = z.object({
  action: z.literal("sign_in"),
  phone: z
    .string()
    .trim()
    .regex(/^\+[1-9]\d{7,14}$/),
  phone_code_hash: z.string().trim().min(1).max(256),
  phone_code: z
    .string()
    .trim()
    .regex(/^\d{4,8}$/),
  session_string: z.string().min(1).max(4096),
});

const checkPasswordSchema = z.object({
  action: z.literal("check_password"),
  phone: z
    .string()
    .trim()
    .regex(/^\+[1-9]\d{7,14}$/),
  password: z.string().min(1).max(256),
  session_string: z.string().min(1).max(4096),
});

const authActionSchema = z.discriminatedUnion("action", [
  sendCodeSchema,
  signInSchema,
  checkPasswordSchema,
]);

export async function POST(req: NextRequest): Promise<NextResponse> {
  const supportDenied = await requireSupportWrite();
  if (supportDenied) return supportDenied;

  const requestId = randomUUID();
  const authz = await requireRole("admin", { requestId, resource: "channels_telegram_user" });
  if (!authz.ok) return authz.response;

  const json = await req.json().catch(() => ({}));
  const parsed = authActionSchema.safeParse(json);
  if (!parsed.success) {
    return fail("validation_failed", "Payload de autenticação Telegram MTProto inválido.", 422, {
      requestId,
      details: parsed.error.flatten(),
    });
  }

  const data = parsed.data;
  const admin = createAdminClient();

  // Confere quota de canal da organização
  const channelQuota = await checkChannelQuota(admin, authz.org.orgId, "telegram_user");
  if (!channelQuota.allowed) {
    return fail(
      "quota_exceeded",
      channelQuota.reason ?? "Limite de conexões do plano atingido.",
      403,
      {
        requestId,
        details: { current: channelQuota.current, max: channelQuota.max },
      },
    );
  }

  const appCredentials = await getTelegramAppCredentials();
  if (!appCredentials) {
    return fail(
      "integration_unavailable",
      "O Dono da instalação precisa configurar o API ID e o API Hash em Administração → Configuração da instalação → Telegram.",
      503,
      { requestId },
    );
  }

  if (data.action === "send_code") {
    try {
      const res = await telegramUserSendCode({
        apiId: appCredentials.apiId,
        apiHash: appCredentials.apiHash,
        phone: data.phone,
      });

      if (res.emailRequired) {
        return fail(
          "integration_unavailable",
          "O Telegram pediu uma verificação adicional por e-mail, que ainda não faz parte deste fluxo. Use outra conta ou conecte um Bot oficial.",
          422,
          { requestId },
        );
      }

      return ok(
        {
          action: "send_code",
          phone_code_hash: res.phoneCodeHash,
          is_code_via_app: res.isCodeViaApp,
          session_string: res.sessionString,
        },
        { requestId },
      );
    } catch (err: unknown) {
      const normalized = mensagemErroTelegram(err);
      const diagnostic = diagnosticoErroTelegram(err);
      const logContext = {
        request_id: requestId,
        action: data.action,
        error_type: diagnostic.errorType,
        telegram_code: diagnostic.telegramCode,
      };
      if (normalized.status >= 500) {
        logger.error("telegram_user: falha inesperada na autenticação", logContext);
      } else {
        logger.warn("telegram_user: autenticação recusada", logContext);
      }
      return fail(normalized.code, normalized.message, normalized.status, { requestId });
    }
  }

  if (data.action === "sign_in" || data.action === "check_password") {
    try {
      const loginResult =
        data.action === "sign_in"
          ? await telegramUserSignIn({
              apiId: appCredentials.apiId,
              apiHash: appCredentials.apiHash,
              phone: data.phone,
              phoneCodeHash: data.phone_code_hash,
              phoneCode: data.phone_code,
              sessionString: data.session_string,
            })
          : await telegramUserCheckPassword({
              apiId: appCredentials.apiId,
              apiHash: appCredentials.apiHash,
              phone: data.phone,
              password: data.password,
              sessionString: data.session_string,
            });

      if (loginResult.passwordNeeded) {
        return ok(
          {
            password_needed: true,
            session_string: loginResult.sessionString,
          },
          { requestId },
        );
      }

      if (!loginResult.sessionString || !loginResult.user) {
        return fail("unauthorized", "Falha na autenticação MTProto com o Telegram.", 401, {
          requestId,
        });
      }

      const encSession = await encryptWebhookSecret(admin, loginResult.sessionString);

      if (!encSession) {
        return fail("internal_error", "Falha ao cifrar credenciais MTProto.", 500, { requestId });
      }

      const sessionCiphertext = sessionCiphertextForDatabase(encSession);
      if (!sessionCiphertext) {
        return fail("internal_error", "Falha ao cifrar credenciais MTProto.", 500, { requestId });
      }

      const userIdStr = loginResult.user.id;
      const { data: sessaoExistente, error: lookupError } = await admin
        .from("channel_sessions")
        .select("id")
        .eq("organization_id", authz.org.orgId)
        .eq("provider", "telegram_user")
        .eq("telegram_user_id", userIdStr)
        .is("archived_at", null)
        .maybeSingle();
      if (lookupError) {
        return fail("internal_error", "Falha ao localizar a conta Telegram existente.", 500, {
          requestId,
        });
      }

      const displayName =
        [loginResult.user.firstName, loginResult.user.lastName].filter(Boolean).join(" ").trim() ||
        loginResult.user.username ||
        `Telegram ${data.phone}`;

      const now = new Date().toISOString();
      const sessionFields = {
        display_name: displayName,
        telegram_user_id: userIdStr,
        telegram_phone: data.phone,
        // Colunas antigas de credenciais por tenant são mantidas apenas para
        // compatibilidade; novas sessões nunca recebem o API ID/Hash do app.
        telegram_api_id: null,
        telegram_api_hash_encrypted: null,
        // PostgREST espera o literal bytea recebido do RPC. Enviar Buffer faz
        // o supabase-js serializá-lo como {type:"Buffer",data:[...]}, que o
        // Postgres persiste como texto e impede o worker de abrir a sessão.
        telegram_session_encrypted: sessionCiphertext,
        status: "STARTING" as const,
        status_reason: null,
        last_health_check_at: now,
        last_status_change_at: now,
      };

      const { data: novaSessao, error: insertErr } = sessaoExistente
        ? await admin
            .from("channel_sessions")
            .update(sessionFields)
            .eq("id", sessaoExistente.id)
            .eq("organization_id", authz.org.orgId)
            .eq("provider", "telegram_user")
            .is("archived_at", null)
            .select("id")
            .single()
        : await admin
            .from("channel_sessions")
            .insert({
              organization_id: authz.org.orgId,
              provider: "telegram_user",
              ...sessionFields,
            })
            .select("id")
            .single();

      if (insertErr || !novaSessao) {
        return fail(
          "internal_error",
          "Falha ao salvar a sessão do Telegram. Tente novamente.",
          500,
          { requestId },
        );
      }

      await audit({
        organizationId: authz.org.orgId,
        actorUserId: authz.user.id,
        action: "channel.connected",
        resourceType: "channel_session",
        resourceId: novaSessao.id,
        metadata: {
          provider: "telegram_user",
        },
      });

      return ok(
        {
          connected: true,
          channel_session_id: novaSessao.id,
          user: loginResult.user,
        },
        { requestId },
      );
    } catch (err: unknown) {
      const normalized = mensagemErroTelegram(err);
      const diagnostic = diagnosticoErroTelegram(err);
      const logContext = {
        request_id: requestId,
        action: data.action,
        error_type: diagnostic.errorType,
        telegram_code: diagnostic.telegramCode,
      };
      if (normalized.status >= 500) {
        logger.error("telegram_user: falha inesperada na autenticação", logContext);
      } else {
        logger.warn("telegram_user: autenticação recusada", logContext);
      }
      return fail(normalized.code, normalized.message, normalized.status, { requestId });
    }
  }

  return fail("bad_request", "Ação não suportada.", 400, { requestId });
}
