import { describe, expect, it, vi, beforeEach } from "vitest";
import {
  POST,
  _clearWebhookSessionCacheForTest,
  _getWebhookSessionCacheSizeForTest,
  _getWebhookInFlightSizeForTest,
  _getSessionToTokenSizeForTest,
  _getTokenEpochsSizeForTest,
} from "@/app/api/v1/webhooks/channel/[token]/route";
import { resolveSessionForToken } from "@/lib/channels/webhook-session-cache";
import {
  recordSignatureFailureAtomic,
  setAtomicSignatureFailureDriverForTest,
  __setSignatureRateLimitClockForTest,
} from "@/lib/channels/webhook-signature-rate-limit";
import { resolveClientIp, isValidIp } from "@/lib/channels/webhook-ip";
import {
  checkRateLimit,
  __limparMemoriaRateLimitParaTeste,
  __chavesEmMemoriaParaTeste,
  __setRateLimitRedisForTest,
} from "@/lib/ai/dispatcher/rate-limit";
import { NextRequest } from "next/server";
import type * as InboundModule from "@/lib/channels/inbound";

// Simulação de banco e serviços
let mockSession: {
  id: string;
  organization_id: string;
  provider: string;
  display_name: string;
  phone_number: string | null;
  webhook_secret_encrypted: string | null;
  archived_at: string | null;
} = {
  id: "session-123",
  organization_id: "org-123",
  provider: "telegram",
  display_name: "Bot Telegram",
  phone_number: null,
  webhook_secret_encrypted: "encrypted-secret",
  archived_at: null,
};

let capturedFiles: Record<string, unknown>[] = [];
let closedFiles: Record<string, unknown>[] = [];
let dbSelectCount = 0;
let dbSelectError: { code: string; message: string } | null = null;
let verifySignatureResult = true;
let verifyCallCount = 0;
let verifyExpectedSecret: string | undefined;
let delayDbMs = 0;

vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => ({
    from: () => ({
      select: () => {
        dbSelectCount++;
        return {
          eq: (col: string, val: string) => ({
            maybeSingle: async () => {
              if (delayDbMs > 0) {
                await new Promise((resolve) => setTimeout(resolve, delayDbMs));
              }
              if (dbSelectError) return { data: null, error: dbSelectError };
              if (val.startsWith("unknown-token")) {
                return { data: null, error: null };
              }
              if (val.startsWith("token-dynamic-")) {
                const num = val.replace("token-dynamic-", "");
                return {
                  data: {
                    ...mockSession,
                    id: `session-dyn-${num}`,
                  },
                  error: null,
                };
              }
              return { data: mockSession, error: null };
            },
          }),
        };
      },
    }),
  }),
}));

vi.mock("@/lib/channels/archived", () => ({
  ARCHIVED_AT: "archived_at",
  queryTolerantToMissingArchived: async (fn: () => unknown) => {
    return fn();
  },
}));

vi.mock("@/lib/webhooks/secrets", () => ({
  decryptWebhookSecret: async (_admin: unknown, encrypted: string) => `decrypted-${encrypted}`,
}));

vi.mock("@/lib/channels/arquivo-de-webhook", () => ({
  abrirArquivoDoWebhook: async (_admin: unknown, payload: Record<string, unknown>) => {
    capturedFiles.push(payload);
    return { id: `arquivo-${capturedFiles.length}` };
  },
  fecharArquivoDoWebhook: async (_admin: unknown, _arquivo: unknown, desfecho: Record<string, unknown>) => {
    closedFiles.push(desfecho);
  },
}));

vi.mock("@/lib/channels/inbound", () => ({
  acceptsInboundWebhook: () => true,
  verifyAndCreateInternalSignatureProof: (_sessionId: string, _provider: string, _rawBody: string, _headers: Headers, secret: string | null) => {
    verifyCallCount++;
    return verifySignatureResult && (verifyExpectedSecret === undefined || secret === verifyExpectedSecret)
      ? { valid: true, proof: "verified-proof" }
      : { valid: false, proof: null };
  },
  inboundPayloadBelongsToSession: async () => true,
  handleInboundWebhook: async () => ({ ok: true, body: { status: "processed" } }),
}));

