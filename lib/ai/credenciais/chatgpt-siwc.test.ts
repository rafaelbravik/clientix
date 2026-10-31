import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { describe, expect, it, vi } from "vitest";

import {
  CHATGPT_AUTHORIZATION_ENDPOINT,
  CHATGPT_DYNAMIC_CLIENT_ID,
  CHATGPT_JWKS_ENDPOINT,
  CHATGPT_REDIRECT_URI,
  CHATGPT_RESOURCE,
  CHATGPT_SCOPES,
  CHATGPT_STATE_TTL_MS,
  assinarStateSiwc,
  challengeS256,
  gerarNonceSiwc,
  gerarVerifierPkce,
  lerCallbackSiwc,
  montarUrlAutorizacaoSiwc,
  renovarGrantSiwc,
  trocarCodigoSiwc,
  validarEndpointDeRevogacao,
  verificarIdTokenSiwc,
  verificarStateSiwc,
} from "./chatgpt-siwc";
import { revogarSessaoSiwc } from "./chatgpt-subscription";

const SEGREDO = "segredo-sintetico-com-mais-de-trinta-e-dois-bytes";
const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const jwk = {
  ...publicKey.export({ format: "jwk" }),
  kid: "fixture-key",
  alg: "RS256",
  use: "sig",
  key_ops: ["verify"],
};

function base64url(value: unknown): string {
  return Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
}

function token(claims: Record<string, unknown>, header: Record<string, unknown> = { alg: "RS256", kid: "fixture-key" }) {
  const head = base64url(header);
  const body = base64url(claims);
  const assinatura = sign("RSA-SHA256", Buffer.from(`${head}.${body}`, "ascii"), privateKey).toString("base64url");
  return `${head}.${body}.${assinatura}`;
}

function claims(overrides: Record<string, unknown> = {}) {
  const agora = Math.floor(Date.now() / 1000);
  return {
    iss: "https://auth.openai.com",
    aud: "issued-client-id",
    sub: "siwc-subject-fixture",
    nonce: "n".repeat(43),
    iat: agora,
    exp: agora + 300,
    email: "synthetic@example.invalid",
    email_verified: true,
    ...overrides,
  };
}

describe("ChatGPT SIWC — estado, PKCE e callback loopback", () => {
  it("gera verifier criptográfico e challenge S256", () => {
    const verifier = gerarVerifierPkce();
    expect(verifier).toMatch(/^[A-Za-z0-9_-]{64}$/);
    expect(verifier).not.toBe(gerarVerifierPkce());
    expect(challengeS256(verifier)).toBe(
      createHash("sha256").update(verifier, "ascii").digest("base64url"),
    );
    expect(gerarNonceSiwc()).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });

  it("state assinado liga usuário, organização, client_id e nonce por no máximo dez minutos", () => {
    const agora = 1_800_000_000_000;
    const state = assinarStateSiwc(
      { organizationId: "org-a", userId: "user-a", clientId: CHATGPT_DYNAMIC_CLIENT_ID, nonce: "n".repeat(43) },
      SEGREDO,
      agora,
    );
    const validado = verificarStateSiwc(state, SEGREDO, agora + 1);
    expect(validado).toMatchObject({
      ok: true,
      state: { organizationId: "org-a", userId: "user-a", clientId: CHATGPT_DYNAMIC_CLIENT_ID },
    });
    if (validado.ok) expect(validado.state.expiresAt - validado.state.issuedAt).toBe(CHATGPT_STATE_TTL_MS);

    const [payload, assinatura] = state.split(".");
    expect(verificarStateSiwc(`${payload}x.${assinatura}`, SEGREDO, agora)).toEqual({ ok: false, reason: "invalid_state" });
    expect(verificarStateSiwc(state, SEGREDO, agora + CHATGPT_STATE_TTL_MS)).toEqual({ ok: false, reason: "expired_state" });
  });

  it("monta autorização SIWC com apenas os scopes aprovados, resource e S256", () => {
    const url = new URL(montarUrlAutorizacaoSiwc({
      state: "signed-state",
      nonce: "nonce-fixture",
      codeChallenge: challengeS256("verifier-fixture"),
      clientId: CHATGPT_DYNAMIC_CLIENT_ID,
      hostId: "urn:uuid:00000000-0000-4000-8000-000000000001",
    }));
    expect(url.origin + url.pathname).toBe(CHATGPT_AUTHORIZATION_ENDPOINT);
    expect(url.searchParams.get("redirect_uri")).toBe(CHATGPT_REDIRECT_URI);
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
    expect(url.searchParams.get("scope")?.split(" ")).toEqual([...CHATGPT_SCOPES]);
    expect(url.searchParams.get("resource")).toBe(CHATGPT_RESOURCE);
  });

  it.each([
    "http://127.0.0.1:1455/auth/callback?code=code-fixture&state=state-fixture&client_id=client-fixture",
    "http://127.0.0.1:1455/auth/callback?error=access_denied&state=state-fixture",
  ])("aceita somente a estrutura de callback loopback prevista: %s", (url) => {
    expect(lerCallbackSiwc(url)).not.toBeNull();
  });

  it.each([
    "http://localhost:1455/auth/callback?code=c&state=s",
    "http://127.0.0.1:1456/auth/callback?code=c&state=s",
    "http://127.0.0.1:1455/other?code=c&state=s",
    "http://user@127.0.0.1:1455/auth/callback?code=c&state=s",
    "http://127.0.0.1:1455/auth/callback?code=c&state=s#fragment",
    "http://127.0.0.1:1455/auth/callback?code=c&state=s&redirect_uri=https://evil.test",
    "http://127.0.0.1:1455/auth/callback?code=c&state=s&state=other",
    "http://127.0.0.1:1455/auth/callback?code=c&error=denied&state=s",
  ])("recusa callback inválido ou com parâmetro perigoso: %s", (url) => {
    expect(lerCallbackSiwc(url)).toBeNull();
  });
});

