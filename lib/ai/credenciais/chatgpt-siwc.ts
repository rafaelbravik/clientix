import {
  constants,
  createHash,
  createHmac,
  createPublicKey,
  randomBytes,
  timingSafeEqual,
  verify as verificarAssinatura,
} from "node:crypto";

import {
  CHATGPT_SUBSCRIPTION_MODULE,
  CHATGPT_SUBSCRIPTION_PROVIDER,
  CHATGPT_SUBSCRIPTION_LABEL,
} from "./chatgpt-subscription-constants";
export {
  CHATGPT_SUBSCRIPTION_MODULE,
  CHATGPT_SUBSCRIPTION_PROVIDER,
  CHATGPT_SUBSCRIPTION_LABEL,
  CHATGPT_SUBSCRIPTION_PROVIDER_LABEL,
  CHATGPT_SUBSCRIPTION_PROVIDER_DESCRIPTION,
} from "./chatgpt-subscription-constants";

export const CHATGPT_SUBSCRIPTION_HOST_KEY = "OPENAI_SIWC_EXT_AGENT_HOST_ID";
export const CHATGPT_DYNAMIC_CLIENT_ID = "dynamic_agent_client";
export const CHATGPT_REDIRECT_URI = "http://127.0.0.1:1455/auth/callback";
export const CHATGPT_AUTHORIZATION_ENDPOINT = "https://auth.openai.com/api/accounts/authorize";
export const CHATGPT_TOKEN_ENDPOINT = "https://auth.openai.com/api/accounts/oauth/token";
export const CHATGPT_JWKS_ENDPOINT = "https://auth.openai.com/.well-known/jwks.json";
export const CHATGPT_OIDC_CONFIGURATION = "https://auth.openai.com/.well-known/openid-configuration";
export const CHATGPT_RESOURCE = "https://api.openai.com/v1";
export const CHATGPT_SCOPES = [
  "openid",
  "profile",
  "email",
  "offline_access",
  "resource.invoke",
  "chatgpt.tokens.use.direct",
] as const;
export const CHATGPT_STATE_TTL_MS = 10 * 60 * 1000;
export const CHATGPT_PENDING_COOKIE = "clientix_chatgpt_siwc_pending";

export type ErroChatGPTSubscription =
  | "feature_disabled"
  | "not_connected"
  | "invalid_state"
  | "expired_state"
  | "replayed_nonce"
  | "invalid_callback"
  | "identity_mismatch"
  | "token_exchange_failed"
  | "invalid_id_token"
  | "refresh_failed"
  | "refresh_in_progress"
  | "remote_revoke_failed"
  | "credential_unreadable"
  | "configuration_unavailable"
  | "permission_denied"
  | "storage_failed";

export interface SiwcState {
  version: 1;
  organizationId: string;
  userId: string;
  clientId: string;
  nonce: string;
  issuedAt: number;
  expiresAt: number;
}

export interface SiwcCallback {
  state: string;
  code?: string;
  clientId?: string;
  error?: string;
}

export interface TokenGrant {
  accessToken: string;
  refreshToken: string;
  idToken?: string;
  tokenType: string;
  scopes: string[];
  expiresAt: number;
}

export interface VerifiedSiwcIdentity {
  subject: string;
  email?: string;
}

export function gerarVerifierPkce(): string {
  return randomBytes(48).toString("base64url");
}

export function challengeS256(verifier: string): string {
  return createHash("sha256").update(verifier, "ascii").digest("base64url");
}

export function gerarNonceSiwc(): string {
  return randomBytes(32).toString("base64url");
}

function hmac(carga: string, segredo: string): Buffer {
  if (typeof segredo !== "string" || segredo.trim().length < 32) {
    throw new Error("state_signing_key_unavailable");
  }
  return createHmac("sha256", segredo.trim()).update(carga, "utf8").digest();
}

export function assinarStateSiwc(
  entrada: Omit<SiwcState, "version" | "issuedAt" | "expiresAt">,
  segredo: string,
  agora = Date.now(),
): string {
  const estado: SiwcState = {
    version: 1,
    ...entrada,
    issuedAt: agora,
    expiresAt: agora + CHATGPT_STATE_TTL_MS,
  };
  const carga = Buffer.from(JSON.stringify(estado), "utf8").toString("base64url");
  return `${carga}.${hmac(carga, segredo).toString("base64url")}`;
}

