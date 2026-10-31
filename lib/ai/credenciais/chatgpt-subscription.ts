import { logger } from "@/lib/logger";
import { moduloLigado } from "@/lib/instalacao/modulos";
import { byteaToBuffer, bufToBytea, decryptKey, encryptKey } from "@/lib/crypto/aes_gcm";
import { createAdminClient } from "@/lib/supabase/admin";
import {
  CHATGPT_OIDC_CONFIGURATION,
  CHATGPT_SUBSCRIPTION_LABEL,
  CHATGPT_SUBSCRIPTION_MODULE,
  CHATGPT_SUBSCRIPTION_PROVIDER,
  renovarGrantSiwc,
  validarEndpointDeRevogacao,
  type ErroChatGPTSubscription,
  type TokenGrant,
} from "@/lib/ai/credenciais/chatgpt-siwc";

type Admin = ReturnType<typeof createAdminClient>;

export const CHATGPT_REFRESH_LOCK_MS = 30_000;
export const CHATGPT_REFRESH_EARLY_MS = 60_000;
const MARKER_API_KEY_LAST4 = "SIWC";

export interface ChatGPTSubscriptionEnvelope {
  access_token: string;
  refresh_token: string;
  client_id: string;
  subject: string;
  email?: string;
  scopes: string[];
  expires_at: number;
  token_type: string;
  ext_agent_host_id: string;
  issuer: "https://auth.openai.com";
  refresh_lock_until?: number;
}

interface CredentialRow {
  id: string;
  organization_id: string;
  provider: string;
  label: string;
  api_key_encrypted: unknown;
  api_key_iv: unknown;
  api_key_tag: unknown;
  api_key_last4: string;
  validated_at: string | null;
  is_active: boolean;
  updated_at: string;
}

export type ResultadoDeSalvarSiwc =
  | { ok: true; id: string; reconnected: boolean }
  | { ok: false; error: Extract<ErroChatGPTSubscription, "identity_mismatch" | "credential_unreadable" | "refresh_in_progress" | "storage_failed"> };

export type EstadoDeConexaoSiwc =
  | { status: "not_connected" }
  | { status: "connected" }
  | { status: "expired" }
  | { status: "unreadable" };

function envelopeValido(value: unknown): value is ChatGPTSubscriptionEnvelope {
  if (!value || typeof value !== "object") return false;
  const token = value as Partial<ChatGPTSubscriptionEnvelope>;
  return (
    typeof token.access_token === "string" && token.access_token.length >= 16 &&
    typeof token.refresh_token === "string" && token.refresh_token.length >= 16 &&
    typeof token.client_id === "string" && token.client_id.length > 0 &&
    typeof token.subject === "string" && token.subject.length > 0 &&
    Array.isArray(token.scopes) &&
    token.scopes.includes("resource.invoke") &&
    token.scopes.includes("chatgpt.tokens.use.direct") &&
    typeof token.expires_at === "number" && Number.isFinite(token.expires_at) &&
    typeof token.token_type === "string" &&
    typeof token.ext_agent_host_id === "string" &&
    token.issuer === "https://auth.openai.com"
  );
}

function decifrarEnvelope(row: Pick<CredentialRow, "api_key_encrypted" | "api_key_iv" | "api_key_tag">): ChatGPTSubscriptionEnvelope {
  try {
    const raw = decryptKey({
      ciphertext: byteaToBuffer(row.api_key_encrypted),
      iv: byteaToBuffer(row.api_key_iv),
      tag: byteaToBuffer(row.api_key_tag),
    });
    const parsed: unknown = JSON.parse(raw);
    if (!envelopeValido(parsed)) throw new Error("envelope_invalido");
    return parsed;
  } catch {
    throw new Error("credential_unreadable");
  }
}

function colunasCifradas(envelope: ChatGPTSubscriptionEnvelope) {
  const cipher = encryptKey(JSON.stringify(envelope));
  return {
    api_key_encrypted: bufToBytea(cipher.ciphertext),
    api_key_iv: bufToBytea(cipher.iv),
    api_key_tag: bufToBytea(cipher.tag),
    // O esquema existente exige texto; esse marcador identifica o tipo do
    // registro sem revelar ou derivar qualquer fragmento do token OAuth.
    api_key_last4: MARKER_API_KEY_LAST4,
  };
}

