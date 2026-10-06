import { randomUUID } from "node:crypto";
import { type NextRequest, NextResponse } from "next/server";
import { z } from "zod";

import { fail, ok } from "@/lib/api/wrappers";
import { audit } from "@/lib/audit";
import { requireRole } from "@/lib/auth/require-role";
import { requireSupportWrite } from "@/lib/impersonate/support";
import { createAdminClient } from "@/lib/supabase/admin";
import { checkChannelQuota } from "@/lib/tenant/plan-limits";
import { decryptWebhookSecret, encryptWebhookSecret } from "@/lib/webhooks/secrets";
import { basePublicaDaInstalacao } from "@/lib/webhooks/url-publica";
import {
  telegramDeleteWebhook,
  telegramGetMe,
  telegramSetWebhook,
} from "@/lib/channels/telegram/client";
import { invalidateWebhookCacheBySessionId, invalidateWebhookSessionCache } from "@/lib/channels/webhook-session-cache";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const connectBotSchema = z.object({
  token: z.string().trim().min(20).max(100),
  display_name: z.string().trim().min(1).max(100).optional(),
});

export async function GET(req: NextRequest): Promise<NextResponse> {
  const requestId = randomUUID();
  const authz = await requireRole("admin", { requestId, resource: "channels_telegram" });
  if (!authz.ok) return authz.response;

  const admin = createAdminClient();
  const { data: sessao } = await admin
    .from("channel_sessions")
    .select("id, telegram_bot_id, telegram_bot_username, display_name, status, webhook_path_token, archived_at")
    .eq("organization_id", authz.org.orgId)
    .eq("provider", "telegram")
    .is("archived_at", null)
    .maybeSingle();

  if (!sessao) {
    return ok(
      {
        connected: false,
        provider: "telegram",
      },
      { requestId },
    );
  }

  const webhookUrl = sessao.webhook_path_token
    ? `${basePublicaDaInstalacao(req)}/api/v1/webhooks/channel/${sessao.webhook_path_token}`
    : null;

  return ok(
    {
      connected: true,
      provider: "telegram",
      channel_session_id: sessao.id,
      bot_id: sessao.telegram_bot_id,
      bot_username: sessao.telegram_bot_username,
      display_name: sessao.display_name,
      status: sessao.status,
      webhook_url: webhookUrl,
    },
    { requestId },
  );
}