export function verificarStateSiwc(
  state: string,
  segredo: string,
  agora = Date.now(),
): { ok: true; state: SiwcState } | { ok: false; reason: "invalid_state" | "expired_state" } {
  const partes = state.split(".");
  if (partes.length !== 2 || !partes[0] || !partes[1]) return { ok: false, reason: "invalid_state" };

  let assinaturaEsperada: Buffer;
  let assinaturaRecebida: Buffer;
  let decodificada: unknown;
  try {
    assinaturaEsperada = hmac(partes[0], segredo);
    assinaturaRecebida = Buffer.from(partes[1], "base64url");
    decodificada = JSON.parse(Buffer.from(partes[0], "base64url").toString("utf8"));
  } catch {
    return { ok: false, reason: "invalid_state" };
  }
  if (
    assinaturaRecebida.length !== assinaturaEsperada.length ||
    !timingSafeEqual(assinaturaEsperada, assinaturaRecebida)
  ) {
    return { ok: false, reason: "invalid_state" };
  }

  if (!decodificada || typeof decodificada !== "object") return { ok: false, reason: "invalid_state" };
  const payload = decodificada as Partial<SiwcState>;
  if (
    payload.version !== 1 ||
    typeof payload.organizationId !== "string" ||
    typeof payload.userId !== "string" ||
    typeof payload.clientId !== "string" ||
    typeof payload.nonce !== "string" ||
    typeof payload.issuedAt !== "number" ||
    typeof payload.expiresAt !== "number" ||
    payload.organizationId.length === 0 ||
    payload.userId.length === 0 ||
    payload.clientId.length === 0 ||
    payload.nonce.length < 32 ||
    payload.expiresAt <= payload.issuedAt ||
    payload.expiresAt - payload.issuedAt > CHATGPT_STATE_TTL_MS
  ) {
    return { ok: false, reason: "invalid_state" };
  }
  if (payload.issuedAt > agora + 30_000) return { ok: false, reason: "invalid_state" };
  if (payload.expiresAt <= agora) return { ok: false, reason: "expired_state" };
  return { ok: true, state: payload as SiwcState };
}

export function montarUrlAutorizacaoSiwc(entrada: {
  state: string;
  nonce: string;
  codeChallenge: string;
  clientId: string;
  hostId: string;
}): string {
  const params = new URLSearchParams({
    response_type: "code",
    client_id: entrada.clientId,
    redirect_uri: CHATGPT_REDIRECT_URI,
    scope: CHATGPT_SCOPES.join(" "),
    resource: CHATGPT_RESOURCE,
    state: entrada.state,
    nonce: entrada.nonce,
    code_challenge_method: "S256",
    code_challenge: entrada.codeChallenge,
    ext_agent_host_id: entrada.hostId,
  });
  if (entrada.clientId === CHATGPT_DYNAMIC_CLIENT_ID) params.set("agent_name_hint", "Clientix");
  return `${CHATGPT_AUTHORIZATION_ENDPOINT}?${params.toString()}`;
}

export function lerCallbackSiwc(texto: string): SiwcCallback | null {
  if (typeof texto !== "string" || texto.trim().length === 0 || texto.length > 4096) return null;
  let url: URL;
  try {
    url = new URL(texto.trim());
  } catch {
    return null;
  }
  if (
    url.protocol !== "http:" ||
    url.hostname !== "127.0.0.1" ||
    url.port !== "1455" ||
    url.pathname !== "/auth/callback" ||
    url.username !== "" ||
    url.password !== "" ||
    url.hash !== ""
  ) {
    return null;
  }

  const permitidos = new Set(["code", "state", "client_id", "scope", "error", "error_description"]);
  for (const chave of url.searchParams.keys()) {
    if (!permitidos.has(chave) || url.searchParams.getAll(chave).length !== 1) return null;
  }
  const state = url.searchParams.get("state")?.trim() ?? "";
  const code = url.searchParams.get("code")?.trim() ?? "";
  const clientId = url.searchParams.get("client_id")?.trim() ?? "";
  const error = url.searchParams.get("error")?.trim() ?? "";
  if (!state || (!code && !error) || (code && error) || code.length > 2048) return null;
  return {
    state,
    ...(code ? { code } : {}),
    ...(clientId ? { clientId } : {}),
    ...(error ? { error } : {}),
  };
}

async function fetchJsonSeguro(
  fetchImpl: typeof fetch,
  url: string,
  body: URLSearchParams,
): Promise<{ resposta: Response; corpo: unknown }> {
  const resposta = await fetchImpl(url, {
    method: "POST",
    redirect: "error",
    headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
    body: body.toString(),
    signal: AbortSignal.timeout(15_000),
  });
  let corpo: unknown = null;
  try {
    corpo = await resposta.json();
  } catch {
    corpo = null;
  }
  return { resposta, corpo };
}

