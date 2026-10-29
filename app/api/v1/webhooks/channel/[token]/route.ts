/**
 * POST /api/v1/webhooks/channel/[token] — entrada por token, para qualquer canal.
 *
 * ─── Por que o caminho NÃO cita o canal ─────────────────────────────────────
 *
 * A família de rotas do canal por QR carrega o nome do provider na URL, e está
 * na lista de dívida do `lint:channels` por isso — sair de lá exigiria mudar
 * uma URL que já está configurada em instalação de gente. Uma rota NOVA não
 * precisa nascer devendo: o token identifica a sessão, a sessão diz qual é o
 * canal, e o caminho fica neutro. Canal seguinte entra sem uma quarta família
 * de URLs.
 *
 * ─── Por que esta rota é tão curta ──────────────────────────────────────────
 *
 * Ela não interpreta o payload nem conhece o algoritmo de assinatura. Resolve
 * o token e decifra o segredo; a verificação neutra fica em `inbound.ts`, onde
 * cada provider conhece seu próprio formato. Uma prova interna só é emitida
 * após a verificação criptográfica e evita recalcular a assinatura no handler.
 *
 * ─── O 200 que evita a tempestade ──────────────────────────────────────────
 *
 * Evento que não interessa (outro tipo, eco do nosso próprio envio, outra
 * plataforma) responde 200, não 4xx: o provider reentrega o que não recebeu
 * 200, e recusar um payload que nunca vai servir faria a reentrega durar para
 * sempre. 500 fica reservado para falha de ESCRITA — aí a reentrega é o que
 * queremos, porque o evento era bom e nós é que não gravamos.
 */
import { createHash, randomUUID } from "node:crypto";
import { logger } from "@/lib/logger";
import { NextResponse, type NextRequest } from "next/server";

import { fail, ok } from "@/lib/api/wrappers";
import { appDaMeta } from "@/lib/channels/meta/app";
import { abrirArquivoDoWebhook, fecharArquivoDoWebhook } from "@/lib/channels/arquivo-de-webhook";
import {
  acceptsInboundWebhook,
  handleInboundWebhook,
  verifyAndCreateInternalSignatureProof,
  inboundPayloadBelongsToSession,
} from "@/lib/channels/inbound";
import {
  resolveSessionForToken,
  withTokenLock,
  invalidateWebhookSessionCache,
  invalidateWebhookCacheBySessionId,
  _clearWebhookSessionCacheForTest,
  _getWebhookSessionCacheSizeForTest,
  _getWebhookInFlightSizeForTest,
  _getActiveResolutionsForTest,
  _getWaitQueueLengthForTest,
  _getTokenEpochForTest,
  _getSessionToTokenSizeForTest,
  _getTokenEpochsSizeForTest,
} from "@/lib/channels/webhook-session-cache";
import {
  recordSignatureFailureAtomic,
  peekSignatureFailureLimitReached,
} from "@/lib/channels/webhook-signature-rate-limit";
import { resolveClientIp } from "@/lib/channels/webhook-ip";
import { createAdminClient } from "@/lib/supabase/admin";
import { checkRateLimit } from "@/lib/ai/dispatcher/rate-limit";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export {
  invalidateWebhookSessionCache,
  invalidateWebhookCacheBySessionId,
  _clearWebhookSessionCacheForTest,
  _getWebhookSessionCacheSizeForTest,
  _getWebhookInFlightSizeForTest,
  _getActiveResolutionsForTest,
  _getWaitQueueLengthForTest,
  _getTokenEpochForTest,
  _getSessionToTokenSizeForTest,
  _getTokenEpochsSizeForTest,
};

/**
 * Meta webhook verification handshake for a native Instagram session.
 * The path token resolves the active Instagram tenant/session; the installation
 * Meta verify token authenticates the handshake, matching the native Meta
 * webhook contract. Other channel sessions never receive a challenge here.
 */
