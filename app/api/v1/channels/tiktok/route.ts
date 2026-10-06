import { randomBytes, randomUUID } from "node:crypto";
import { type NextRequest, NextResponse } from "next/server";
import { z } from "zod";

import { fail, ok } from "@/lib/api/wrappers";
import { audit } from "@/lib/audit";
import { requireRole } from "@/lib/auth/require-role";
import { requireSupportWrite } from "@/lib/impersonate/support";
import { createAdminClient } from "@/lib/supabase/admin";
import { decryptWebhookSecret, encryptWebhookSecret } from "@/lib/webhooks/secrets";
import { basePublicaDaInstalacao } from "@/lib/webhooks/url-publica";
import { tiktokGetBusinessInfo } from "@/lib/channels/tiktok/client";
import { checkChannelQuota } from "@/lib/tenant/plan-limits";
import { invalidateWebhookCacheBySessionId } from "@/lib/channels/webhook-session-cache";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const connectTikTokSchema = z.object({
  business_id: z.string().trim().min(3).max(100),
  token: z.string().trim().min(20),
  webhook_secret: z.string().trim().min(16).optional(),
  display_name: z.string().trim().min(1).max(100).optional(),
});

export async function GET(req: NextRequest): Promise<NextResponse> {
  const requestId = randomUUID();
  const authz = await requireRole("admin", { requestId, resource: "channels_tiktok" });
  if (!authz.ok) return authz.response;

  const admin = createAdminClient();
  const { data: sessao } = await admin
    .from("channel_sessions")
    .select("id, tiktok_business_id, tiktok_username, display_name, status, webhook_path_token, webhook_secret_encrypted, archived_at")
    .eq("organization_id", authz.org.orgId)
    .eq("provider", "tiktok")
    .is("archived_at", null)
    .maybeSingle();

  if (!sessao) {
    return ok(
      {
        connected: false,
        provider: "tiktok",
      },
      { requestId },
    );
  }

  const webhookUrl = sessao.webhook_path_token
    ? `${basePublicaDaInstalacao(req)}/api/v1/webhooks/channel/${sessao.webhook_path_token}`
    : null;

  const webhookSecret = sessao.webhook_secret_encrypted
    ? await decryptWebhookSecret(admin, sessao.webhook_secret_encrypted as string)
    : null;

  return ok(
    {
      connected: true,
      provider: "tiktok",
      channel_session_id: sessao.id,
      business_id: sessao.tiktok_business_id,
      username: sessao.tiktok_username,
      display_name: sessao.display_name,
      status: sessao.status,
      webhook_url: webhookUrl,
      webhook_secret: webhookSecret,
    },
    { requestId },
  );
}

