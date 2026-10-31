"use server";

import { randomUUID } from "node:crypto";
import { cookies, headers } from "next/headers";
import { z } from "zod";

import { audit } from "@/lib/audit";
import { decryptKey, encryptKey } from "@/lib/crypto/aes_gcm";
import {
  CHATGPT_DYNAMIC_CLIENT_ID,
  CHATGPT_PENDING_COOKIE,
  CHATGPT_STATE_TTL_MS,
  CHATGPT_SUBSCRIPTION_HOST_KEY,
  CHATGPT_SUBSCRIPTION_MODULE,
  CHATGPT_SUBSCRIPTION_PROVIDER,
  assinarStateSiwc,
  challengeS256,
  gerarNonceSiwc,
  gerarVerifierPkce,
  lerCallbackSiwc,
  montarUrlAutorizacaoSiwc,
  trocarCodigoSiwc,
  verificarIdTokenSiwc,
  verificarStateSiwc,
} from "@/lib/ai/credenciais/chatgpt-siwc";
import {
  apagarCredencialSiwc,
  lerEstadoDaConexaoSiwc,
  lerTokensSiwc,
  revogarSessaoSiwc,
  salvarCredencialSiwc,
  type ChatGPTSubscriptionEnvelope,
} from "@/lib/ai/credenciais/chatgpt-subscription";
import { supportWriteError } from "@/lib/impersonate/support";
import { loadAuthUser, mfaEmDivida, resolveActiveOrg } from "@/lib/auth/server";
import { ROLE_RANK } from "@/lib/auth/types";
import { env } from "@/lib/env";
import { moduloLigado } from "@/lib/instalacao/modulos";
import { createAdminClient } from "@/lib/supabase/admin";

