import type { SupabaseClient } from "@supabase/supabase-js";
import { randomBytes } from "node:crypto";
import { z } from "zod";
import { encryptWebhookSecret, decryptWebhookSecret } from "@/lib/webhooks/secrets";
import { metadataInicialDoCanal } from "@/lib/ai/elegibilidade/pre-go-live";
import { inboxSupported, SOCIAL_PROVIDER } from "./catalog";
import { listSocialAccounts, socialRequest, SocialError } from "./client";
import { checkChannelQuota } from "@/lib/tenant/plan-limits";

export async function readSocialIntegration(db: SupabaseClient, org: string) {
  const { data, error } = await db
    .from("channel_integrations")
    .select("profile_id, credential_encrypted")
    .eq("organization_id", org)
    .maybeSingle();
  if (error) throw new SocialError("Não foi possível ler a integração.", 500);
  if (!data) return null;
  const key = await decryptWebhookSecret(db, data.credential_encrypted as string);
  if (!key)
    throw new SocialError(
      "A credencial não pôde ser aberta. Configure a integração novamente.",
      422,
    );
  return { profileId: data.profile_id as string, key };
}
export async function configureSocialIntegration(
  db: SupabaseClient,
  org: string,
  key: string,
  profileId: string,
) {
  const profiles = z
    .object({ profiles: z.array(z.object({ _id: z.string() })) })
    .parse(await socialRequest(key, "profiles"));
  if (!profiles.profiles.some((p) => p._id === profileId))
    throw new SocialError("Perfil não encontrado para esta chave.", 422);
  const { data: existing, error: readError } = await db
    .from("channel_integrations")
    .select("profile_id")
    .eq("organization_id", org)
    .maybeSingle();
  if (readError) throw new SocialError("Não foi possível ler a configuração atual.", 500);
  if (existing && existing.profile_id !== profileId)
    throw new SocialError(
      "Este CRM já está vinculado a outro perfil. Preserve as conexões existentes.",
      409,
    );
  const encrypted = await encryptWebhookSecret(db, key);
  if (!encrypted) throw new SocialError("Cifra indisponível; a chave não foi gravada.", 422);
  const { error } = await db.from("channel_integrations").upsert({
    organization_id: org,
    profile_id: profileId,
    credential_encrypted: encrypted,
    updated_at: new Date().toISOString(),
  });
  if (error) throw new SocialError("Não foi possível salvar a integração.", 500);
  const { error: channelError } = await db
    .from("channel_sessions")
    .update({ zernio_token_encrypted: encrypted })
    .eq("organization_id", org)
    .eq("provider", SOCIAL_PROVIDER);
  if (channelError)
    throw new SocialError(
      "Credencial salva; não foi possível atualizar os canais. Salve novamente.",
      500,
    );
}
export async function socialChannels(db: SupabaseClient, org: string) {
  const { data, error } = await db
    .from("channel_sessions")
    .select("id, zernio_account_id, display_name, status, metadata, updated_at")
    .eq("organization_id", org)
    .eq("provider", SOCIAL_PROVIDER)
    .is("archived_at", null);
  if (error) throw new SocialError("Não foi possível ler os canais sociais.", 500);
  return (data ?? []).map((row) => ({
    id: row.id as string,
    updated_at: row.updated_at as string,
    accountId: row.zernio_account_id as string,
    display_name: row.display_name as string | null,
    status: row.status as string,
    metadata: row.metadata as Record<string, unknown>,
  }));
}