export async function POST(req: NextRequest): Promise<NextResponse> {
  const supportDenied = await requireSupportWrite();
  if (supportDenied) return supportDenied;

  const requestId = randomUUID();
  const authz = await requireRole("admin", { requestId, resource: "channels_tiktok" });
  if (!authz.ok) return authz.response;

  const json = await req.json().catch(() => ({}));
  const parsed = connectTikTokSchema.safeParse(json);
  if (!parsed.success) {
    return fail("validation_failed", "Dados da conta TikTok inválidos.", 422, {
      requestId,
      details: parsed.error.flatten(),
    });
  }

  const { business_id, token, webhook_secret, display_name } = parsed.data;

  // 1. Valida conta e token com a TikTok Messaging API
  let info;
  try {
    info = await tiktokGetBusinessInfo(token, business_id);
  } catch (err) {
    const msg = err instanceof Error ? err.message : "token_ou_business_id_invalido";
    return fail("unauthorized", `Falha ao validar conta com o TikTok: ${msg}`, 400, {
      requestId,
    });
  }

  const admin = createAdminClient();

  // 2. Confere se a conta já está conectada
  const { data: conflito } = await admin
    .from("channel_sessions")
    .select("id, organization_id")
    .eq("tiktok_business_id", info.business_id)
    .eq("provider", "tiktok")
    .is("archived_at", null)
    .maybeSingle();

  if (conflito && conflito.organization_id !== authz.org.orgId) {
    return fail("conflict", "Esta conta comercial do TikTok já está conectada em outra organização.", 409, {
      requestId,
    });
  }

  // 3. Confere quota de canal da organização (exclui a própria sessão caso esteja reconectando/atualizando)
  const quota = await checkChannelQuota(admin, authz.org.orgId, "tiktok", {
    excludeChannelSessionId: conflito?.organization_id === authz.org.orgId ? conflito.id : undefined,
  });
  if (!quota.allowed) {
    return fail("quota_exceeded", quota.reason ?? "Limite de conexões do plano atingido.", 403, {
      requestId,
      details: { current: quota.current, max: quota.max },
    });
  }

  // 4. Cifra o token
  const tokenCifradoHex = await encryptWebhookSecret(admin, token);
  if (!tokenCifradoHex) {
    return fail("internal_error", "Erro ao cifrar credencial do canal.", 500, { requestId });
  }
  const tokenCifradoBytea = `\\x${tokenCifradoHex}`;

  // 5. Cifra o secret de webhook para validação HMAC da TikTok Signature
  const effectiveSecret = webhook_secret || randomBytes(32).toString("hex");
  const secretHex = await encryptWebhookSecret(admin, effectiveSecret);
  const webhookSecretBytea = secretHex ? `\\x${secretHex}` : null;

  const pathToken = randomUUID();

  // 6. Upsert da sessão de TikTok
  if (conflito && conflito.organization_id === authz.org.orgId) {
    const { error: errUp } = await admin
      .from("channel_sessions")
      .update({
        tiktok_username: info.username ?? null,
        tiktok_token_encrypted: tokenCifradoBytea,
        webhook_secret_encrypted: webhookSecretBytea,
        display_name: display_name ?? info.display_name ?? info.username ?? "TikTok Business",
        status: "connected",
        updated_at: new Date().toISOString(),
      })
      .eq("id", conflito.id);

    if (errUp) {
      return fail("internal_error", "Falha ao atualizar sessão do TikTok.", 500, { requestId });
    }
    invalidateWebhookCacheBySessionId(conflito.id);
  } else {
    const { error: errIns } = await admin
      .from("channel_sessions")
      .insert({
        organization_id: authz.org.orgId,
        provider: "tiktok",
        tiktok_business_id: info.business_id,
        tiktok_username: info.username ?? null,
        tiktok_token_encrypted: tokenCifradoBytea,
        webhook_secret_encrypted: webhookSecretBytea,
        display_name: display_name ?? info.display_name ?? info.username ?? "TikTok Business",
        webhook_path_token: pathToken,
        status: "connected",
      });

    if (errIns) {
      return fail("internal_error", `Falha ao gravar sessão do TikTok: ${errIns.message}`, 500, {
        requestId,
      });
    }
  }

  const { data: sessaoAtual } = await admin
    .from("channel_sessions")
    .select("id")
    .eq("organization_id", authz.org.orgId)
    .eq("tiktok_business_id", info.business_id)
    .is("archived_at", null)
    .single();

  if (sessaoAtual) {
    await audit({
      organizationId: authz.org.orgId,
      actorUserId: authz.user.id,
      action: "channel.connected",
      resourceType: "channel_session",
      resourceId: sessaoAtual.id,
      metadata: {
        provider: "tiktok",
        tiktok_business_id: info.business_id,
        tiktok_username: info.username,
        requestId,
      },
    });
  }

  const webhookUrl = `${basePublicaDaInstalacao(req)}/api/v1/webhooks/channel/${pathToken}`;

  return ok(
    {
      connected: true,
      provider: "tiktok",
      business_id: info.business_id,
      username: info.username,
      display_name: info.display_name,
      webhook_url: webhookUrl,
      webhook_secret: effectiveSecret,
    },
    { requestId },
  );
}

export async function DELETE(req: NextRequest): Promise<NextResponse> {
  const supportDenied = await requireSupportWrite();
  if (supportDenied) return supportDenied;

  const requestId = randomUUID();
  const authz = await requireRole("admin", { requestId, resource: "channels_tiktok" });
  if (!authz.ok) return authz.response;

  const admin = createAdminClient();
  const { data: sessao } = await admin
    .from("channel_sessions")
    .select("id, tiktok_business_id")
    .eq("organization_id", authz.org.orgId)
    .eq("provider", "tiktok")
    .is("archived_at", null)
    .maybeSingle();

  if (!sessao) {
    return fail("not_found", "Nenhuma conexão ativa do TikTok encontrada.", 404, { requestId });
  }

  await admin
    .from("channel_sessions")
    .update({
      archived_at: new Date().toISOString(),
      status: "archived",
      updated_at: new Date().toISOString(),
    })
    .eq("id", sessao.id);

  invalidateWebhookCacheBySessionId(sessao.id);

  await audit({
    organizationId: authz.org.orgId,
    actorUserId: authz.user.id,
    action: "channel.archived",
    resourceType: "channel_session",
    resourceId: sessao.id,
    metadata: {
      provider: "tiktok",
      channel_session_id: sessao.id,
      requestId,
    },
  });

  return ok({ disconnected: true }, { requestId });
}