describe("ChatGPT SIWC — troca e validação OIDC", () => {
  it("troca o código no servidor usando endpoint fixo, verifier, client e redirect", async () => {
    const fetchImpl = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      expect(init?.redirect).toBe("error");
      expect(init?.method).toBe("POST");
      const form = new URLSearchParams(String(init?.body));
      expect(form.get("grant_type")).toBe("authorization_code");
      expect(form.get("code")).toBe("authorization-code-fixture");
      expect(form.get("code_verifier")).toBe("pkce-verifier-fixture");
      expect(form.get("client_id")).toBe("issued-client-id");
      expect(form.get("redirect_uri")).toBe(CHATGPT_REDIRECT_URI);
      return new Response(JSON.stringify({
        access_token: "synthetic-access-token-0123456789",
        refresh_token: "synthetic-refresh-token-0123456789",
        id_token: "synthetic-id-token-0123456789",
        scope: "openid resource.invoke chatgpt.tokens.use.direct",
        expires_in: 3600,
        token_type: "Bearer",
      }), { status: 200, headers: { "content-type": "application/json" } });
    });
    const grant = await trocarCodigoSiwc({
      code: "authorization-code-fixture",
      verifier: "pkce-verifier-fixture",
      clientId: "issued-client-id",
      fetchImpl: fetchImpl as typeof fetch,
      agora: 2_000,
    });
    expect(String(fetchImpl.mock.calls[0]?.[0])).toBe("https://auth.openai.com/api/accounts/oauth/token");
    expect(grant).toMatchObject({
      accessToken: "synthetic-access-token-0123456789",
      refreshToken: "synthetic-refresh-token-0123456789",
      idToken: "synthetic-id-token-0123456789",
      expiresAt: 3_602_000,
    });
  });

  it("refresh aceita rotação e reaproveita scopes quando o servidor não os repete", async () => {
    let requestBody: BodyInit | null | undefined;
    const fetchImpl = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      requestBody = init?.body;
      return new Response(JSON.stringify({
      access_token: "rotated-access-token-0123456789",
      refresh_token: "rotated-refresh-token-0123456789",
      expires_in: 3600,
      }), { status: 200, headers: { "content-type": "application/json" } });
    });
    const grant = await renovarGrantSiwc({
      refreshToken: "old-refresh-token-0123456789",
      clientId: "issued-client-id",
      scopesAnteriores: [...CHATGPT_SCOPES],
      fetchImpl: fetchImpl as typeof fetch,
      agora: 5_000,
    });
    const body = new URLSearchParams(String(requestBody));
    expect(body.get("grant_type")).toBe("refresh_token");
    expect(grant.refreshToken).toBe("rotated-refresh-token-0123456789");
    expect(grant.scopes).toEqual([...CHATGPT_SCOPES].sort());
    expect(grant.idToken).toBeUndefined();
  });

  it("valida assinatura RS256, issuer, audience, nonce, expiração e subject", async () => {
    const identity = await verificarIdTokenSiwc({
      idToken: token(claims()),
      clientId: "issued-client-id",
      nonce: "n".repeat(43),
      jwks: [jwk],
    });
    expect(identity).toEqual({ subject: "siwc-subject-fixture", email: "synthetic@example.invalid" });
  });

  it.each([
    ["issuer", { iss: "https://attacker.invalid" }, "n".repeat(43)],
    ["audience", { aud: "other-client-id" }, "n".repeat(43)],
    ["nonce", {}, "x".repeat(43)],
    ["expiry", { exp: 1 }, "n".repeat(43)],
  ])("recusa ID token com %s inválido", async (_case, override, nonce) => {
    await expect(verificarIdTokenSiwc({
      idToken: token(claims(override)),
      clientId: "issued-client-id",
      nonce,
      jwks: [jwk],
    })).rejects.toThrow("invalid_id_token");
  });

  it("recusa assinatura inválida e algoritmo fora da allowlist", async () => {
    const valido = token(claims());
    const [head, body] = valido.split(".");
    const tokenAlterado = `${head}.${base64url(claims({ sub: "forged-subject" }))}.${valido.split(".")[2]}`;
    await expect(verificarIdTokenSiwc({
      idToken: tokenAlterado,
      clientId: "issued-client-id",
      nonce: "n".repeat(43),
      jwks: [jwk],
    })).rejects.toThrow("invalid_id_token");
    await expect(verificarIdTokenSiwc({
      idToken: token(claims(), { alg: "HS256", kid: "fixture-key" }),
      clientId: "issued-client-id",
      nonce: "n".repeat(43),
      jwks: [jwk],
    })).rejects.toThrow("invalid_id_token");
    expect(head).toBeDefined();
    expect(body).toBeDefined();
  });

  it("não usa email não verificado como metadata da conta", async () => {
    const identity = await verificarIdTokenSiwc({
      idToken: token(claims({ email_verified: false })),
      clientId: "issued-client-id",
      nonce: "n".repeat(43),
      jwks: [jwk],
    });
    expect(identity).toEqual({ subject: "siwc-subject-fixture" });
  });

  it("só aceita endpoint de revogação oficial e chama o remoto sem expor resposta", async () => {
    expect(validarEndpointDeRevogacao("https://auth.openai.com/api/accounts/oauth/revoke")).toBe(
      "https://auth.openai.com/api/accounts/oauth/revoke",
    );
    expect(validarEndpointDeRevogacao("https://attacker.invalid/revoke")).toBeNull();
    expect(validarEndpointDeRevogacao("https://auth.openai.com:444/revoke")).toBeNull();
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({
        revocation_endpoint: "https://auth.openai.com/api/accounts/oauth/revoke",
      }), { status: 200 }))
      .mockResolvedValueOnce(new Response(null, { status: 200 }));
    const ok = await revogarSessaoSiwc({
      access_token: "synthetic-access-token-0123456789",
      refresh_token: "synthetic-refresh-token-0123456789",
      client_id: "issued-client-id",
      subject: "subject",
      scopes: [...CHATGPT_SCOPES],
      expires_at: 1,
      token_type: "Bearer",
      ext_agent_host_id: "urn:uuid:00000000-0000-4000-8000-000000000001",
      issuer: "https://auth.openai.com",
    }, fetchImpl as typeof fetch);
    expect(ok).toBe(true);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });
});