async function lerLinha(admin: Admin, organizationId: string): Promise<CredentialRow | null> {
  const { data, error } = await admin
    .from("ai_provider_credentials")
    .select("id, organization_id, provider, label, api_key_encrypted, api_key_iv, api_key_tag, api_key_last4, validated_at, is_active, updated_at")
    .eq("organization_id", organizationId)
    .eq("provider", CHATGPT_SUBSCRIPTION_PROVIDER)
    .eq("label", CHATGPT_SUBSCRIPTION_LABEL)
    .maybeSingle();
  if (error) throw new Error("storage_failed");
  return (data as CredentialRow | null) ?? null;
}

export async function lerEstadoDaConexaoSiwc(
  admin: Admin,
  organizationId: string,
  agora = Date.now(),
): Promise<EstadoDeConexaoSiwc> {
  let row: CredentialRow | null;
  try {
    row = await lerLinha(admin, organizationId);
  } catch {
    return { status: "unreadable" };
  }
  if (!row || !row.is_active || !row.validated_at) return { status: "not_connected" };
  let envelope: ChatGPTSubscriptionEnvelope;
  try {
    envelope = decifrarEnvelope(row);
  } catch {
    return { status: "unreadable" };
  }
  return envelope.expires_at <= agora ? { status: "expired" } : { status: "connected" };
}

export async function lerTokensSiwc(
  admin: Admin,
  organizationId: string,
): Promise<{ row: CredentialRow; envelope: ChatGPTSubscriptionEnvelope } | null> {
  let row: CredentialRow | null;
  try {
    row = await lerLinha(admin, organizationId);
  } catch {
    throw new Error("storage_failed");
  }
  if (!row || !row.is_active || !row.validated_at) return null;
  return { row, envelope: decifrarEnvelope(row) };
}

export async function salvarCredencialSiwc(entrada: {
  admin: Admin;
  organizationId: string;
  userId: string;
  envelope: ChatGPTSubscriptionEnvelope;
  expectedSubject?: string;
  agora?: number;
}): Promise<ResultadoDeSalvarSiwc> {
  const agora = entrada.agora ?? Date.now();
  let existing: CredentialRow | null;
  try {
    existing = await lerLinha(entrada.admin, entrada.organizationId);
  } catch {
    return { ok: false, error: "storage_failed" };
  }

  if (!existing && entrada.expectedSubject) {
    // A desconexão durante o consentimento não pode ser seguida por uma
    // callback atrasada que recrie silenciosamente a conta removida.
    return { ok: false, error: "identity_mismatch" };
  }

  if (existing) {
    let anterior: ChatGPTSubscriptionEnvelope;
    try {
      anterior = decifrarEnvelope(existing);
    } catch {
      return { ok: false, error: "credential_unreadable" };
    }
    if (
      anterior.subject !== entrada.envelope.subject ||
      (entrada.expectedSubject !== undefined && anterior.subject !== entrada.expectedSubject)
    ) {
      return { ok: false, error: "identity_mismatch" };
    }
    if ((anterior.refresh_lock_until ?? 0) > agora) return { ok: false, error: "refresh_in_progress" };

    let encrypted: ReturnType<typeof colunasCifradas>;
    try {
      encrypted = colunasCifradas(entrada.envelope);
    } catch {
      return { ok: false, error: "storage_failed" };
    }
    const { data, error } = await entrada.admin
      .from("ai_provider_credentials")
      .update({
        ...encrypted,
        validated_at: new Date(agora).toISOString(),
        validation_error: null,
        models_available: null,
        is_active: true,
      })
      .eq("id", existing.id)
      .eq("organization_id", entrada.organizationId)
      .eq("provider", CHATGPT_SUBSCRIPTION_PROVIDER)
      .eq("updated_at", existing.updated_at)
      .select("id")
      .maybeSingle();
    if (error || !data) return { ok: false, error: "storage_failed" };
    return { ok: true, id: existing.id, reconnected: true };
  }

  let encrypted: ReturnType<typeof colunasCifradas>;
  try {
    encrypted = colunasCifradas(entrada.envelope);
  } catch {
    return { ok: false, error: "storage_failed" };
  }
  const { data, error } = await entrada.admin
    .from("ai_provider_credentials")
    .insert({
      organization_id: entrada.organizationId,
      provider: CHATGPT_SUBSCRIPTION_PROVIDER,
      label: CHATGPT_SUBSCRIPTION_LABEL,
      ...encrypted,
      validated_at: new Date(agora).toISOString(),
      validation_error: null,
      models_available: null,
      is_active: true,
      created_by: entrada.userId,
    })
    .select("id")
    .maybeSingle();
  if (!error && data) return { ok: true, id: data.id, reconnected: false };

  // Duas primeiras conexões concorrentes não podem sobrescrever a identidade
  // que venceu o índice único já existente (organization_id, provider, label).
  if (error?.code === "23505") {
    try {
      const raced = await lerLinha(entrada.admin, entrada.organizationId);
      if (!raced) return { ok: false, error: "storage_failed" };
      const racedEnvelope = decifrarEnvelope(raced);
      return racedEnvelope.subject === entrada.envelope.subject
        ? { ok: true, id: raced.id, reconnected: true }
        : { ok: false, error: "identity_mismatch" };
    } catch {
      return { ok: false, error: "credential_unreadable" };
    }
  }
  return { ok: false, error: "storage_failed" };
}