export async function GET(
  req: NextRequest,
  ctx: { params: Promise<{ token: string }> },
): Promise<Response> {
  const { token } = await ctx.params;
  const query = req.nextUrl.searchParams;
  const challenge = query.get("hub.challenge");

  if (!token || token.length < 8) return new NextResponse("not found", { status: 404 });

  try {
    const { sessao } = await resolveSessionForToken(token, { includeSecret: false });
    if (!sessao || sessao.archived_at || sessao.provider !== "instagram") {
      return new NextResponse("not found", { status: 404 });
    }
  } catch {
    return new NextResponse("temporarily unavailable", { status: 503 });
  }

  // A configuração nativa usa o mesmo verify token da aplicação Meta que o
  // handshake oficial do WhatsApp. O path token resolve a sessão/tenant; ele
  // não substitui a credencial `META_WEBHOOK_VERIFY_TOKEN` do protocolo Meta.
  const { verifyToken } = await appDaMeta();
  if (
    query.get("hub.mode") !== "subscribe" ||
    !verifyToken ||
    query.get("hub.verify_token") !== verifyToken ||
    challenge === null
  ) {
    return new NextResponse("forbidden", { status: 403 });
  }

  return new NextResponse(challenge, {
    status: 200,
    headers: {
      "content-type": "text/plain",
      "cache-control": "no-store",
    },
  });
}