function lerGrant(
  resposta: Response,
  corpo: unknown,
  agora: number,
  opcoes: { exigeIdToken: boolean; escoposAnteriores?: readonly string[] },
): TokenGrant {
  if (!resposta.ok || !corpo || typeof corpo !== "object") throw new Error("token_exchange_failed");
  const dado = corpo as Record<string, unknown>;
  const escopos = typeof dado.scope === "string"
    ? dado.scope.split(/\s+/).filter(Boolean)
    : [...(opcoes.escoposAnteriores ?? [])];
  if (
    typeof dado.access_token !== "string" ||
    dado.access_token.length < 16 ||
    typeof dado.refresh_token !== "string" ||
    dado.refresh_token.length < 16 ||
    (opcoes.exigeIdToken && (typeof dado.id_token !== "string" || dado.id_token.length < 16)) ||
    (dado.id_token !== undefined && (typeof dado.id_token !== "string" || dado.id_token.length < 16)) ||
    typeof dado.expires_in !== "number" ||
    !Number.isFinite(dado.expires_in) ||
    dado.expires_in <= 0 ||
    dado.expires_in > 86_400 ||
    !escopos.includes("resource.invoke") ||
    !escopos.includes("chatgpt.tokens.use.direct")
  ) {
    throw new Error("token_exchange_failed");
  }
  return {
    accessToken: dado.access_token,
    refreshToken: dado.refresh_token,
    ...(typeof dado.id_token === "string" ? { idToken: dado.id_token } : {}),
    tokenType: typeof dado.token_type === "string" ? dado.token_type : "Bearer",
    scopes: [...new Set(escopos)].sort(),
    expiresAt: agora + dado.expires_in * 1000,
  };
}

export async function trocarCodigoSiwc(entrada: {
  code: string;
  verifier: string;
  clientId: string;
  fetchImpl?: typeof fetch;
  agora?: number;
}): Promise<TokenGrant> {
  if (entrada.clientId === CHATGPT_DYNAMIC_CLIENT_ID) throw new Error("token_exchange_failed");
  try {
    const { resposta, corpo } = await fetchJsonSeguro(entrada.fetchImpl ?? fetch, CHATGPT_TOKEN_ENDPOINT, new URLSearchParams({
      grant_type: "authorization_code",
      code: entrada.code,
      redirect_uri: CHATGPT_REDIRECT_URI,
      client_id: entrada.clientId,
      code_verifier: entrada.verifier,
      resource: CHATGPT_RESOURCE,
    }));
    return lerGrant(resposta, corpo, entrada.agora ?? Date.now(), { exigeIdToken: true });
  } catch {
    throw new Error("token_exchange_failed");
  }
}

export async function renovarGrantSiwc(entrada: {
  refreshToken: string;
  clientId: string;
  scopesAnteriores?: readonly string[];
  fetchImpl?: typeof fetch;
  agora?: number;
}): Promise<TokenGrant> {
  try {
    const { resposta, corpo } = await fetchJsonSeguro(entrada.fetchImpl ?? fetch, CHATGPT_TOKEN_ENDPOINT, new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: entrada.refreshToken,
      client_id: entrada.clientId,
      resource: CHATGPT_RESOURCE,
    }));
    return lerGrant(resposta, corpo, entrada.agora ?? Date.now(), {
      exigeIdToken: false,
      escoposAnteriores: entrada.scopesAnteriores,
    });
  } catch {
    throw new Error("refresh_failed");
  }
}

