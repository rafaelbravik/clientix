import { randomUUID } from "node:crypto";
import { type NextRequest, NextResponse } from "next/server";
import { z } from "zod";

import { fail, ok } from "@/lib/api/wrappers";
import { audit } from "@/lib/audit";
import { requireRole } from "@/lib/auth/require-role";
import { requireSupportWrite } from "@/lib/impersonate/support";
import { createAdminClient } from "@/lib/supabase/admin";
import { encryptWebhookSecret } from "@/lib/webhooks/secrets";
import { basePublicaDaInstalacao } from "@/lib/webhooks/url-publica";
import { instagramGetAccount } from "@/lib/channels/instagram/client";
import { checkChannelQuota } from "@/lib/tenant/plan-limits";
import { invalidateWebhookCacheBySessionId } from "@/lib/channels/webhook-session-cache";
import { appDaMeta } from "@/lib/channels/meta/app";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const connectInstagramSchema = z.object({
  account_id: z.string().trim().min(3).max(100),
  token: z.string().trim().min(20),
  app_secret: z.string().trim().min(16).optional(),
  display_name: z.string().trim().min(1).max(100).optional(),
});

export async function GET(req: NextRequest): Promise<NextResponse> {
  const requestId = randomUUID();
  const authz = await requireRole("admin", { requestId, resource: "channels_instagram" });
  if (!authz.ok) return authz.response;

  const admin = createAdminClient();
  const { data: sessao } = await admin
    .from("channel_sessions")
    .select(
      "id, instagram_account_id, instagram_username, display_name, status, webhook_path_token, archived_at",
    )
    .eq("organization_id", authz.org.orgId)
    .eq("provider", "instagram")
    .is("archived_at", null)
    .maybeSingle();

  if (!sessao) {
    return ok(
      {
        connected: false,
        provider: "instagram",
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
      provider: "instagram",
      channel_session_id: sessao.id,
      account_id: sessao.instagram_account_id,
      username: sessao.instagram_username,
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
  const authz = await requireRole("admin", { requestId, resource: "channels_instagram" });
  if (!authz.ok) return authz.response;

  const json = await req.json().catch(() => ({}));
  const parsed = connectInstagramSchema.safeParse(json);
  if (!parsed.success) {
    return fail("validation_failed", "Dados da conta Instagram inválidos.", 422, {
      requestId,
      details: parsed.error.flatten(),
    });
  }

  const { account_id, token, app_secret, display_name } = parsed.data;
  const metaApp = await appDaMeta();
  const effectiveAppSecret = app_secret || metaApp.appSecret;
  if (!effectiveAppSecret || effectiveAppSecret.trim().length < 16) {
    return fail(
      "validation_failed",
      "Informe um App Secret válido para habilitar a verificação dos webhooks do Instagram.",
      422,
      { requestId },
    );
  }
  if (!metaApp.verifyToken) {
    return fail(
      "integration_unavailable",
      "Configure o verify token Meta em Admin › API Oficial antes de conectar o Instagram; sem ele o webhook não conclui o handshake.",
      422,
      { requestId },
    );
  }

  // 1. Valida conta e token com a Meta Graph API
  let account;
  try {
    account = await instagramGetAccount(token, account_id);
  } catch (err) {
    const msg = err instanceof Error ? err.message : "token_ou_conta_invalida";
    return fail("unauthorized", `Falha ao validar conta com o Instagram: ${msg}`, 400, {
      requestId,
    });
  }

  const admin = createAdminClient();

  // 2. Confere se a conta já está conectada
  const { data: conflito } = await admin
    .from("channel_sessions")
    .select("id, organization_id")
    .eq("instagram_account_id", account.id)
    .eq("provider", "instagram")
    .is("archived_at", null)
    .maybeSingle();

  if (conflito && conflito.organization_id !== authz.org.orgId) {
    return fail(
      "conflict",
      "Esta conta do Instagram já está conectada em outra organização.",
      409,
      {
        requestId,
      },
    );
  }

  // 3. Confere quota de canal da organização (exclui a própria sessão caso esteja reconectando/atualizando)
  const quota = await checkChannelQuota(admin, authz.org.orgId, "instagram", {
    excludeChannelSessionId:
      conflito?.organization_id === authz.org.orgId ? conflito.id : undefined,
  });
  if (!quota.allowed) {
    return fail("quota_exceeded", quota.reason ?? "Limite de conexões do plano atingido.", 403, {
      requestId,
      details: { current: quota.current, max: quota.max },
    });
  }

  // 4. Cifra o token de acesso
  const tokenCifradoHex = await encryptWebhookSecret(admin, token);
  if (!tokenCifradoHex) {
    return fail("internal_error", "Erro ao cifrar credencial do canal.", 500, { requestId });
  }
  const tokenCifradoBytea = `\\x${tokenCifradoHex}`;

  // 5. Cifra o secret de webhook para validação HMAC de inbound
  const secretHex = await encryptWebhookSecret(admin, effectiveAppSecret);
  if (!secretHex) {
    return fail("internal_error", "Erro ao cifrar o segredo do webhook do Instagram.", 500, {
      requestId,
    });
  }
  const webhookSecretBytea = `\\x${secretHex}`;

  const pathToken = randomUUID();

  // 6. Upsert da sessão de Instagram
  if (conflito && conflito.organization_id === authz.org.orgId) {
    const { error: errUp } = await admin
      .from("channel_sessions")
      .update({
        instagram_username: account.username ?? null,
        instagram_token_encrypted: tokenCifradoBytea,
        webhook_secret_encrypted: webhookSecretBytea,
        display_name: display_name ?? account.name ?? account.username ?? "Instagram Direct",
        status: "connected",
        updated_at: new Date().toISOString(),
      })
      .eq("id", conflito.id);

    if (errUp) {
      return fail("internal_error", "Falha ao atualizar sessão do Instagram.", 500, { requestId });
    }
    invalidateWebhookCacheBySessionId(conflito.id);
  } else {
    const { error: errIns } = await admin.from("channel_sessions").insert({
      organization_id: authz.org.orgId,
      provider: "instagram",
      instagram_account_id: account.id,
      instagram_username: account.username ?? null,
      instagram_token_encrypted: tokenCifradoBytea,
      webhook_secret_encrypted: webhookSecretBytea,
      display_name: display_name ?? account.name ?? account.username ?? "Instagram Direct",
      webhook_path_token: pathToken,
      status: "connected",
    });

    if (errIns) {
      return fail("internal_error", `Falha ao gravar sessão do Instagram: ${errIns.message}`, 500, {
        requestId,
      });
    }
  }

  const { data: sessaoAtual } = await admin
    .from("channel_sessions")
    .select("id")
    .eq("organization_id", authz.org.orgId)
    .eq("instagram_account_id", account.id)
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
        provider: "instagram",
        instagram_account_id: account.id,
        instagram_username: account.username,
        requestId,
      },
    });
  }

  return ok(
    {
      connected: true,
      provider: "instagram",
      account_id: account.id,
      username: account.username,
      name: account.name,
    },
    { requestId },
  );
}

export async function DELETE(req: NextRequest): Promise<NextResponse> {
  const supportDenied = await requireSupportWrite();
  if (supportDenied) return supportDenied;

  const requestId = randomUUID();
  const authz = await requireRole("admin", { requestId, resource: "channels_instagram" });
  if (!authz.ok) return authz.response;

  const admin = createAdminClient();
  const { data: sessao } = await admin
    .from("channel_sessions")
    .select("id, instagram_account_id")
    .eq("organization_id", authz.org.orgId)
    .eq("provider", "instagram")
    .is("archived_at", null)
    .maybeSingle();

  if (!sessao) {
    return fail("not_found", "Nenhuma conexão ativa do Instagram encontrada.", 404, { requestId });
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
      provider: "instagram",
      channel_session_id: sessao.id,
      requestId,
    },
  });

  return ok({ disconnected: true }, { requestId });
}