const entradaCallback = z.object({ callbackUrl: z.string().trim().min(1).max(4096) });
const UUID_PADRAO_HOST = /^urn:uuid:[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

interface PendingSiwc {
  state: string;
  verifier: string;
  nonce: string;
  organizationId: string;
  userId: string;
  expectedClientId: string;
  expectedSubject?: string;
  hostId: string;
  expiresAt: number;
}

type Authorized =
  | { ok: true; userId: string; organizationId: string; requestId: string }
  | { ok: false; error: string };

async function autorizarAdmin(): Promise<Authorized> {
  const authUser = await loadAuthUser();
  if (!authUser) return { ok: false, error: "permission_denied" };
  if (supportWriteError(authUser.support)) return { ok: false, error: "permission_denied" };
  const activeOrg = await resolveActiveOrg(authUser);
  if (!activeOrg || ROLE_RANK[activeOrg.role] < ROLE_RANK.admin) {
    return { ok: false, error: "permission_denied" };
  }
  if (await mfaEmDivida()) return { ok: false, error: "mfa_required" };
  const requestId = (await headers()).get("x-request-id") ?? randomUUID();
  return { ok: true, userId: authUser.id, organizationId: activeOrg.orgId, requestId };
}

async function moduloAtivo(): Promise<boolean> {
  try {
    return await moduloLigado(createAdminClient(), CHATGPT_SUBSCRIPTION_MODULE);
  } catch {
    return false;
  }
}

async function lerOuCriarHostId(userId: string): Promise<string | null> {
  const admin = createAdminClient();
  const { data, error } = await admin
    .from("platform_config")
    .select("valor")
    .eq("chave", CHATGPT_SUBSCRIPTION_HOST_KEY)
    .maybeSingle();
  if (error) return null;
  const existente = (data as { valor?: unknown } | null)?.valor;
  if (typeof existente === "string" && UUID_PADRAO_HOST.test(existente)) return existente;

  const novo = `urn:uuid:${randomUUID()}`;
  const { error: insertError } = await admin.from("platform_config").insert({
    chave: CHATGPT_SUBSCRIPTION_HOST_KEY,
    valor: novo,
    eh_segredo: false,
    semeado_do_env: false,
    updated_by: userId,
  });
  if (insertError && insertError.code !== "23505") return null;

  // Releitura após INSERT/colisão: chamadas concorrentes usam sempre o único
  // identificador que venceu no armazenamento da instalação.
  const { data: confirmado, error: erroDeLeitura } = await admin
    .from("platform_config")
    .select("valor")
    .eq("chave", CHATGPT_SUBSCRIPTION_HOST_KEY)
    .maybeSingle();
  const valor = (confirmado as { valor?: unknown } | null)?.valor;
  return !erroDeLeitura && typeof valor === "string" && UUID_PADRAO_HOST.test(valor) ? valor : null;
}

function codificarPendencia(pending: PendingSiwc): string {
  const cipher = encryptKey(JSON.stringify(pending));
  return [cipher.ciphertext, cipher.iv, cipher.tag].map((value) => value.toString("base64url")).join(".");
}

function decodificarPendencia(value: string): PendingSiwc | null {
  const parts = value.split(".");
  if (parts.length !== 3) return null;
  const [ciphertext, iv, tag] = parts;
  if (!ciphertext || !iv || !tag) return null;
  try {
    const parsed: unknown = JSON.parse(
      decryptKey({
        ciphertext: Buffer.from(ciphertext, "base64url"),
        iv: Buffer.from(iv, "base64url"),
        tag: Buffer.from(tag, "base64url"),
      }),
    );
    if (!parsed || typeof parsed !== "object") return null;
    const state = parsed as Partial<PendingSiwc>;
    if (
      typeof state.state !== "string" ||
      typeof state.verifier !== "string" ||
      typeof state.nonce !== "string" ||
      typeof state.organizationId !== "string" ||
      typeof state.userId !== "string" ||
      typeof state.expectedClientId !== "string" ||
      typeof state.hostId !== "string" ||
      typeof state.expiresAt !== "number"
    ) return null;
    return state as PendingSiwc;
  } catch {
    return null;
  }
}

async function featureLigadaOuErro(): Promise<{ ok: true } | { ok: false; error: "feature_disabled" }> {
  return (await moduloAtivo()) ? { ok: true } : { ok: false, error: "feature_disabled" };
}

export type StartChatGPTSubscriptionResult =
  | { ok: true; authorizationUrl: string }
  | { ok: false; error: string };

export async function startChatGPTSubscriptionLogin(): Promise<StartChatGPTSubscriptionResult> {
  const acesso = await autorizarAdmin();
  if (!acesso.ok) return acesso;
  const feature = await featureLigadaOuErro();
  if (!feature.ok) return feature;

  const admin = createAdminClient();
  let hostId: string | null;
  try {
    hostId = await lerOuCriarHostId(acesso.userId);
  } catch {
    return { ok: false, error: "configuration_unavailable" };
  }
  if (!hostId) return { ok: false, error: "configuration_unavailable" };

  let existing: Awaited<ReturnType<typeof lerTokensSiwc>>;
  try {
    existing = await lerTokensSiwc(admin, acesso.organizationId);
  } catch {
    return { ok: false, error: "credential_unreadable" };
  }

  const verifier = gerarVerifierPkce();
  const nonce = gerarNonceSiwc();
  const expectedClientId = existing?.envelope.client_id ?? CHATGPT_DYNAMIC_CLIENT_ID;
  const now = Date.now();
  let state: string;
  try {
    state = assinarStateSiwc(
      {
        organizationId: acesso.organizationId,
        userId: acesso.userId,
        clientId: expectedClientId,
        nonce,
      },
      env.INTERNAL_SECRET,
      now,
    );
  } catch {
    return { ok: false, error: "configuration_unavailable" };
  }

  const authorizationUrl = montarUrlAutorizacaoSiwc({
    state,
    nonce,
    codeChallenge: challengeS256(verifier),
    clientId: expectedClientId,
    hostId,
  });
  const pending: PendingSiwc = {
    state,
    verifier,
    nonce,
    organizationId: acesso.organizationId,
    userId: acesso.userId,
    expectedClientId,
    ...(existing ? { expectedSubject: existing.envelope.subject } : {}),
    hostId,
    expiresAt: now + CHATGPT_STATE_TTL_MS,
  };
  try {
    (await cookies()).set(CHATGPT_PENDING_COOKIE, codificarPendencia(pending), {
      httpOnly: true,
      secure: process.env.NODE_ENV === "production",
      sameSite: "strict",
      path: "/app/ai/credentials",
      maxAge: Math.floor(CHATGPT_STATE_TTL_MS / 1000),
    });
  } catch {
    return { ok: false, error: "configuration_unavailable" };
  }
  return { ok: true, authorizationUrl };
}

export type CompleteChatGPTSubscriptionResult =
  | { ok: true; reconnected: boolean }
  | { ok: false; error: string };

export async function completeChatGPTSubscriptionLogin(
  input: z.input<typeof entradaCallback>,
): Promise<CompleteChatGPTSubscriptionResult> {
  const acesso = await autorizarAdmin();
  if (!acesso.ok) return acesso;
  const feature = await featureLigadaOuErro();
  if (!feature.ok) return feature;
  const parsedInput = entradaCallback.safeParse(input);
  if (!parsedInput.success) return { ok: false, error: "invalid_callback" };
  const callback = lerCallbackSiwc(parsedInput.data.callbackUrl);
  if (!callback) return { ok: false, error: "invalid_callback" };

  const jar = await cookies();
  const cookie = jar.get(CHATGPT_PENDING_COOKIE)?.value;
  const pending = cookie ? decodificarPendencia(cookie) : null;
  if (!pending || pending.state !== callback.state) return { ok: false, error: "invalid_state" };

  let verificacao: ReturnType<typeof verificarStateSiwc>;
  try {
    verificacao = verificarStateSiwc(callback.state, env.INTERNAL_SECRET);
  } catch {
    return { ok: false, error: "invalid_state" };
  }
  if (!verificacao.ok) return { ok: false, error: verificacao.reason };
  const signed = verificacao.state;
  if (
    pending.expiresAt <= Date.now() ||
    pending.expiresAt !== signed.expiresAt ||
    pending.organizationId !== acesso.organizationId ||
    pending.userId !== acesso.userId ||
    signed.organizationId !== acesso.organizationId ||
    signed.userId !== acesso.userId ||
    pending.expectedClientId !== signed.clientId ||
    pending.nonce !== signed.nonce
  ) {
    return { ok: false, error: "invalid_state" };
  }

  const admin = createAdminClient();
  let nonceError: { code?: string } | null;
  try {
    const resultado = await admin.from("calendar_oauth_nonces").insert({
      nonce: pending.nonce,
      organization_id: pending.organizationId,
      user_id: pending.userId,
      expira_em: new Date(signed.expiresAt).toISOString(),
    });
    nonceError = resultado.error;
  } catch {
    return { ok: false, error: "storage_failed" };
  }
  if (nonceError?.code === "23505") return { ok: false, error: "replayed_nonce" };
  if (nonceError) return { ok: false, error: "storage_failed" };
  jar.delete(CHATGPT_PENDING_COOKIE);

  if (callback.error) return { ok: false, error: "token_exchange_failed" };
  if (!callback.code) return { ok: false, error: "invalid_callback" };

  let clientId: string;
  if (pending.expectedClientId === CHATGPT_DYNAMIC_CLIENT_ID) {
    clientId = callback.clientId ?? "";
    if (!clientId || clientId === CHATGPT_DYNAMIC_CLIENT_ID || !/^[A-Za-z0-9._:-]{1,256}$/.test(clientId)) {
      return { ok: false, error: "invalid_callback" };
    }
  } else {
    if (callback.clientId && callback.clientId !== pending.expectedClientId) {
      return { ok: false, error: "invalid_callback" };
    }
    clientId = pending.expectedClientId;
  }

  let grant;
  try {
    grant = await trocarCodigoSiwc({ code: callback.code, verifier: pending.verifier, clientId });
  } catch {
    return { ok: false, error: "token_exchange_failed" };
  }
  let identity;
  try {
    if (typeof grant.idToken !== "string") return { ok: false, error: "invalid_id_token" };
    identity = await verificarIdTokenSiwc({ idToken: grant.idToken, clientId, nonce: pending.nonce });
  } catch {
    return { ok: false, error: "invalid_id_token" };
  }
  if (pending.expectedSubject && identity.subject !== pending.expectedSubject) {
    return { ok: false, error: "identity_mismatch" };
  }

  const envelope: ChatGPTSubscriptionEnvelope = {
    access_token: grant.accessToken,
    refresh_token: grant.refreshToken,
    client_id: clientId,
    subject: identity.subject,
    ...(identity.email ? { email: identity.email } : {}),
    scopes: grant.scopes,
    expires_at: grant.expiresAt,
    token_type: grant.tokenType,
    ext_agent_host_id: pending.hostId,
    issuer: "https://auth.openai.com",
  };
  let salvo: Awaited<ReturnType<typeof salvarCredencialSiwc>>;
  try {
    salvo = await salvarCredencialSiwc({
      admin,
      organizationId: acesso.organizationId,
      userId: acesso.userId,
      envelope,
      ...(pending.expectedSubject ? { expectedSubject: pending.expectedSubject } : {}),
    });
  } catch {
    return { ok: false, error: "storage_failed" };
  }
  if (!salvo.ok) return salvo;

  await audit({
    action: salvo.reconnected ? "ai.subscription.reconnected" : "ai.subscription.connected",
    actorUserId: acesso.userId,
    organizationId: acesso.organizationId,
    resourceType: "ai_provider_credential",
    resourceId: salvo.id,
    requestId: acesso.requestId,
    metadata: { provider: CHATGPT_SUBSCRIPTION_PROVIDER, status: "connected" },
  });
  return { ok: true, reconnected: salvo.reconnected };
}

export type DisconnectChatGPTSubscriptionResult =
  | { ok: true; remoteRevocation: "confirmed" | "not_confirmed" | "not_needed" }
  | { ok: false; error: string };

export async function disconnectChatGPTSubscription(): Promise<DisconnectChatGPTSubscriptionResult> {
  const acesso = await autorizarAdmin();
  if (!acesso.ok) return acesso;
  const feature = await featureLigadaOuErro();
  if (!feature.ok) return feature;

  const admin = createAdminClient();
  let existente: Awaited<ReturnType<typeof lerTokensSiwc>>;
  try {
    existente = await lerTokensSiwc(admin, acesso.organizationId);
  } catch {
    // Credencial cifrada ilegível ainda pode ser removida localmente; a
    // revogação remota fica sem confirmação porque não há refresh token seguro.
    existente = null;
  }
  let remoto = false;
  if (existente) {
    try {
      remoto = await revogarSessaoSiwc(existente.envelope);
    } catch {
      remoto = false;
    }
  }
  let apagado: Awaited<ReturnType<typeof apagarCredencialSiwc>>;
  try {
    apagado = await apagarCredencialSiwc(admin, acesso.organizationId);
  } catch {
    return { ok: false, error: "storage_failed" };
  }
  if (!apagado.ok) {
    return { ok: false, error: "storage_failed" };
  }

  if (existente || apagado.id) {
    const resourceId = existente?.row.id ?? apagado.id ?? null;
    await audit({
      action: "ai.subscription.disconnected",
      actorUserId: acesso.userId,
      organizationId: acesso.organizationId,
      resourceType: "ai_provider_credential",
      resourceId,
      requestId: acesso.requestId,
      metadata: {
        provider: CHATGPT_SUBSCRIPTION_PROVIDER,
        status: remoto ? "remote_revocation_confirmed" : "remote_revocation_not_confirmed",
      },
    });
  }
  return { ok: true, remoteRevocation: existente || apagado.id ? (remoto ? "confirmed" : "not_confirmed") : "not_needed" };
}

export async function getChatGPTSubscriptionStatus(): Promise<{
  enabled: boolean;
  status: "not_connected" | "connected" | "expired" | "unreadable";
}> {
  const enabled = await moduloAtivo();
  if (!enabled) return { enabled: false, status: "not_connected" };
  const user = await loadAuthUser();
  if (!user) return { enabled: false, status: "not_connected" };
  const org = await resolveActiveOrg(user);
  if (!org || ROLE_RANK[org.role] < ROLE_RANK.manager) {
    return { enabled: false, status: "not_connected" };
  }
  return {
    enabled: true,
    ...(await lerEstadoDaConexaoSiwc(createAdminClient(), org.orgId)),
  };
}