describe("POST /api/v1/webhooks/channel/[token] - Limites Atômicos, Sobrecarga e Identidade de IP", () => {
  beforeEach(() => {
    capturedFiles = [];
    closedFiles = [];
    dbSelectCount = 0;
    dbSelectError = null;
    verifyCallCount = 0;
    delayDbMs = 0;
    verifySignatureResult = true;
    verifyExpectedSecret = undefined;
    _clearWebhookSessionCacheForTest();
    __limparMemoriaRateLimitParaTeste();
    __setRateLimitRedisForTest(null);
    setAtomicSignatureFailureDriverForTest(async () => 0, async () => 0);
    vi.clearAllMocks();
  });

  // ─── Achado 1: Identidade de IP Robusta e Não Falsificável ───────────────────
  it("IP: ignora X-Real-IP forjado pelo cliente quando X-Forwarded-For adicionado pelo proxy está presente", () => {
    // Cliente forjou x-real-ip querendo escolher o bucket "1.1.1.1", mas o proxy anexou "198.51.100.42" ao XFF
    const headers = new Headers({
      "x-real-ip": "1.1.1.1",
      "x-forwarded-for": "10.0.0.1, 198.51.100.42",
    });
    expect(resolveClientIp(headers)).toBe("198.51.100.42");
  });

  it("IP: validação robusta aceita IPv4 e formatos variados de IPv6 comprimido via isIP", () => {
    expect(isValidIp("192.168.1.1")).toBe(true);
    expect(isValidIp("10.0.0.1")).toBe(true);
    expect(isValidIp("::1")).toBe(true);
    expect(isValidIp("2001:db8::1")).toBe(true);
    expect(isValidIp("2001:db8:85a3::8a2e:370:7334")).toBe(true);
    expect(isValidIp("fe80::1ff:fe23:4567:890a")).toBe(true);
    expect(isValidIp("invalid-ip-string")).toBe(false);
    expect(isValidIp("999.999.999.999")).toBe(false);
  });

  it("IP: sem cabeçalho confiável retorna null sem agrupar em 'unknown_ip'", () => {
    const emptyHeaders = new Headers();
    expect(resolveClientIp(emptyHeaders)).toBeNull();

    const junkHeaders = new Headers({ "x-forwarded-for": "junk-payload" });
    expect(resolveClientIp(junkHeaders)).toBeNull();
  });

  it("IP: conexões sem IP identificável usam apenas limite por token sem bloqueio coletivo", async () => {
    const token = "token-no-ip-" + Math.random().toString(36).slice(2);
    for (let i = 0; i < 20; i++) {
      const req = new NextRequest(`http://localhost/api/v1/webhooks/channel/${token}`, {
        method: "POST",
        body: JSON.stringify({ ping: i }),
      });
      const res = await POST(req, { params: Promise.resolve({ token }) });
      expect(res.status).toBe(200);
    }
  });

  // ─── Achado 2: Logs Livres de Tokens Brutos ─────────────────────────────────
  it("segurança de logs: logger nunca recebe tokens brutos em falha de Redis ou rate limit, mesmo se a mensagem de erro da lib contiver a chave/token", async () => {
    const secretToken = "super-secret-webhook-token-xyz-12345678";
    const loggedMessages: Array<{ msg: string; ctx: Record<string, unknown> | undefined }> = [];

    const originalWarn = console.warn;
    const originalError = console.error;
    console.warn = (jsonStr: string) => {
      try {
        loggedMessages.push(JSON.parse(jsonStr));
      } catch {
        // ignore
      }
    };
    console.error = (jsonStr: string) => {
      try {
        loggedMessages.push(JSON.parse(jsonStr));
      } catch {
        // ignore
      }
    };

    try {
      // 1. Simula falha do Redis cujo .message inclui o token bruto (ex: chave rejeitada pelo servidor)
      setAtomicSignatureFailureDriverForTest(async () => {
        throw new Error(`Command eval failed on webhook_sig_fail_zset:${secretToken}: connection reset`);
      }, async () => 0);
      await recordSignatureFailureAtomic(secretToken, { limit: 10, windowSec: 600 });

      // 2. Simula falha do Redis no limitador genérico checkRateLimit onde .message também inclui o token
      // O cliente injetado força o caminho real de catch/fallback e logger.warn.
      __setRateLimitRedisForTest({
        incr: async () => {
          throw new Error(`Command incr failed on webhook_channel:${secretToken}: connection reset`);
        },
        expire: async () => 1,
      } as never);
      await checkRateLimit(`webhook_channel:${secretToken}`, 60, 60);

      // Inspeciona todas as mensagens gravadas
      const fullLogString = JSON.stringify(loggedMessages);
      expect(fullLogString).not.toContain(secretToken);
      expect(fullLogString).toContain("[TOKEN_HASH:");
    } finally {
      __setRateLimitRedisForTest(null);
      console.warn = originalWarn;
      console.error = originalError;
    }
  });

  it("fallback de rate limit mantém o mapa em memória rigidamente limitado", async () => {
    for (let i = 0; i < 10_050; i++) {
      await checkRateLimit(`webhook_channel:unique-token-${i}`, 60, 60);
    }
    expect(__chavesEmMemoriaParaTeste()).toBeLessThanOrEqual(10_000);
  });

  // ─── Achado 3: Verificação de Assinatura Única por Requisição ───────────────
  it("otimização e consistência: verifica assinatura exatamente uma única vez por requisição", async () => {
    const token = "token-single-verify-" + Math.random().toString(36).slice(2);
    verifySignatureResult = true;
    verifyCallCount = 0;

    const req = new NextRequest(`http://localhost/api/v1/webhooks/channel/${token}`, {
      method: "POST",
      headers: { "x-forwarded-for": "10.10.10.1" },
      body: JSON.stringify({ hello: "world" }),
    });

    const res = await POST(req, { params: Promise.resolve({ token }) });
    expect(res.status).toBe(200);
    // Deve ter chamado exatamente 1 vez o verificador
    expect(verifyCallCount).toBe(1);
  });

  it("confirma o segredo de novo após receber o corpo, respeitando uma rotação durante upload lento", async () => {
    const token = "token-rotation-during-upload";
    let releaseBody!: () => void;
    const bodyGate = new Promise<void>((resolve) => { releaseBody = resolve; });
    const body = new ReadableStream<Uint8Array>({
      async pull(controller) {
        await bodyGate;
        controller.enqueue(new TextEncoder().encode(JSON.stringify({ ping: "late" })));
        controller.close();
      },
    });
    const req = {
      headers: new Headers({ "x-forwarded-for": "10.21.1.1" }),
      body,
    } as unknown as NextRequest;

    const pendingResponse = POST(req, { params: Promise.resolve({ token }) });
    await vi.waitFor(() => expect(dbSelectCount).toBe(1));

    // A resolução inicial apenas confirma a existência da sessão; o segredo é
    // relido após o upload antes de verificar/ingerir a requisição.
    mockSession = { ...mockSession, webhook_secret_encrypted: "rotated-secret" };
    verifyExpectedSecret = "decrypted-rotated-secret";
    releaseBody();

    const response = await pendingResponse;
    expect(response.status).toBe(200);
    expect(dbSelectCount).toBe(2);
    expect(verifyCallCount).toBe(1);

    mockSession = { ...mockSession, webhook_secret_encrypted: "encrypted-secret" };
  });

  it("limite cheio rejeita novas assinaturas inválidas, mas deixa passar um webhook válido", async () => {
    const token = "token-saturated-failures";
    setAtomicSignatureFailureDriverForTest(async () => 11, async () => 10);

    const validReq = new NextRequest(`http://localhost/api/v1/webhooks/channel/${token}`, {
      method: "POST",
      body: JSON.stringify({ ping: "valid" }),
    });
    const validRes = await POST(validReq, { params: Promise.resolve({ token }) });
    expect(validRes.status).toBe(200);
    expect(capturedFiles).toHaveLength(1);

    verifySignatureResult = false;
    const invalidReq = new NextRequest(`http://localhost/api/v1/webhooks/channel/${token}`, {
      method: "POST",
      body: JSON.stringify({ ping: "forged" }),
    });
    const invalidRes = await POST(invalidReq, { params: Promise.resolve({ token }) });
    expect(invalidRes.status).toBe(429);
    expect(capturedFiles).toHaveLength(1);
  });

  // ─── Achado 4: Limite Atômico Distribuído Sem Mutex Local e Janela Móvel ────
  it("concorrência distribuída real: duas instâncias separadas (sem mutex) limitam 15 falhas a exatamente 10 permitidas e 5 negadas", async () => {
    const token = "token-shared-cluster-" + Math.random().toString(36).slice(2);
    const sharedClusterCounter = { val: 0 };

    // Driver compartilhado simulando Redis distribuído entre Instância A e Instância B
    setAtomicSignatureFailureDriverForTest(async () => {
      sharedClusterCounter.val++;
      return sharedClusterCounter.val;
    });

    // Chamadas diretas ao limitador atômico por duas "instâncias" sem passar pelo mutex local
    const clientA = Array.from({ length: 8 }).map(() =>
      recordSignatureFailureAtomic(token, { limit: 10, windowSec: 600 })
    );
    const clientB = Array.from({ length: 7 }).map(() =>
      recordSignatureFailureAtomic(token, { limit: 10, windowSec: 600 })
    );

    const allDecisions = await Promise.all([...clientA, ...clientB]);
    const allowed = allDecisions.filter((d) => d.allowed);
    const rejected = allDecisions.filter((d) => !d.allowed);

    expect(allowed.length).toBe(10);
    expect(rejected.length).toBe(5);
  });

  it("janela móvel atômica: expira falhas antigas após 600s evitando rajada dupla em fronteira de janela", async () => {
    // Simula janela deslizante em memória modelando a lógica do script Lua
    const windowStore: number[] = [];
    setAtomicSignatureFailureDriverForTest(async (_key, limit, windowSec, nowMs) => {
      const now = nowMs ?? Date.now();
      const cutoff = now - windowSec * 1000;
      // Remove eventos com timestamp < cutoff
      while (windowStore.length > 0 && windowStore[0]! <= cutoff) {
        windowStore.shift();
      }
      if (windowStore.length < limit) {
        windowStore.push(now);
        return windowStore.length;
      }
      return windowStore.length + 1;
    });

    const token = "token-sliding-window-" + Math.random().toString(36).slice(2);
    const t0 = 1700000000000;

    // Registra 10 falhas em t0 usando o clock de teste sobre o driver de janela.
    for (let i = 0; i < 10; i++) {
      __setSignatureRateLimitClockForTest(t0);
      const res = await recordSignatureFailureAtomic(token, { limit: 10, windowSec: 600 });
      expect(res.allowed).toBe(true);
    }

    // 11ª falha ainda em t0 + 20s deve ser rejeitada
    __setSignatureRateLimitClockForTest(t0 + 20_000);
    const blockedAtT0 = await recordSignatureFailureAtomic(token, { limit: 10, windowSec: 600 });
    expect(blockedAtT0.allowed).toBe(false);

    // Após 601 segundos, a primeira falha escorregou para fora da janela deslizante -> 1 falha nova é permitida
    __setSignatureRateLimitClockForTest(t0 + 601_000);
    const allowedAfterWindow = await recordSignatureFailureAtomic(token, { limit: 10, windowSec: 600 });
    expect(allowedAfterWindow.allowed).toBe(true);
    __setSignatureRateLimitClockForTest(null);
  });

  it("fail-closed em indisponibilidade do Redis: retorna 503 com Retry-After e não grava auditoria", async () => {
    const token = "token-redis-down-" + Math.random().toString(36).slice(2);
    verifySignatureResult = false; // Assinatura inválida

    setAtomicSignatureFailureDriverForTest(async () => {
      throw new Error("Redis ECONNREFUSED");
    }, async () => 0);

    const req = new NextRequest(`http://localhost/api/v1/webhooks/channel/${token}`, {
      method: "POST",
      headers: { "x-forwarded-for": "10.30.1.1" },
      body: JSON.stringify({ bad: true }),
    });

    const res = await POST(req, { params: Promise.resolve({ token }) });

    // Status 503 coerente com infraestrutura indisponível
    expect(res.status).toBe(503);
    expect(res.headers.get("retry-after")).toBe("30");
    // Não gravou auditoria inválida no banco de dados
    expect(capturedFiles.length).toBe(0);
  });

  it("falha fechada antes do corpo e do Postgres se o Redis distribuído estiver indisponível", async () => {
    const token = "token-peek-redis-down-" + Math.random().toString(36).slice(2);
    setAtomicSignatureFailureDriverForTest(async () => 0, async () => {
      throw new Error(`Redis GET failed for webhook_sig_fail_zset:${token}`);
    });

    const req = new NextRequest(`http://localhost/api/v1/webhooks/channel/${token}`, {
      method: "POST",
      headers: { "x-forwarded-for": "10.30.1.2" },
      body: JSON.stringify({ ping: true }),
    });
    const res = await POST(req, { params: Promise.resolve({ token }) });

    expect(res.status).toBe(503);
    expect(res.headers.get("retry-after")).toBe("30");
    expect(req.bodyUsed).toBe(false);
    expect(dbSelectCount).toBe(0);
    expect(capturedFiles).toHaveLength(0);
  });

  // ─── Achado 5: Invalidação Real e Resposta HTTP 503 de Sobrecarga ────────────
  it("sobrecarga do semáforo: requisição HTTP recebe 503 com Retry-After: 5 e chamada seguinte recupera", async () => {
    delayDbMs = 50;
    const tokenBase = "token-http-overload-";

    // Dispara 310 requisições simultâneas via POST para saturar os 100 slots + 200 de fila do semáforo
    // Cada requisição usa IP próprio para testar estritamente a sobrecarga do semáforo de sessão
    const promises = Array.from({ length: 310 }).map((_, i) => {
      const simulatedIp = `10.40.${Math.floor(i / 50)}.${(i % 50) + 1}`;
      const req = new NextRequest(`http://localhost/api/v1/webhooks/channel/${tokenBase}${i}`, {
        method: "POST",
        headers: { "x-forwarded-for": simulatedIp },
        body: JSON.stringify({ ping: i }),
      });
      return POST(req, { params: Promise.resolve({ token: `${tokenBase}${i}` }) });
    });

    const responses = await Promise.all(promises);
    const statuses = responses.map((r) => r.status);
    const count503 = statuses.filter((s) => s === 503).length;

    // As requisições que excederam a capacidade receberam 503 controlado
    expect(count503).toBeGreaterThanOrEqual(10);
    const sample503 = responses.find((r) => r.status === 503);
    expect(sample503?.headers.get("retry-after")).toBe("5");

    // Limpa latência do mock para provar recuperação
    delayDbMs = 0;
    const recoveryToken = "token-recovered-" + Math.random().toString(36).slice(2);
    const reqRecovery = new NextRequest(`http://localhost/api/v1/webhooks/channel/${recoveryToken}`, {
      method: "POST",
      headers: { "x-forwarded-for": "10.40.1.1" },
      body: JSON.stringify({ ping: "ok" }),
    });
    const resRecovery = await POST(reqRecovery, { params: Promise.resolve({ token: recoveryToken }) });
    expect(resRecovery.status).toBe(200);
  });

  it("não retém sessões ou segredos entre requisições, mesmo com muitos tokens distintos", async () => {
    for (let i = 0; i < 600; i++) {
      const token = `token-dynamic-${i}`;
      await resolveSessionForToken(token);
    }

    expect(dbSelectCount).toBe(600);
    expect(_getWebhookSessionCacheSizeForTest()).toBe(0);
    expect(_getSessionToTokenSizeForTest()).toBe(0);
    expect(_getTokenEpochsSizeForTest()).toBe(0);
    expect(_getWebhookInFlightSizeForTest()).toBe(0);
  });

  it("revogação em outra instância vale no próximo request sem depender de invalidação local", async () => {
    const oldToken = "email-token-subst-" + Math.random().toString(36).slice(2);

    // 1. Resolve sessão na primeira instância simulada.
    const req1 = new NextRequest(`http://localhost/api/v1/webhooks/channel/${oldToken}`, {
      method: "POST",
      headers: { "x-forwarded-for": "10.50.1.1" },
      body: JSON.stringify({ ping: 1 }),
    });
    const res1 = await POST(req1, { params: Promise.resolve({ token: oldToken }) });
    expect(res1.status).toBe(200);

    // Simula uma mutação em outra instância do app, sem depender de mapas locais.
    mockSession = { ...mockSession, archived_at: new Date().toISOString() };

    // A próxima requisição lê o estado atual do Postgres e ignora o canal arquivado.
    const req2 = new NextRequest(`http://localhost/api/v1/webhooks/channel/${oldToken}`, {
      method: "POST",
      headers: { "x-forwarded-for": "10.50.1.1" },
      body: JSON.stringify({ ping: 2 }),
    });
    const res2 = await POST(req2, { params: Promise.resolve({ token: oldToken }) });
    expect(res2.status).toBe(200);
    const json = await res2.json();
    const data = json.data ?? json;
    expect(data.status).toBe("ignored");
    expect(data.reason).toBe("canal_arquivado");
    expect(dbSelectCount).toBe(3);

    // Restaura
    mockSession = { ...mockSession, archived_at: null };
  });

  // ─── Validações Complementares de Borda ─────────────────────────────────────
  it("rejeita tokens curtos com 404 sem tocar no banco", async () => {
    const req = new NextRequest("http://localhost/api/v1/webhooks/channel/short", {
      method: "POST",
      body: JSON.stringify({ ok: true }),
    });
    const res = await POST(req, { params: Promise.resolve({ token: "short" }) });
    expect(res.status).toBe(404);
  });

  it("token desconhecido não consome o corpo e erro de consulta não é mascarado como 404", async () => {
    const unknownToken = "unknown-token-valid-length";
    const unknownReq = new NextRequest(`http://localhost/api/v1/webhooks/channel/${unknownToken}`, {
      method: "POST",
      body: JSON.stringify({ ping: true }),
    });
    const unknownRes = await POST(unknownReq, { params: Promise.resolve({ token: unknownToken }) });
    expect(unknownRes.status).toBe(404);
    expect(unknownReq.bodyUsed).toBe(false);
    expect(dbSelectCount).toBe(1);

    dbSelectCount = 0;
    dbSelectError = { code: "08006", message: "database connection failed" };
    const failingToken = "token-database-error";
    const failingReq = new NextRequest(`http://localhost/api/v1/webhooks/channel/${failingToken}`, {
      method: "POST",
      body: JSON.stringify({ ping: true }),
    });
    const failingRes = await POST(failingReq, { params: Promise.resolve({ token: failingToken }) });
    expect(failingRes.status).toBe(500);
    expect(await failingRes.json()).toMatchObject({ error: { message: "webhook_session_lookup_failed" } });
    expect(failingReq.bodyUsed).toBe(false);
    expect(capturedFiles).toHaveLength(0);
  });

  it("rejeita payload acima de 256KB com 413 sem tocar no banco", async () => {
    const largeBody = "x".repeat(257 * 1024);
    const req = new NextRequest("http://localhost/api/v1/webhooks/channel/valid-long-token-1234", {
      method: "POST",
      headers: { "content-length": String(largeBody.length) },
      body: largeBody,
    });
    const res = await POST(req, { params: Promise.resolve({ token: "valid-long-token-1234" }) });
    expect(res.status).toBe(413);
  });

  // ─── Achado 6: Prova Criptográfica Interna vs Forja Externa ───────────────
  it("fronteira interna: prova só é emitida após HMAC válido e fica vinculada ao segredo", async () => {
    const { verifyAndCreateInternalSignatureProof, handleInboundWebhook } = await vi.importActual<typeof InboundModule>("@/lib/channels/inbound");
    const sessionId = "session-proof-test-123";
    const provider = "datafy";
    const secret = "whsec_prova_interna_segura";
    const timestamp = "1700000000";
    const payload = JSON.stringify({ message: "teste_prova" });
    const signature = (await import("node:crypto")).createHmac("sha256", secret)
      .update(`${timestamp}.${payload}`)
      .digest("hex");
    const headers = new Headers({
      "x-datafy-timestamp": timestamp,
      "x-datafy-signature-256": `sha256=${signature}`,
    });

    const originalDatafyEnabled = process.env.DATAFY_ENABLED;
    process.env.DATAFY_ENABLED = "true";
    try {
      const verification = verifyAndCreateInternalSignatureProof(sessionId, provider, payload, headers, secret);
      expect(verification.valid).toBe(true);
      if (!verification.valid) throw new Error("expected signature to verify");
      expect(verification.proof).toHaveLength(64);

      const tamperedPayload = verifyAndCreateInternalSignatureProof(
        sessionId,
        provider,
        `${payload} `,
        headers,
        secret,
      );
      expect(tamperedPayload).toEqual({ valid: false, proof: null });

      // A proof captured for the real secret cannot bypass verification if the
      // session credential changes before the handler receives it.
      const result = await handleInboundWebhook({} as never, {
        session: { id: sessionId, organization_id: "org-proof", provider },
        rawBody: payload,
        headers,
        secret: `${secret}-rotated`,
        internalSignatureProof: verification.proof,
      });
      expect(result).toMatchObject({ ok: false, code: "unauthorized" });
    } finally {
      if (originalDatafyEnabled === undefined) delete process.env.DATAFY_ENABLED;
      else process.env.DATAFY_ENABLED = originalDatafyEnabled;
    }
  });

  it("handler direto recusa Telegram sem segredo, mesmo sem passar pela rota HTTP", async () => {
    const { handleInboundWebhook } = await vi.importActual<typeof InboundModule>("@/lib/channels/inbound");
    const result = await handleInboundWebhook({} as never, {
      session: { id: "telegram-session", organization_id: "org-telegram", provider: "telegram" },
      rawBody: JSON.stringify({ update_id: 1, message: { message_id: 2 } }),
      headers: new Headers(),
      secret: null,
    });

    expect(result).toMatchObject({ ok: false, code: "unauthorized", message: "bad_signature" });
  });
});