export async function apagarCredencialSiwc(
  admin: Admin,
  organizationId: string,
): Promise<{ ok: boolean; id: string | null }> {
  const { data, error } = await admin
    .from("ai_provider_credentials")
    .delete()
    .eq("organization_id", organizationId)
    .eq("provider", CHATGPT_SUBSCRIPTION_PROVIDER)
    .eq("label", CHATGPT_SUBSCRIPTION_LABEL)
    .select("id")
    .maybeSingle();
  return { ok: !error, id: (data as { id?: string } | null)?.id ?? null };
}

async function revogarRemotamente(
  envelope: ChatGPTSubscriptionEnvelope,
  fetchImpl: typeof fetch,
): Promise<boolean> {
  let endpoint: string | null = null;
  try {
    const response = await fetchImpl(CHATGPT_OIDC_CONFIGURATION, {
      method: "GET",
      redirect: "error",
      headers: { Accept: "application/json" },
      signal: AbortSignal.timeout(5_000),
    });
    const config: unknown = await response.json();
    if (!response.ok || !config || typeof config !== "object") return false;
    endpoint = validarEndpointDeRevogacao((config as { revocation_endpoint?: unknown }).revocation_endpoint);
  } catch {
    return false;
  }
  if (!endpoint) return false;

  for (let tentativa = 0; tentativa < 3; tentativa += 1) {
    try {
      const response = await fetchImpl(endpoint, {
        method: "POST",
        redirect: "error",
        headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
        body: new URLSearchParams({
          token: envelope.refresh_token,
          token_type_hint: "refresh_token",
          client_id: envelope.client_id,
        }).toString(),
        signal: AbortSignal.timeout(5_000),
      });
      if (response.status === 200) return true;
      if (response.status < 500 && response.status !== 429) return false;
    } catch {
      // A confirmação remota é best-effort; o token continua apenas na memória
      // até que a exclusão local termine.
    }
    if (tentativa < 2) await new Promise((resolve) => setTimeout(resolve, tentativa === 0 ? 250 : 750));
  }
  return false;
}

export async function revogarSessaoSiwc(
  envelope: ChatGPTSubscriptionEnvelope,
  fetchImpl: typeof fetch = fetch,
): Promise<boolean> {
  return revogarRemotamente(envelope, fetchImpl);
}

export type ResultadoDeAccessTokenSiwc =
  | { ok: true; accessToken: string; scopes: string[]; subject: string }
  | { ok: false; error: "feature_disabled" | "not_connected" | "credential_unreadable" | "refresh_failed" | "refresh_in_progress" | "storage_failed" };

/**
 * Leitor reservado ao runtime futuro. Não entra nos leitores genéricos de
 * chaves de API e falha fechado se o módulo não está habilitado.
 */