/** Rewrites only the existing Zernio webhook callback to this installation's current origin. */
export async function resyncSocialWebhook(
  db: SupabaseClient,
  org: string,
  accountId: string,
  publicBase: string,
): Promise<{ channel_id: string; resynced: boolean }> {
  const integration = await readSocialIntegration(db, org);
  if (!integration) throw new SocialError("Configure a integração primeiro.", 422);

  const { data: channel, error: channelError } = await db
    .from("channel_sessions")
    .select("id, provider, zernio_account_id, status, metadata, webhook_path_token, archived_at")
    .eq("organization_id", org)
    .eq("provider", SOCIAL_PROVIDER)
    .eq("zernio_account_id", accountId)
    .is("archived_at", null)
    .maybeSingle();
  if (channelError)
    throw new SocialError("Não foi possível ler o canal para ressincronizar o webhook.", 500);
  if (!channel) throw new SocialError("Nenhum canal social para ressincronizar.", 404);
  if (channel.status !== "WORKING")
    throw new SocialError("O canal precisa estar ativo para ressincronizar o webhook.", 409);

  const metadata =
    channel.metadata && typeof channel.metadata === "object" && !Array.isArray(channel.metadata)
      ? (channel.metadata as Record<string, unknown>)
      : {};
  const webhookId = metadata.social_webhook_id;
  const platform = metadata.social_platform;
  if (typeof webhookId !== "string" || !webhookId || typeof platform !== "string")
    throw new SocialError("Não foi possível recuperar a assinatura da conexão.", 422);
  if (!inboxSupported(platform))
    throw new SocialError("O atendimento desta rede não está disponível no CRM.", 422);

  const token = channel.webhook_path_token;
  if (typeof token !== "string" || !/^[a-f0-9]{48}$/.test(token))
    throw new SocialError("Não foi possível recuperar a assinatura da conexão.", 422);

  let base: URL;
  try {
    base = new URL(publicBase);
  } catch {
    throw new SocialError("Configure o endereço público da instalação.", 422);
  }
  if (
    base.protocol !== "https:" ||
    base.hostname === "placeholder.invalid" ||
    base.username ||
    base.password ||
    base.pathname !== "/" ||
    base.search ||
    base.hash
  )
    throw new SocialError("Configure o endereço público da instalação.", 422);

  const callbackPath = `/api/v1/webhooks/channel/${token}`;
  const callbackUrl = `${base.origin}${callbackPath}`;
  const list = z
    .object({
      webhooks: z.array(z.object({ _id: z.string(), url: z.string(), isActive: z.boolean() })),
    })
    .parse(await socialRequest(integration.key, "webhooks/settings"));
  const pathMatches = (url: string) => {
    try {
      const parsed = new URL(url);
      return (
        parsed.pathname === callbackPath &&
        !parsed.search &&
        !parsed.hash &&
        !parsed.username &&
        !parsed.password
      );
    } catch {
      return false;
    }
  };
  const matchingPath = list.webhooks.filter((webhook) => pathMatches(webhook.url));
  const webhook = matchingPath.find((candidate) => candidate._id === webhookId);
  if (matchingPath.length !== 1 || !webhook)
    throw new SocialError("Não há uma assinatura única deste canal para ressincronizar.", 422);

  if (webhook.url === callbackUrl) {
    if (!webhook.isActive)
      throw new SocialError(
        "O webhook foi desativado pelo provedor. Verifique o motivo antes de tentar novamente.",
        409,
      );
    return { channel_id: channel.id as string, resynced: false };
  }

  await socialRequest(
    integration.key,
    "webhooks/settings",
    { webhookId: webhook._id, url: callbackUrl, isActive: true },
    "PUT",
  );
  const confirmed = z
    .object({
      webhooks: z.array(z.object({ _id: z.string(), url: z.string(), isActive: z.boolean() })),
    })
    .parse(await socialRequest(integration.key, "webhooks/settings"))
    .webhooks.find((candidate) => candidate._id === webhook._id);
  if (!confirmed || confirmed.url !== callbackUrl || !confirmed.isActive)
    throw new SocialError("O provedor não confirmou o novo endereço do webhook.", 502);

  return { channel_id: channel.id as string, resynced: true };
}