export async function verificarIdTokenSiwc(entrada: {
  idToken: string;
  clientId: string;
  nonce: string;
  fetchImpl?: typeof fetch;
  jwks?: readonly Record<string, unknown>[];
  agora?: number;
}): Promise<VerifiedSiwcIdentity> {
  try {
    const partes = entrada.idToken.split(".");
    if (
      entrada.idToken.length > 32_768 ||
      partes.length !== 3 ||
      partes.some((parte) => !/^[A-Za-z0-9_-]+$/.test(parte))
    ) {
      throw new Error("invalid_id_token");
    }
    const [parteCabecalho, parteClaims, parteAssinatura] = partes;
    if (!parteCabecalho || !parteClaims || !parteAssinatura) throw new Error("invalid_id_token");
    const cabecalho: unknown = JSON.parse(Buffer.from(parteCabecalho, "base64url").toString("utf8"));
    const claims: unknown = JSON.parse(Buffer.from(parteClaims, "base64url").toString("utf8"));
    if (!objetoJson(cabecalho) || !objetoJson(claims)) throw new Error("invalid_id_token");
    const header = cabecalho;
    const payload = claims;
    if (header.alg !== "RS256" || typeof header.kid !== "string" || header.kid.length === 0) {
      throw new Error("invalid_id_token");
    }

    let chaves = entrada.jwks;
    if (!chaves) {
      const resposta = await (entrada.fetchImpl ?? fetch)(CHATGPT_JWKS_ENDPOINT, {
        method: "GET",
        redirect: "error",
        headers: { Accept: "application/json" },
        signal: AbortSignal.timeout(6_000),
      });
      const corpo: unknown = await resposta.json();
      if (!resposta.ok || !objetoJson(corpo) || !Array.isArray(corpo.keys) || corpo.keys.length > 64) {
        throw new Error("invalid_id_token");
      }
      chaves = corpo.keys.filter(objetoJson);
    }
    const jwk = chaves.find((candidate) =>
      candidate.kid === header.kid &&
      candidate.kty === "RSA" &&
      (candidate.use === undefined || candidate.use === "sig") &&
      (candidate.alg === undefined || candidate.alg === "RS256") &&
      (candidate.key_ops === undefined || (Array.isArray(candidate.key_ops) && candidate.key_ops.includes("verify"))) &&
      typeof candidate.n === "string" &&
      typeof candidate.e === "string" &&
      !("d" in candidate),
    );
    if (!jwk) throw new Error("invalid_id_token");

    const chavePublica = createPublicKey({ key: jwk as import("crypto").JsonWebKey, format: "jwk" });
    if ((chavePublica.asymmetricKeyDetails?.modulusLength ?? 0) < 2048) {
      throw new Error("invalid_id_token");
    }
    const assinaturaValida = verificarAssinatura(
      "RSA-SHA256",
      Buffer.from(`${parteCabecalho}.${parteClaims}`, "ascii"),
      { key: chavePublica, padding: constants.RSA_PKCS1_PADDING },
      Buffer.from(parteAssinatura, "base64url"),
    );
    if (!assinaturaValida) throw new Error("invalid_id_token");

    const agoraSegundos = Math.floor((entrada.agora ?? Date.now()) / 1000);
    const audiencia = payload.aud;
    const audiencias = typeof audiencia === "string" ? [audiencia] : Array.isArray(audiencia) ? audiencia : [];
    if (
      payload.iss !== "https://auth.openai.com" ||
      !audiencias.includes(entrada.clientId) ||
      typeof payload.sub !== "string" || payload.sub.length === 0 ||
      typeof payload.exp !== "number" || !Number.isFinite(payload.exp) || payload.exp <= agoraSegundos - 5 ||
      typeof payload.iat !== "number" || !Number.isFinite(payload.iat) || payload.iat > agoraSegundos + 5 ||
      (payload.nbf !== undefined &&
        (typeof payload.nbf !== "number" || !Number.isFinite(payload.nbf) || payload.nbf > agoraSegundos + 5)) ||
      !compararEmTempoConstante(payload.nonce, entrada.nonce) ||
      (audiencias.length > 1 && payload.azp !== entrada.clientId) ||
      (payload.azp !== undefined && payload.azp !== entrada.clientId)
    ) {
      throw new Error("invalid_id_token");
    }
    return {
      subject: payload.sub,
      ...(typeof payload.email === "string" && payload.email_verified === true ? { email: payload.email } : {}),
    };
  } catch {
    throw new Error("invalid_id_token");
  }
}

function objetoJson(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function compararEmTempoConstante(value: unknown, esperado: string): boolean {
  if (typeof value !== "string") return false;
  const atual = Buffer.from(value, "utf8");
  const correto = Buffer.from(esperado, "utf8");
  return atual.length === correto.length && timingSafeEqual(atual, correto);
}

export function validarEndpointDeRevogacao(valor: unknown): string | null {
  if (typeof valor !== "string") return null;
  try {
    const url = new URL(valor);
    if (
      url.protocol !== "https:" ||
      url.hostname !== "auth.openai.com" ||
      (url.port !== "" && url.port !== "443") ||
      url.username !== "" ||
      url.password !== "" ||
      url.search !== "" ||
      url.hash !== "" ||
      !url.pathname.startsWith("/")
    ) return null;
    return url.toString();
  } catch {
    return null;
  }
}