export async function obterAccessTokenSiwc(entrada: {
  admin?: Admin;
  organizationId: string;
  agora?: number;
  renovar?: (refreshToken: string, clientId: string, agora: number) => Promise<TokenGrant>;
}): Promise<ResultadoDeAccessTokenSiwc> {
  const admin = entrada.admin ?? createAdminClient();
  const ligado = await moduloLigado(admin, CHATGPT_SUBSCRIPTION_MODULE);
  if (!ligado) return { ok: false, error: "feature_disabled" };
  const agora = entrada.agora ?? Date.now();

  let lido: { row: CredentialRow; envelope: ChatGPTSubscriptionEnvelope } | null;
  try {
    lido = await lerTokensSiwc(admin, entrada.organizationId);
  } catch (erro) {
    return {
      ok: false,
      error: erro instanceof Error && erro.message === "credential_unreadable" ? "credential_unreadable" : "storage_failed",
    };
  }
  if (!lido) return { ok: false, error: "not_connected" };
  const { row, envelope } = lido;
  if (envelope.expires_at > agora + CHATGPT_REFRESH_EARLY_MS) {
    return { ok: true, accessToken: envelope.access_token, scopes: envelope.scopes, subject: envelope.subject };
  }
  if (envelope.expires_at <= agora && (envelope.refresh_lock_until ?? 0) > agora) {
    return { ok: false, error: "refresh_in_progress" };
  }
  if ((envelope.refresh_lock_until ?? 0) > agora) {
    return envelope.expires_at > agora
      ? { ok: true, accessToken: envelope.access_token, scopes: envelope.scopes, subject: envelope.subject }
      : { ok: false, error: "refresh_in_progress" };
  }

  const claimedEnvelope: ChatGPTSubscriptionEnvelope = {
    ...envelope,
    refresh_lock_until: agora + CHATGPT_REFRESH_LOCK_MS,
  };
  let encrypted: ReturnType<typeof colunasCifradas>;
  try {
    encrypted = colunasCifradas(claimedEnvelope);
  } catch {
    return { ok: false, error: "storage_failed" };
  }
  const { data: claim, error: claimError } = await admin
    .from("ai_provider_credentials")
    .update({ ...encrypted, updated_at: new Date(agora).toISOString() })
    .eq("id", row.id)
    .eq("organization_id", entrada.organizationId)
    .eq("provider", CHATGPT_SUBSCRIPTION_PROVIDER)
    .eq("updated_at", row.updated_at)
    .select("id, updated_at")
    .maybeSingle();
  if (claimError) return { ok: false, error: "storage_failed" };
  if (!claim) {
    try {
      const atual = await lerTokensSiwc(admin, entrada.organizationId);
      if (atual && atual.envelope.expires_at > agora) {
        return {
          ok: true,
          accessToken: atual.envelope.access_token,
          scopes: atual.envelope.scopes,
          subject: atual.envelope.subject,
        };
      }
    } catch {
      return { ok: false, error: "storage_failed" };
    }
    return { ok: false, error: "refresh_in_progress" };
  }

  let grant: TokenGrant;
  try {
    const renovar = entrada.renovar ?? (async (refreshToken: string, clientId: string, clock: number) =>
      renovarGrantSiwc({ refreshToken, clientId, scopesAnteriores: envelope.scopes, agora: clock }));
    grant = await renovar(envelope.refresh_token, envelope.client_id, agora);
  } catch {
    logger.warn("ChatGPT subscription refresh failed", {
      organization_id: entrada.organizationId,
      provider: CHATGPT_SUBSCRIPTION_PROVIDER,
      reason: "refresh_failed",
    });
    return { ok: false, error: "refresh_failed" };
  }

  const refreshed: ChatGPTSubscriptionEnvelope = {
    ...envelope,
    access_token: grant.accessToken,
    refresh_token: grant.refreshToken,
    token_type: grant.tokenType,
    scopes: grant.scopes.length ? grant.scopes : envelope.scopes,
    expires_at: grant.expiresAt,
    refresh_lock_until: undefined,
  };
  try {
    encrypted = colunasCifradas(refreshed);
  } catch {
    return { ok: false, error: "storage_failed" };
  }
  const { data: saved, error: saveError } = await admin
    .from("ai_provider_credentials")
    .update({ ...encrypted, validated_at: new Date(agora).toISOString() })
    .eq("id", row.id)
    .eq("organization_id", entrada.organizationId)
    .eq("provider", CHATGPT_SUBSCRIPTION_PROVIDER)
    .eq("updated_at", claim.updated_at)
    .select("id")
    .maybeSingle();
  if (saveError) return { ok: false, error: "storage_failed" };
  if (!saved) return { ok: false, error: "not_connected" };
  return { ok: true, accessToken: refreshed.access_token, scopes: refreshed.scopes, subject: refreshed.subject };
}