export async function POST(req: NextRequest): Promise<NextResponse> {
  const supportDenied = await requireSupportWrite();
  if (supportDenied) return supportDenied;

  const requestId = randomUUID();
  const authz = await requireRole("admin", { requestId, resource: "channels_telegram" });
  if (!authz.ok) return authz.response;

  const json = await req.json().catch(() => ({}));
  const parsed = connectBotSchema.safeParse(json);
  if (!parsed.success) {
    return fail("validation_failed", "Token do bot inválido.", 422, {
      requestId,
      details: parsed.error.flatten(),
    });
  }

  const { token, display_name } = parsed.data;

  const admin = createAdminClient();
  const { data: sessaoExistente } = await admin
    .from("channel_sessions")
    .select("id")
    .eq("organization_id", authz.org.orgId)
    .eq("provider", "telegram")
    .is("archived_at", null)
    .maybeSingle();

  const channelQuota = await checkChannelQuota(admin, authz.org.orgId, "telegram", {
    excludeChannelSessionId: sessaoExistente?.id,
  });
  if (!channelQuota.allowed) {
    return fail("quota_exceeded", channelQuota.reason ?? "Limite de canais atingido para o plano.", 403, {
      requestId,
    });
  }

  // 1. Valida na API do Telegram
  let me;
  try {
    me = await telegramGetMe(token);
  } catch (err) {
    const msg = err instanceof Error ? err.message : "token_invalido";
    return fail("unauthorized", `Falha ao validar token com o Telegram: ${msg}`, 400, {
      requestId,
    });
  }

  // 2. Cifra o token do bot
  const tokenEncryptedHex = await encryptWebhookSecret(admin, token);
  if (!tokenEncryptedHex) {
    return fail("internal_error", "Falha ao cifrar credencial do bot.", 500, { requestId });
  }

  // 3. Gera tokens de webhook
  const webhookPathToken = randomUUID().replace(/-/g, "");
  const webhookSecretPlain = randomUUID().replace(/-/g, "") + randomUUID().replace(/-/g, "");
  const webhookSecretEncryptedHex = await encryptWebhookSecret(admin, webhookSecretPlain);
  if (!webhookSecretEncryptedHex) {
    return fail("internal_error", "Falha ao cifrar segredo do webhook.", 500, { requestId });
  }

  // 4. Registra o webhook na API do Telegram
  const webhookUrl = `${basePublicaDaInstalacao(req)}/api/v1/webhooks/channel/${webhookPathToken}`;
  try {
    await telegramSetWebhook(token, webhookUrl, webhookSecretPlain);
  } catch (err) {
    const msg = err instanceof Error ? err.message : "falha_webhook";
    return fail("bad_gateway", `Não foi possível configurar o Webhook no Telegram: ${msg}`, 502, {
      requestId,
    });
  }

  // 5. Identifica e arquiva sessões antigas de telegram desta org, se houver
  const { data: sessoesAntigas } = await admin
    .from("channel_sessions")
    .select("id, webhook_path_token")
    .eq("organization_id", authz.org.orgId)
    .eq("provider", "telegram")
    .is("archived_at", null);

  await admin
    .from("channel_sessions")
    .update({ archived_at: new Date().toISOString() })
    .eq("organization_id", authz.org.orgId)
    .eq("provider", "telegram")
    .is("archived_at", null);

  if (sessoesAntigas) {
    for (const antiga of sessoesAntigas) {
      invalidateWebhookCacheBySessionId(antiga.id);
      if (antiga.webhook_path_token) {
        invalidateWebhookSessionCache(antiga.webhook_path_token);
      }
    }
  }

  // 6. Insere a nova sessão
  const botIdStr = String(me.id);
  const botName = display_name || me.first_name || me.username || `Bot ${botIdStr}`;

  const { data: novaSessao, error: insertErr } = await admin
    .from("channel_sessions")
    .insert({
      organization_id: authz.org.orgId,
      provider: "telegram",
      display_name: botName,
      telegram_bot_id: botIdStr,
      telegram_bot_username: me.username ?? null,
      telegram_bot_token_encrypted: Buffer.from(tokenEncryptedHex.replace(/^\\x/, ""), "hex") as unknown as string,
      webhook_path_token: webhookPathToken,
      webhook_secret_encrypted: Buffer.from(webhookSecretEncryptedHex.replace(/^\\x/, ""), "hex") as unknown as string,
      status: "WORKING",
    })
    .select("id")
    .single();

  if (insertErr || !novaSessao) {
    return fail("internal_error", `Falha ao gravar sessão: ${insertErr?.message ?? "sem id"}`, 500, {
      requestId,
    });
  }

  await audit({
    organizationId: authz.org.orgId,
    actorUserId: authz.user.id,
    action: "channel.connected",
    resourceType: "channel_session",
    resourceId: novaSessao.id,
    metadata: {
      provider: "telegram",
      bot_id: botIdStr,
      username: me.username,
    },
  });

  return ok(
    {
      connected: true,
      channel_session_id: novaSessao.id,
      bot: {
        id: me.id,
        first_name: me.first_name,
        username: me.username,
      },
      webhook_url: webhookUrl,
    },
    { requestId },
  );
}

export async function DELETE(req: NextRequest): Promise<NextResponse> {
  const supportDenied = await requireSupportWrite();
  if (supportDenied) return supportDenied;

  const requestId = randomUUID();
  const authz = await requireRole("admin", { requestId, resource: "channels_telegram" });
  if (!authz.ok) return authz.response;

  const admin = createAdminClient();
  const { data: sessao } = await admin
    .from("channel_sessions")
    .select("id, telegram_bot_id, telegram_bot_token_encrypted")
    .eq("organization_id", authz.org.orgId)
    .eq("provider", "telegram")
    .is("archived_at", null)
    .maybeSingle();

  if (!sessao) {
    return fail("not_found", "Nenhum bot do Telegram ativo encontrado nesta organização.", 404, {
      requestId,
    });
  }

  // Tenta desvincular webhook no Telegram
  if (sessao.telegram_bot_token_encrypted) {
    const raw = sessao.telegram_bot_token_encrypted;
    const hex = typeof raw === "string" ? raw : Buffer.from(raw as Uint8Array).toString("hex");
    const token = await decryptWebhookSecret(admin, hex);
    if (token) {
      await telegramDeleteWebhook(token).catch(() => null);
    }
  }

  // Arquiva a sessão
  await admin
    .from("channel_sessions")
    .update({ archived_at: new Date().toISOString() })
    .eq("id", sessao.id);

  invalidateWebhookCacheBySessionId(sessao.id);

  await audit({
    organizationId: authz.org.orgId,
    actorUserId: authz.user.id,
    action: "channel.archived",
    resourceType: "channel_session",
    resourceId: sessao.id,
    metadata: {
      provider: "telegram",
      bot_id: sessao.telegram_bot_id,
    },
  });

  return ok({ disconnected: true }, { requestId });
}
