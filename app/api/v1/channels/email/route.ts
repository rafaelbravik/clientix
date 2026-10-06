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
import { CHANNEL_PROVIDER_EMAIL } from "@/lib/channels/capabilities";
import { checkChannelQuota } from "@/lib/tenant/plan-limits";
import { invalidateWebhookCacheBySessionId, invalidateWebhookSessionCache } from "@/lib/channels/webhook-session-cache";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const connectEmailSchema = z.object({
  email_address: z.string().trim().email("Endereço de e-mail inválido.").toLowerCase(),
  display_name: z.string().trim().min(1).max(100).optional(),
  webhook_secret: z.string().trim().min(16).max(128).optional(),
});

export async function GET(req: NextRequest): Promise<NextResponse> {
  const requestId = randomUUID();
  const authz = await requireRole("admin", { requestId, resource: "channels_email" });
  if (!authz.ok) return authz.response;

  const admin = createAdminClient();
  const { data: sessao } = await admin
    .from("channel_sessions")
    .select("id, email_address, email_inbound_token, display_name, status, webhook_path_token, archived_at")
    .eq("organization_id", authz.org.orgId)
    .eq("provider", CHANNEL_PROVIDER_EMAIL)
    .is("archived_at", null)
    .maybeSingle();

  if (!sessao) {
    return ok(
      {
        connected: false,
        provider: CHANNEL_PROVIDER_EMAIL,
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
      provider: CHANNEL_PROVIDER_EMAIL,
      channel_session_id: sessao.id,
      email_address: sessao.email_address,
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
  const authz = await requireRole("admin", { requestId, resource: "channels_email" });
  if (!authz.ok) return authz.response;

  const json = await req.json().catch(() => ({}));
  const parsed = connectEmailSchema.safeParse(json);
  if (!parsed.success) {
    return fail("validation_failed", "Dados inválidos para canal de e-mail.", 422, {
      requestId,
      details: parsed.error.flatten(),
    });
  }

  const { email_address, display_name, webhook_secret } = parsed.data;
  const admin = createAdminClient();

  // Verifica se a organização já tem uma sessão ativa de e-mail (para não bloquear reconexão/reconfiguração)
  const { data: sessaoExistente } = await admin
    .from("channel_sessions")
    .select("id")
    .eq("organization_id", authz.org.orgId)
    .eq("provider", CHANNEL_PROVIDER_EMAIL)
    .is("archived_at", null)
    .maybeSingle();

  // Confere quota de canal da organização
  const quota = await checkChannelQuota(admin, authz.org.orgId, "email", {
    excludeChannelSessionId: sessaoExistente?.id,
  });
  if (!quota.allowed) {
    return fail("quota_exceeded", quota.reason ?? "Limite de conexões do plano atingido.", 403, {
      requestId,
      details: { current: quota.current, max: quota.max },
    });
  }

  // Verifica se este e-mail já está em uso ativo em outra organização
  const { data: conflito } = await admin
    .from("channel_sessions")
    .select("id, organization_id")
    .eq("provider", CHANNEL_PROVIDER_EMAIL)
    .eq("email_address", email_address)
    .is("archived_at", null)
    .maybeSingle();

  if (conflito && conflito.organization_id !== authz.org.orgId) {
    return fail("conflict", "Este endereço de e-mail já está conectado a outra organização.", 409, { requestId });
  }

  // Tokens para recebimento inbound
  const webhookPathToken = randomUUID().replace(/-/g, "");
  const emailInboundToken = randomUUID().replace(/-/g, "");

  let webhookSecretEncryptedHex: string | null = null;
  if (webhook_secret) {
    webhookSecretEncryptedHex = await encryptWebhookSecret(admin, webhook_secret);
    if (!webhookSecretEncryptedHex) {
      return fail("internal_error", "Falha ao cifrar segredo do webhook.", 500, { requestId });
    }
  }

  // Identifica e arquiva sessões antigas de e-mail desta org, se houver
  const { data: sessoesAntigas } = await admin
    .from("channel_sessions")
    .select("id, webhook_path_token")
    .eq("organization_id", authz.org.orgId)
    .eq("provider", CHANNEL_PROVIDER_EMAIL)
    .is("archived_at", null);

  await admin
    .from("channel_sessions")
    .update({ archived_at: new Date().toISOString() })
    .eq("organization_id", authz.org.orgId)
    .eq("provider", CHANNEL_PROVIDER_EMAIL)
    .is("archived_at", null);

  if (sessoesAntigas) {
    for (const antiga of sessoesAntigas) {
      invalidateWebhookCacheBySessionId(antiga.id);
      if (antiga.webhook_path_token) {
        invalidateWebhookSessionCache(antiga.webhook_path_token);
      }
    }
  }

  const { data: novaSessao, error: erroInsert } = await admin
    .from("channel_sessions")
    .insert({
      organization_id: authz.org.orgId,
      provider: CHANNEL_PROVIDER_EMAIL,
      display_name: display_name || email_address,
      email_address,
      email_inbound_token: emailInboundToken,
      webhook_path_token: webhookPathToken,
      webhook_secret_encrypted: webhookSecretEncryptedHex,
      status: "connected",
    })
    .select("id, email_address, display_name, status, webhook_path_token")
    .single();

  if (erroInsert || !novaSessao) {
    return fail("internal_error", `Falha ao salvar sessão de e-mail: ${erroInsert?.message ?? "erro"}`, 500, { requestId });
  }

  const webhookUrl = `${basePublicaDaInstalacao(req)}/api/v1/webhooks/channel/${novaSessao.webhook_path_token}`;

  await audit({
    organizationId: authz.org.orgId,
    actorUserId: authz.user.id,
    action: "channel.connected",
    resourceType: "channel_session",
    resourceId: novaSessao.id,
    metadata: {
      provider: CHANNEL_PROVIDER_EMAIL,
      email_address: novaSessao.email_address,
    },
  });

  return ok(
    {
      connected: true,
      provider: CHANNEL_PROVIDER_EMAIL,
      channel_session_id: novaSessao.id,
      email_address: novaSessao.email_address,
      display_name: novaSessao.display_name,
      status: novaSessao.status,
      webhook_url: webhookUrl,
    },
    { requestId },
  );
}

export async function DELETE(req: NextRequest): Promise<NextResponse> {
  const supportDenied = await requireSupportWrite();
  if (supportDenied) return supportDenied;

  const requestId = randomUUID();
  const authz = await requireRole("admin", { requestId, resource: "channels_email" });
  if (!authz.ok) return authz.response;

  const admin = createAdminClient();

  const { data: sessao } = await admin
    .from("channel_sessions")
    .select("id, email_address")
    .eq("organization_id", authz.org.orgId)
    .eq("provider", CHANNEL_PROVIDER_EMAIL)
    .is("archived_at", null)
    .maybeSingle();

  if (!sessao) {
    return fail("not_found", "Canal de e-mail não encontrado ou já desconectado.", 404, { requestId });
  }

  const { error: erroUpdate } = await admin
    .from("channel_sessions")
    .update({
      archived_at: new Date().toISOString(),
      status: "disconnected",
    })
    .eq("id", sessao.id);

  if (erroUpdate) {
    return fail("internal_error", `Falha ao desconectar canal de e-mail: ${erroUpdate.message}`, 500, { requestId });
  }

  invalidateWebhookCacheBySessionId(sessao.id);

  await audit({
    organizationId: authz.org.orgId,
    actorUserId: authz.user.id,
    action: "channel.archived",
    resourceType: "channel_session",
    resourceId: sessao.id,
    metadata: {
      provider: CHANNEL_PROVIDER_EMAIL,
      email_address: sessao.email_address,
    },
  });

  return ok(
    {
      connected: false,
      message: "Canal de e-mail desconectado com sucesso.",
    },
    { requestId },
  );
}