export async function connectSocialInbox(
  db: SupabaseClient,
  org: string,
  accountId: string,
  publicBase: string,
) {
  const integration = await readSocialIntegration(db, org);
  if (!integration) throw new SocialError("Configure a integração primeiro.", 422);
  const accounts = await listSocialAccounts(integration.key, integration.profileId);
  const account = accounts.find((a) => a._id === accountId);
  if (!account || !account.isActive)
    throw new SocialError("Conta ausente ou desconectada neste perfil.", 422);
  if (!inboxSupported(account.platform))
    throw new SocialError("O atendimento desta rede ainda não está disponível no CRM.", 422);
  const existing = (await socialChannels(db, org)).find((c) => c.accountId === accountId);
  if (existing?.metadata.social_webhook_id && existing.status === "WORKING")
    return { channel_id: existing.id, already_connected: true };

  let quota;
  try {
    quota = await checkChannelQuota(db, org, account.platform, {
      excludeChannelSessionId: existing?.id,
    });
  } catch {
    quota = {
      allowed: false,
      reason: "Falha ao validar permissões do plano para o canal.",
    };
  }
  if (!quota || !quota.allowed) {
    throw new SocialError(
      quota?.reason ?? `O canal social '${account.platform}' não está disponível no plano contratado.`,
      403,
    );
  }

  let token = randomBytes(24).toString("hex");
  let secret = randomBytes(32).toString("hex");
  if (existing) {
    // A compare-and-swap lease prevents concurrent retries from creating two subscriptions.
    if (existing.status === "STARTING" && Date.now() - Date.parse(existing.updated_at) < 90_000)
      throw new SocialError(
        "A conexão ainda está sendo configurada. Aguarde e atualize a lista.",
        409,
      );
    const { data: lease, error: leaseError } = await db
      .from("channel_sessions")
      .update({ status: "STARTING", updated_at: new Date().toISOString() })
      .eq("organization_id", org)
      .eq("id", existing.id)
      .eq("updated_at", existing.updated_at)
      .select("id")
      .maybeSingle();
    if (leaseError || !lease)
      throw new SocialError(
        "Outra configuração está em andamento. Aguarde e atualize a lista.",
        409,
      );
    const { data, error } = await db
      .from("channel_sessions")
      .select("webhook_path_token, webhook_secret_encrypted")
      .eq("organization_id", org)
      .eq("id", existing.id)
      .single();
    if (error || !data)
      throw new SocialError("Não foi possível recuperar a conexão pendente.", 500);
    const savedSecret = await decryptWebhookSecret(db, data.webhook_secret_encrypted as string);
    if (!savedSecret || !data.webhook_path_token)
      throw new SocialError("Não foi possível recuperar a assinatura da conexão.", 422);
    token = data.webhook_path_token as string;
    secret = savedSecret;
  }
  const keyEnc = await encryptWebhookSecret(db, integration.key);
  const secretEnc = await encryptWebhookSecret(db, secret);
  if (!keyEnc || !secretEnc) throw new SocialError("Cifra indisponível.", 422);
  const metadata = {
    ...(existing?.metadata ?? metadataInicialDoCanal()),
    social_platform: account.platform,
  };
  let channelId = existing?.id;
  if (!channelId) {
    const { data, error } = await db
      .from("channel_sessions")
      .insert({
        organization_id: org,
        provider: SOCIAL_PROVIDER,
        zernio_account_id: accountId,
        zernio_token_encrypted: keyEnc,
        webhook_secret_encrypted: secretEnc,
        webhook_path_token: token,
        display_name: `${account.platform} · ${account.username ?? account.displayName ?? accountId}`,
        status: "STARTING",
        metadata,
      })
      .select("id")
      .single();
    if (error || !data)
      throw new SocialError(
        "Não foi possível criar o canal. Atualize a lista antes de tentar novamente.",
        409,
      );
    channelId = data.id as string;
  }
  const webhookUrl = `${publicBase}/api/v1/webhooks/channel/${token}`;
  try {
    // Reconcile after a timeout: creating a second subscription duplicates every event.
    const list = z
      .object({
        webhooks: z.array(z.object({ _id: z.string(), url: z.string(), isActive: z.boolean() })),
      })
      .parse(await socialRequest(integration.key, "webhooks/settings"));
    const found = list.webhooks.find((w) => w.url === webhookUrl);
    if (found && !found.isActive)
      throw new SocialError(
        "O webhook foi desativado pelo provedor. Reative-o após corrigir a falha.",
        409,
      );
    const webhookId =
      found?._id ??
      z.object({ webhook: z.object({ _id: z.string() }) }).parse(
        await socialRequest(integration.key, "webhooks/settings", {
          name: `CRM ${account.platform} ${accountId.slice(-8)}`,
          url: webhookUrl,
          secret,
          events: [
            "message.received",
            "message.sent",
            "message.delivered",
            "message.read",
            "message.failed",
          ],
          isActive: true,
        }),
      ).webhook._id;
    const { error: updateError } = await db
      .from("channel_sessions")
      .update({ status: "WORKING", metadata: { ...metadata, social_webhook_id: webhookId } })
      .eq("organization_id", org)
      .eq("id", channelId);
    if (updateError)
      throw new SocialError("Webhook criado; não foi possível confirmar o estado no CRM.", 500);
    return { channel_id: channelId, already_connected: !!existing };
  } catch (error) {
    await db
      .from("channel_sessions")
      .update({ status: "FAILED" })
      .eq("organization_id", org)
      .eq("id", channelId);
    throw error;
  }
}
