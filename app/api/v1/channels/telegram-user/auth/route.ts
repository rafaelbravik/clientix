import { randomUUID } from "node:crypto";
import { type NextRequest, NextResponse } from "next/server";
import { z } from "zod";

import { fail, ok } from "@/lib/api/wrappers";
import { audit } from "@/lib/audit";
import { requireRole } from "@/lib/auth/require-role";
import { requireSupportWrite } from "@/lib/impersonate/support";
import { createAdminClient } from "@/lib/supabase/admin";
import { encryptWebhookSecret } from "@/lib/webhooks/secrets";
import { checkChannelQuota } from "@/lib/tenant/plan-limits";
import { env } from "@/lib/env";
import {
  telegramUserCheckPassword,
  telegramUserSendCode,
  telegramUserSignIn,
} from "@/lib/channels/telegram-user/client";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const sendCodeSchema = z.object({
  action: z.literal("send_code"),
  api_id: z.number().int().positive(),
  api_hash: z.string().trim().min(10),
  phone: z.string().trim().min(8),
});

const signInSchema = z.object({
  action: z.literal("sign_in"),
  api_id: z.number().int().positive(),
  api_hash: z.string().trim().min(10),
  phone: z.string().trim().min(8),
  phone_code_hash: z.string().trim().min(1),
  phone_code: z.string().trim().min(1),
});

const checkPasswordSchema = z.object({
  action: z.literal("check_password"),
  api_id: z.number().int().positive(),
  api_hash: z.string().trim().min(10),
  phone: z.string().trim().min(8),
  password: z.string().min(1),
  session_string: z.string().optional(),
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

  if (!env.TELEGRAM_MTPROTO_GATEWAY_URL) {
    return fail(
      "integration_unavailable",
      "Telegram User/MTProto está desativado: configure um gateway HTTPS confiável. O recebimento de mensagens ainda não está integrado.",
      503,
      { requestId },
    );
  }

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

  const { data: sessaoExistente } = await admin
    .from("channel_sessions")
    .select("id")
    .eq("organization_id", authz.org.orgId)
    .eq("provider", "telegram_user")
    .is("archived_at", null)
    .maybeSingle();

  // Confere quota de canal da organização
  const channelQuota = await checkChannelQuota(admin, authz.org.orgId, "telegram_user", {
    excludeChannelSessionId: sessaoExistente?.id,
  });
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

  if (data.action === "send_code") {
    try {
      const res = await telegramUserSendCode({
        apiId: data.api_id,
        apiHash: data.api_hash,
        phone: data.phone,
      });

      return ok(
        {
          action: "send_code",
          phone_code_hash: res.phoneCodeHash,
          is_code_via_app: res.isCodeViaApp,
          timeout: res.timeout,
        },
        { requestId },
      );
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : "falha_ao_enviar_codigo";
      return fail("bad_request", `Falha ao solicitar código MTProto: ${msg}`, 400, {
        requestId,
      });
    }
  }

  if (data.action === "sign_in" || data.action === "check_password") {
    try {
      const loginResult =
        data.action === "sign_in"
          ? await telegramUserSignIn({
              apiId: data.api_id,
              apiHash: data.api_hash,
              phone: data.phone,
              phoneCodeHash: data.phone_code_hash,
              phoneCode: data.phone_code,
            })
          : await telegramUserCheckPassword({
              apiId: data.api_id,
              apiHash: data.api_hash,
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
      const encHash = await encryptWebhookSecret(admin, data.api_hash);

      if (!encSession || !encHash) {
        return fail("internal_error", "Falha ao cifrar credenciais MTProto.", 500, { requestId });
      }

      // Arquiva sessões ativas anteriores deste mesmo usuário na organização
      const userIdStr = loginResult.user.id;
      await admin
        .from("channel_sessions")
        .update({ archived_at: new Date().toISOString() })
        .eq("organization_id", authz.org.orgId)
        .eq("provider", "telegram_user")
        .eq("telegram_user_id", userIdStr)
        .is("archived_at", null);

      const displayName =
        [loginResult.user.firstName, loginResult.user.lastName].filter(Boolean).join(" ").trim() ||
        loginResult.user.username ||
        `Telegram ${data.phone}`;

      const { data: novaSessao, error: insertErr } = await admin
        .from("channel_sessions")
        .insert({
          organization_id: authz.org.orgId,
          provider: "telegram_user",
          display_name: displayName,
          telegram_user_id: userIdStr,
          telegram_phone: data.phone,
          telegram_api_id: data.api_id,
          telegram_api_hash_encrypted: Buffer.from(
            encHash.replace(/^\\x/, ""),
            "hex",
          ) as unknown as string,
          telegram_session_encrypted: Buffer.from(
            encSession.replace(/^\\x/, ""),
            "hex",
          ) as unknown as string,
          status: "WORKING",
        })
        .select("id")
        .single();

      if (insertErr || !novaSessao) {
        return fail(
          "internal_error",
          `Falha ao salvar sessão do Telegram MTProto: ${insertErr?.message ?? "sem id"}`,
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
          telegram_user_id: userIdStr,
          phone: data.phone,
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
      const msg = err instanceof Error ? err.message : "erro_mtproto";
      return fail("bad_gateway", `Erro no processamento MTProto: ${msg}`, 502, {
        requestId,
      });
    }
  }

  return fail("bad_request", "Ação não suportada.", 400, { requestId });
}