export async function POST(
  req: NextRequest,
  ctx: { params: Promise<{ token: string }> },
): Promise<Response> {
  const requestId = randomUUID();
  const { token } = await ctx.params;

  // Token curto nunca foi emitido por nós. 404 e não 401: quem varre URLs não
  // precisa saber que a rota existe.
  if (!token || token.length < 8) {
    return fail("not_found", "unknown webhook token", 404, { requestId });
  }

  // ─── 1. Proteção Preventiva ANTES de Consumir o Stream do Corpo ─────────────

  // A. Resolução de IP confiável com base na topologia do repositório (Caddy/Traefik).
  // Se o IP não puder ser confiavelmente determinado, NÃO agrupamos em um balde comum
  // "unknown_ip" para evitar DoS coletivo de outros clientes legítimos.
  const clientIp = resolveClientIp(req.headers);
  if (clientIp) {
    const ipHash = createHash("sha256").update(clientIp).digest("hex").slice(0, 16);
    const ipRl = await checkRateLimit(`webhook_ip:${ipHash}`, 120, 60);
    if (!ipRl.allowed) {
      return fail("rate_limited", "Too many requests from this IP.", 429, {
        requestId,
        headers: { "Retry-After": "60" },
      });
    }
  }

  // B. Rate limit geral por token de canal (60 req/min) — defesa mandatória por sessão
  const tokenBucketHash = createHash("sha256").update(token).digest("hex");
  const tokenRl = await checkRateLimit(`webhook_channel:${tokenBucketHash}`, 60, 60);
  if (!tokenRl.allowed) {
    return fail("rate_limited", "Too many requests.", 429, {
      requestId,
      headers: { "Retry-After": "60" },
    });
  }

  // C. Confirma que o contador distribuído está acessível antes do corpo e do Postgres.
  // O teto só é aplicado DEPOIS da verificação criptográfica. Bloquear aqui quando
  // o contador está cheio também derrubaria callbacks legítimos e permitiria a
  // qualquer portador do token causar indisponibilidade com dez assinaturas falsas.
  const signatureFailurePeek = await peekSignatureFailureLimitReached(token, {
    limit: 10,
    windowSec: 600,
  });
  if (signatureFailurePeek.redisUnavailable) {
    // Sem o contador distribuído não é possível impor o teto entre réplicas.
    // Webhooks recebem 503 para que o provider tente de novo; corpo e Postgres
    // permanecem intocados até o rate limiter voltar.
    return fail(
      "service_unavailable",
      "Serviço de verificação temporariamente indisponível. Tente novamente.",
      503,
      {
        requestId,
        headers: { "Retry-After": "30" },
      },
    );
  }
  // D. Teto preventivo de Content-Length (256KB)
  const MAX_WEBHOOK_PAYLOAD_BYTES = 256 * 1024;
  const contentLength = req.headers.get("content-length");
  if (contentLength) {
    const parsed = parseInt(contentLength, 10);
    if (!Number.isNaN(parsed) && parsed > MAX_WEBHOOK_PAYLOAD_BYTES) {
      return fail("payload_too_large", "payload exceeds limit", 413, { requestId });
    }
  }

  // ─── 2. Resolução do token antes de consumir o corpo ────────────────────────
  // Tokens desconhecidos, arquivados ou de providers incompatíveis não podem
  // forçar leitura/alocação do payload. Consultas simultâneas compartilham a
  // resolução em voo, sem manter segredo em cache depois dela.
  try {
    let sessionResult;
    try {
      sessionResult = await resolveSessionForToken(token, { includeSecret: false });
    } catch (err) {
      if (err instanceof Error && err.message === "webhook_session_cache_overloaded") {
        return fail(
          "service_unavailable",
          "Serviço temporariamente sobrecarregado. Tente novamente em instantes.",
          503,
          {
            requestId,
            headers: { "Retry-After": "5" },
          },
        );
      }
      throw err;
    }

    const initialSession = sessionResult.sessao;

    if (!initialSession) return fail("not_found", "unknown webhook token", 404, { requestId });

    // Canal arquivado não ingere: o usuário mandou excluí-lo, e aceitar evento em
    // voo ressuscitaria a conversa no inbox com o operador sem poder responder.
    if (initialSession.archived_at) {
      return ok({ status: "ignored", reason: "canal_arquivado" }, { requestId });
    }

    if (!acceptsInboundWebhook(initialSession.provider)) {
      return fail("invalid_request", "provider_mismatch", 400, { requestId });
    }

    // ─── 3. Leitura Segura do Stream do Corpo com Teto Rígido (256KB) ─────────
    let rawBody = "";
    if (req.body) {
      const reader = req.body.getReader();
      const decoder = new TextDecoder();
      let totalBytes = 0;
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        totalBytes += value.byteLength;
        if (totalBytes > MAX_WEBHOOK_PAYLOAD_BYTES) {
          await reader.cancel();
          return fail("payload_too_large", "payload exceeds limit", 413, { requestId });
        }
        rawBody += decoder.decode(value, { stream: true });
      }
      rawBody += decoder.decode();
    } else {
      rawBody = await req.text();
      if (Buffer.byteLength(rawBody, "utf8") > MAX_WEBHOOK_PAYLOAD_BYTES) {
        return fail("payload_too_large", "payload exceeds limit", 413, { requestId });
      }
    }

    // ─── 4. Execução Serializada Local ────────────────────────────────────────
    return await withTokenLock(token, async () => {
      // Atualiza sessão e segredo DEPOIS do upload e imediatamente após obter o
      // lock local. Uma requisição lenta iniciada antes da rotação não pode
      // concluir usando o segredo antigo capturado no começo do stream.
      const currentSessionResult = await resolveSessionForToken(token);
      const { sessao, secret } = currentSessionResult;
      if (!sessao) return fail("not_found", "unknown webhook token", 404, { requestId });
      if (sessao.archived_at) {
        return ok({ status: "ignored", reason: "canal_arquivado" }, { requestId });
      }
      if (!acceptsInboundWebhook(sessao.provider)) {
        return fail("invalid_request", "provider_mismatch", 400, { requestId });
      }

      // ─── 5. Decisão Atômica Distribuída ANTES de Persistir Auditoria ─────────
      // A assinatura é calculada UMA ÚNICA VEZ por requisição e o resultado é reutilizado.
      // Requisições válidas NUNCA consomem o orçamento de falhas.
      // Se a assinatura for inválida, a decisão atômica compartilhada (Redis / fail-closed)
      // decide se a requisição está dentro da cota de 10 tentativas aceitas.
      // Se a cota foi estourada, encerra com 429 IMEDIATAMENTE sem abrir arquivo no banco.
      // Se o Redis estiver indisponível (fail-closed), retorna 503 com Retry-After: 30 para
      // não sobrecarregar o banco com gravações não coordenadas e sinalizar indisponibilidade de infraestrutura.
      const signatureVerification = verifyAndCreateInternalSignatureProof(
        sessao.id,
        sessao.provider,
        rawBody,
        req.headers,
        secret,
      );
      if (!signatureVerification.valid) {
        const sigDecision = await recordSignatureFailureAtomic(token, {
          limit: 10,
          windowSec: 600,
        });
        if (!sigDecision.allowed) {
          if (sigDecision.redisUnavailable) {
            return fail(
              "service_unavailable",
              "Serviço de verificação temporariamente indisponível. Tente novamente.",
              503,
              {
                requestId,
                headers: { "Retry-After": "30" },
              },
            );
          }
          return fail("rate_limited", "Too many invalid signature attempts.", 429, {
            requestId,
            headers: { "Retry-After": "600" },
          });
        }
      }

      // ─── 6. Rastreabilidade Canônica e Arquivo de Auditoria ───────────────────
      // O arquivo só é aberto para requisições válidas ou falhas autorizadas na cota de 10.
      const admin = createAdminClient();
      const arquivo = await abrirArquivoDoWebhook(admin, {
        organizationId: sessao.organization_id,
        channelSessionId: sessao.id,
        provider: sessao.provider,
        rawBody,
        headers: req.headers,
      });

      // A etapa 5 fez a verificação. Não há bypass por flag booleana: somente
      // uma prova interna vinculada a esta sessão, corpo, headers e segredo entra no handler.
      if (!signatureVerification.valid) {
        await fecharArquivoDoWebhook(admin, arquivo, {
          status: "error",
          validSignature: false,
          erro: "bad_signature",
        });
        logger.warn("[webhook-canal] assinatura recusada", {
          organization_id: sessao.organization_id,
          channel_session_id: sessao.id,
          provider: sessao.provider,
          request_id: requestId,
        });
        return fail("unauthorized", "bad_signature", 401, { requestId });
      }

      if (
        !(await inboundPayloadBelongsToSession(admin, {
          session: sessao,
          rawBody,
          headers: req.headers,
          secret,
        }))
      ) {
        // Assinatura BOA, conta errada: `validSignature: true` de propósito. Marcar
        // `false` aqui mandaria quem investiga procurar um problema de segredo que
        // não existe — o segredo está certo, o evento é que é de outra conta.
        await fecharArquivoDoWebhook(admin, arquivo, {
          status: "error",
          validSignature: true,
          erro: "evento_de_outra_conta",
        });
        return ok({ status: "ignored", reason: "evento_de_outra_conta" }, { requestId });
      }

      try {
        const r = await handleInboundWebhook(admin, {
          session: sessao,
          rawBody,
          headers: req.headers,
          secret,
          internalSignatureProof: signatureVerification.proof,
        });

        if (r.ok) {
          await fecharArquivoDoWebhook(admin, arquivo, {
            status: "processed",
            validSignature: true,
            erro: typeof r.body.reason === "string" ? r.body.reason : null,
          });
          return ok(r.body, { requestId });
        }

        const status = r.code === "unauthorized" ? 401 : r.code === "retryable_failure" ? 503 : 400;
        await fecharArquivoDoWebhook(admin, arquivo, {
          status: "error",
          validSignature: r.code === "unauthorized" ? false : null,
          erro: r.message,
        });
        return fail(
          r.code === "unauthorized"
            ? "unauthorized"
            : r.code === "retryable_failure"
              ? "service_unavailable"
              : "invalid_request",
          r.message,
          status,
          { requestId, ...(r.code === "retryable_failure" ? { headers: { "Retry-After": "5" } } : {}) },
        );
      } catch (err) {
        const detalhe = err instanceof Error ? err.message : "ingest_failed";
        await fecharArquivoDoWebhook(admin, arquivo, {
          status: "error",
          validSignature: null,
          erro: detalhe,
        });
        return fail("internal_error", detalhe, 500, { requestId });
      }
    });
  } catch (err) {
    if (err instanceof Error && err.message === "webhook_session_cache_overloaded") {
      return NextResponse.json(
        {
          error: {
            code: "service_unavailable",
            message: "Serviço temporariamente sobrecarregado. Tente novamente em instantes.",
          },
        },
        { status: 503, headers: { "Retry-After": "5", "X-Request-Id": requestId } },
      );
    }
    const detalhe = err instanceof Error ? err.message : "internal_error";
    return NextResponse.json(
      { error: { code: "internal_error", message: detalhe } },
      { status: 500, headers: { "X-Request-Id": requestId } },
    );
  }
}
