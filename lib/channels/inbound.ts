import { ingestSocialInbound, socialPayloadBelongsToSession } from "./social/ingest";
import { CHANNEL_PROVIDER_SOCIAL } from "./capabilities";
/**
 * Entrada de webhook, do lado de dentro do seam.
 *
 * A rota não pode saber QUAL canal é — o invariante 1 da doutrina proíbe, e o
 * `lint:channels` reprovou a primeira versão desta rota exatamente por isso,
 * que é a catraca funcionando. Então a rota entrega o que sabe (a sessão, o
 * corpo cru, o header de assinatura) e recebe um desfecho; toda a decisão
 * específica de canal mora aqui.
 *
 * Um canal seguinte entra com um `case` neste arquivo e zero linhas na rota.
 *
 * ─── Por que a assinatura é verificada AQUI, e não na rota ──────────────────
 *
 * Porque o esquema é do canal: header, algoritmo e formato mudam por provider
 * (um assina SHA-512 com um nome de header, outro SHA-256 com outro). Uma rota
 * que verificasse teria que perguntar de quem é o payload — o `if (provider ===
 * ...)` que a doutrina existe para impedir.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

import {
  CHANNEL_PROVIDER_DATAFY,
  CHANNEL_PROVIDER_EMAIL,
  CHANNEL_PROVIDER_INSTAGRAM,
  CHANNEL_PROVIDER_TELEGRAM,
  CHANNEL_PROVIDER_TIKTOK,
  CHANNEL_PROVIDER_ZERNIO,
} from "./capabilities";
import { ingestTelegramInbound } from "./telegram/ingest";
import { ingestEmailInbound, type EmailInboundPayload } from "./email/ingest";
import { ingestInstagramWebhook } from "./instagram/ingest";
import type { InstagramWebhookPayload } from "./instagram/types";
import { ingestTikTokWebhook } from "./tiktok/ingest";
import { verifyTikTokSignature } from "./tiktok/webhook";
import type { TikTokWebhookPayload } from "./tiktok/types";
import { canalGraphParceiroLigado } from "./graph-parceiro/credentials";
import { graphPartnerRefsDaSessao } from "./graph-parceiro/session";
import {
  HEADER_ASSINATURA,
  HEADER_TIMESTAMP,
  verifyGraphPartnerSignature,
} from "./graph-parceiro/webhook";
import { sincronizarSaudeDaConexao } from "./health";
import { lerEnvelopeMeta } from "./meta/envelope";
import { ingestMetaEcho, ingestMetaInbound } from "./meta/ingest";
import { parseMetaWebhook } from "./meta/webhook";
import { samePhone } from "./phone-variants";
import {
  atualizarEspelhoDoTemplate,
  avisoDoEvento,
  registrarAviso,
  saudeDoEvento,
} from "./zernio/avisos";
import { aplicarEdicaoZernio, ingestZernioInbound } from "./zernio/ingest";
import { lerEnvelopeZernio } from "./zernio/envelope";
import { parseZernioEdicao, verifyZernioSignature } from "./zernio/webhook";
import { verifyMetaSignature } from "./meta/webhook";
import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import type { ChannelProvider } from "./types";

/** Segredo efêmero usado para atestar uma verificação externa concluída neste processo. */
const INTERNAL_PROOF_KEY = randomBytes(32);

function internalProofPayload(
  sessionId: string,
  provider: string,
  rawBody: string,
  headers: Headers,
  secret: string | null,
): string {
  const entries: Array<[string, string]> = [];
  headers.forEach((value, key) => entries.push([key, value]));
  entries.sort(([a], [b]) => a.localeCompare(b));
  const secretDigest = secret === null ? null : createHash("sha256").update(secret).digest("hex");
  return JSON.stringify([sessionId, provider, rawBody, entries, secretDigest]);
}

function createInternalSignatureProof(
  sessionId: string,
  provider: string,
  rawBody: string,
  headers: Headers,
  secret: string | null,
): string {
  return createHmac("sha256", INTERNAL_PROOF_KEY)
    .update(internalProofPayload(sessionId, provider, rawBody, headers, secret))
    .digest("hex");
}

function verifyInternalSignatureProof(
  sessionId: string,
  provider: string,
  rawBody: string,
  headers: Headers,
  secret: string | null,
  proof?: string | null,
): boolean {
  if (!proof || typeof proof !== "string") return false;
  const expected = createInternalSignatureProof(sessionId, provider, rawBody, headers, secret);
  const proofBytes = Buffer.from(proof, "utf8");
  const expectedBytes = Buffer.from(expected, "utf8");
  if (proofBytes.length !== expectedBytes.length) return false;
  return timingSafeEqual(proofBytes, expectedBytes);
}

/** Curto demais para ser segredo — placeholder ou lixo de decrypt. */
const MIN_SECRET_LEN = 16;

export interface InboundWebhookInput {
  session: {
    id: string;
    organization_id: string;
    provider: string;
    /** Como o operador chama esta conexão. Entra no título do aviso: com dois
     *  números ligados, "WhatsApp fora do ar" não diz QUAL. */
    display_name?: string | null;
    phone_number?: string | null;
  };
  rawBody: string;
  /** Todos os headers da requisição — cada canal lê o SEU. */
  headers: Headers;
  /** Segredo já decifrado pela rota, ou null quando não foi possível. */
  secret: string | null;
  /** Prova interna emitida somente após verificar a assinatura externa. */
  internalSignatureProof?: string;
}

export type InboundWebhookOutcome =
  | { ok: true; body: Record<string, unknown> }
  | {
      ok: false;
      /**
       * `contrato_violado` é distinto de `invalid_json` de propósito: um diz
       * que o corpo não é JSON, o outro que é JSON com um campo do tipo errado.
       * Quem investiga procura em lugares diferentes, e o segundo significa que
       * o fio mudou — a única causa possível num payload que passou pelo HMAC.
       */
      code: "unauthorized" | "provider_mismatch" | "invalid_json" | "contrato_violado";
      message: string;
    };

/**
 * Este canal sabe receber webhook? Perguntado pela rota ANTES de qualquer
 * trabalho — e respondido sem nomear provider do lado de fora.
 */
export function acceptsInboundWebhook(provider: string): boolean {
  // O canal Datafy é opcional da instalação: desligado, a entrada dele não
  // existe — nem para quem tem o token de uma sessão gravada antes.
  if (provider === CHANNEL_PROVIDER_DATAFY) return canalGraphParceiroLigado();
  if (
    provider === CHANNEL_PROVIDER_TELEGRAM ||
    provider === CHANNEL_PROVIDER_EMAIL ||
    provider === CHANNEL_PROVIDER_INSTAGRAM ||
    provider === CHANNEL_PROVIDER_TIKTOK
  ) {
    return true;
  }
  return provider === CHANNEL_PROVIDER_ZERNIO || provider === CHANNEL_PROVIDER_SOCIAL;
}

/** Authenticate before archiving raw payloads. The handler repeats this guard for non-HTTP callers. */
export function verifyInboundWebhookSignature(
  provider: string,
  raw: string,
  headers: Headers,
  secret: string | null,
): boolean {
  if (!acceptsInboundWebhook(provider)) return false;
  if (provider === CHANNEL_PROVIDER_EMAIL) {
    if (!secret || secret.length < MIN_SECRET_LEN) return false;
    const headerSecret = headers.get("x-webhook-secret") || headers.get("x-email-secret") || headers.get("authorization")?.replace(/^Bearer\s+/i, "");
    return secretMatches(headerSecret, secret);
  }
  if (provider === CHANNEL_PROVIDER_INSTAGRAM) {
    const appSecret = secret || process.env.META_APP_SECRET;
    if (!appSecret || appSecret.length < MIN_SECRET_LEN) return false;
    const headerSig = headers.get("x-hub-signature-256");
    return verifyMetaSignature(raw, headerSig, appSecret);
  }
  if (provider === CHANNEL_PROVIDER_TIKTOK) {
    if (!secret || secret.length < MIN_SECRET_LEN) return false;
    const headerSig = headers.get("tiktok-signature") || headers.get("x-tiktok-signature") || headers.get("x-signature");
    return verifyTikTokSignature(raw, headerSig, secret);
  }
  if (!secret || secret.length < MIN_SECRET_LEN) return false;
  // Cada canal assina do seu jeito; o esquema do Datafy está em `graph-parceiro/webhook`.
  if (provider === CHANNEL_PROVIDER_DATAFY) {
    return verifyGraphPartnerSignature(raw, headers.get(HEADER_ASSINATURA), headers.get(HEADER_TIMESTAMP), secret);
  }
  if (provider === CHANNEL_PROVIDER_TELEGRAM) {
    const headerSecret = headers.get("x-telegram-bot-api-secret-token");
    return secretMatches(headerSecret, secret);
  }
  return verifyZernioSignature(raw, headers.get("x-zernio-signature"), secret);
}

function secretMatches(candidate: string | null | undefined, expected: string): boolean {
  if (typeof candidate !== "string") return false;
  const candidateBytes = Buffer.from(candidate, "utf8");
  const expectedBytes = Buffer.from(expected, "utf8");
  return candidateBytes.length === expectedBytes.length && timingSafeEqual(candidateBytes, expectedBytes);
}

/**
 * Confere a assinatura externa e, somente quando ela é válida, emite uma prova
 * interna vinculada à sessão, provider, corpo, headers e segredo usados.
 * Não há uma função pública que gere essa prova sem autenticar o webhook.
 */
export function verifyAndCreateInternalSignatureProof(
  sessionId: string,
  provider: string,
  rawBody: string,
  headers: Headers,
  secret: string | null,
): { valid: true; proof: string } | { valid: false; proof: null } {
  if (!verifyInboundWebhookSignature(provider, rawBody, headers, secret)) {
    return { valid: false, proof: null };
  }
  return {
    valid: true,
    proof: createInternalSignatureProof(sessionId, provider, rawBody, headers, secret),
  };
}

/**
 * O EVENTO É DESTA CONEXÃO?

 *
 * ─── O defeito, medido numa instalação real (23/09/2026) ─────────────────────
 *
 * Esta guarda existia só para o canal SOCIAL. Para o WhatsApp pelo provedor
 * intermediado ela devolvia `true` sem olhar nada — e o webhook do provedor NÃO
 * é por número: é por ESPAÇO DE TRABALHO. Um webhook recebe os eventos de TODAS
 * as contas daquela chave. Na instalação medida eram dez contas no mesmo espaço
 * (dois WhatsApp, e Facebook/Instagram/Meta Ads de três negócios diferentes).
 *
 * Resultado: a caixa de entrada de um número recebeu 33 mensagens de
 * boas-vindas de OUTRO negócio, enviadas por OUTRO número do mesmo espaço. O
 * dono viu na conversa clientes que não eram dele, e nada na tela explicava.
 *
 * O parser já lia a conta (`ZernioWebhookEvent.accountId`, com o comentário
 * "casa com channel_sessions.zernio_account_id") — só ninguém comparava.
 *
 * ─── Evento SEM conta: depende de quem é o evento ───────────────────────────
 *
 * Nem todo evento do provedor carrega a conta: os de número
 * (`whatsapp.number.*`) trazem só o objeto `number`, e recusá-los por isso
 * cegaria o vigia de canal. Esses passam aqui e são conferidos pelo NÚMERO em
 * `zernioInbound`.
 *
 * Já `message.*` e `whatsapp.template.*` trazem a conta SEMPRE, pela
 * documentação do provedor. Nesses, a ausência é anomalia, e anomalia não
 * entra: sem a conta não há como dizer de qual número o evento é, e ingerir
 * seria escolher por palpite a caixa de entrada.
 */
export async function inboundPayloadBelongsToSession(admin: SupabaseClient, input: InboundWebhookInput): Promise<boolean> {
  if (input.session.provider === CHANNEL_PROVIDER_SOCIAL) {
    return socialPayloadBelongsToSession(admin, input.session.organization_id, input.session.id, input.rawBody);
  }
  if (input.session.provider === CHANNEL_PROVIDER_ZERNIO) {
    const { evento, conta: contaDoEvento } = cabecalhoDoEventoZernio(input.rawBody);
    if (contaDoEvento === null) return !EVENTOS_QUE_SEMPRE_TRAZEM_CONTA.some((p) => evento?.startsWith(p));
    // A guarda busca a conta ELA MESMA, como a do canal social: a rota do
    // webhook é genérica, e `lint:channels` recusa nome de coluna de provedor
    // ali. Uma guarda que dependesse de a rota lembrar de trazer a coluna
    // devolveria `true` sem filtrar nada no dia em que ela esquecesse.
    const { data, error } = await admin
      .from("channel_sessions")
      .select("zernio_account_id")
      .eq("organization_id", input.session.organization_id)
      .eq("id", input.session.id)
      .maybeSingle();
    if (error) throw new Error("zernio_session_lookup_failed");
    const contaDaSessao = (data as { zernio_account_id?: string | null } | null)?.zernio_account_id ?? null;
    // Sessão sem conta RECUSA. Hoje este ramo não executa — a constraint
    // `channel_sessions_provider_ref_check` exige `zernio_account_id` nesta
    // sessão —, e é por isso que ele pode ser o fechado: se um dia a constraint
    // afrouxar, "não sei de quem é a sessão" não vira "aceito de qualquer conta".
    return contaDaSessao !== null && contaDoEvento === contaDaSessao;
  }
  return true;
}

/** Prefixos de evento que o provedor documenta como SEMPRE trazendo a conta. */
const EVENTOS_QUE_SEMPRE_TRAZEM_CONTA = ["message.", "whatsapp.template."];

/** A conta que o provedor diz ter originado o evento — os mesmos três lugares que o parser lê. */
export function contaDoEventoZernio(rawBody: string): string | null {
  return cabecalhoDoEventoZernio(rawBody).conta;
}

function cabecalhoDoEventoZernio(rawBody: string): { evento: string | null; conta: string | null } {
  let p: unknown;
  try {
    p = JSON.parse(rawBody);
  } catch {
    return { evento: null, conta: null };
  }
  if (!p || typeof p !== "object") return { evento: null, conta: null };
  const o = p as Record<string, unknown>;
  const conta = o.account && typeof o.account === "object" ? (o.account as Record<string, unknown>) : null;
  const valor = conta?.id ?? conta?.accountId ?? o.accountId;
  return {
    evento: typeof o.event === "string" ? o.event : null,
    conta: typeof valor === "string" && valor.length > 0 ? valor : null,
  };
}

export async function handleInboundWebhook(
  admin: SupabaseClient,
  input: InboundWebhookInput,
): Promise<InboundWebhookOutcome> {
  const provider = input.session.provider as ChannelProvider;

  // This is the shared enforcement boundary for HTTP and direct server callers.
  // The route may pass an internal proof only after verifying the external HMAC;
  // without a matching proof this path always performs the real verification.
  if (!acceptsInboundWebhook(provider)) {
    return { ok: false, code: "provider_mismatch", message: "canal não recebe por esta rota" };
  }
  const proofIsValid = verifyInternalSignatureProof(
    input.session.id,
    provider,
    input.rawBody,
    input.headers,
    input.secret,
    input.internalSignatureProof,
  );
  if (!proofIsValid && !verifyInboundWebhookSignature(provider, input.rawBody, input.headers, input.secret)) {
    return { ok: false, code: "unauthorized", message: "bad_signature" };
  }

  switch (provider) {
    case CHANNEL_PROVIDER_SOCIAL:
    case CHANNEL_PROVIDER_ZERNIO:
      return zernioInbound(admin, input);
    case CHANNEL_PROVIDER_DATAFY:
      return datafyInbound(admin, input);
    case CHANNEL_PROVIDER_TELEGRAM:
      return telegramInbound(admin, input);
    case CHANNEL_PROVIDER_EMAIL:
      return emailInbound(admin, input);
    case CHANNEL_PROVIDER_INSTAGRAM:
      return instagramInbound(admin, input);
    case CHANNEL_PROVIDER_TIKTOK:
      return tiktokInbound(admin, input);
    default:
      // Token de um canal que não entra por aqui. É configuração trocada, não
      // ataque — mas processar seria ler o payload com o parser errado.
      return { ok: false, code: "provider_mismatch", message: "canal não recebe por esta rota" };
  }
}

async function instagramInbound(
  admin: SupabaseClient,
  input: InboundWebhookInput,
): Promise<InboundWebhookOutcome> {
  let payload: unknown;
  try {
    payload = JSON.parse(input.rawBody);
  } catch {
    return { ok: false, code: "invalid_json", message: "invalid_json" };
  }

  const result = await ingestInstagramWebhook(
    admin,
    payload as InstagramWebhookPayload,
    input.session.organization_id,
  );
  return { ok: true, body: { ...result } };
}

async function tiktokInbound(
  admin: SupabaseClient,
  input: InboundWebhookInput,
): Promise<InboundWebhookOutcome> {
  let payload: unknown;
  try {
    payload = JSON.parse(input.rawBody);
  } catch {
    return { ok: false, code: "invalid_json", message: "invalid_json" };
  }

  const result = await ingestTikTokWebhook(
    admin,
    payload as TikTokWebhookPayload,
    input.session.organization_id,
  );
  return { ok: true, body: { ...result } };
}

function parseEmailWebhookPayload(raw: string): EmailInboundPayload | null {
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!json || typeof json !== "object") return null;

  const root = json as Record<string, unknown>;
  const data = root.data && typeof root.data === "object" ? (root.data as Record<string, unknown>) : root;

  const rawFrom = data.from ?? data.sender;
  const from = typeof rawFrom === "string" ? rawFrom : (Array.isArray(rawFrom) && typeof rawFrom[0] === "string" ? rawFrom[0] : "");

  const rawTo = data.to ?? data.recipient;
  const to = typeof rawTo === "string" ? rawTo : (Array.isArray(rawTo) && typeof rawTo[0] === "string" ? rawTo[0] : "");

  const subject = typeof data.subject === "string" ? data.subject : null;
  const text = typeof data.text === "string" ? data.text : (typeof data.plain === "string" ? data.plain : (typeof data.body === "string" ? data.body : null));
  const html = typeof data.html === "string" ? data.html : null;
  const messageId = typeof data.messageId === "string" ? data.messageId : (typeof data.message_id === "string" ? data.message_id : (typeof data.id === "string" ? data.id : (typeof data["Message-Id"] === "string" ? data["Message-Id"] : null)));
  const inReplyTo = typeof data.inReplyTo === "string" ? data.inReplyTo : (typeof data.in_reply_to === "string" ? data.in_reply_to : (typeof data["In-Reply-To"] === "string" ? data["In-Reply-To"] : null));

  if (!from) return null;

  return {
    from,
    to: to || "",
    subject,
    text,
    html,
    messageId,
    inReplyTo,
  };
}

async function emailInbound(
  admin: SupabaseClient,
  input: InboundWebhookInput,
): Promise<InboundWebhookOutcome> {
  const emailPayload = parseEmailWebhookPayload(input.rawBody);
  if (!emailPayload) {
    return { ok: false, code: "contrato_violado", message: "payload_email_invalido" };
  }

  const result = await ingestEmailInbound(admin, {
    organizationId: input.session.organization_id,
    channelSessionId: input.session.id,
    payload: emailPayload,
  });

  return { ok: true, body: { ...result } };
}

async function telegramInbound(
  admin: SupabaseClient,
  input: InboundWebhookInput,
): Promise<InboundWebhookOutcome> {
  let payload: unknown;
  try {
    payload = JSON.parse(input.rawBody);
  } catch {
    return { ok: false, code: "invalid_json", message: "invalid_json" };
  }

  const result = await ingestTelegramInbound(admin, {
    organizationId: input.session.organization_id,
    channelSessionId: input.session.id,
    payload,
  });

  return { ok: true, body: { ...result } };
}

async function zernioInbound(
  admin: SupabaseClient,
  input: InboundWebhookInput,
): Promise<InboundWebhookOutcome> {
  // ─── O contrato do fio, ANTES de qualquer leitura ─────────────────────────
  //
  // Aqui o payload era `unknown` e cada leitor se defendia sozinho com `str()`,
  // que devolve `null` para o que não é string. Nunca estourava — e era esse o
  // problema: um `conversationId` numérico virava `null`, o parser devolvia
  // `null`, e a rota respondia 200 `evento_sem_interesse`, exatamente como
  // responde a um evento que de fato não interessa. A mensagem do cliente sumia
  // com carimbo de normalidade.
  //
  // A recusa nomeia os CAMPOS e nunca os valores (dado de cliente), e a rota a
  // fecha no arquivo do webhook com `status: "error"` — onde alguém procura.
  const leitura = lerEnvelopeZernio(input.rawBody);
  if (!leitura.ok) {
    if (leitura.motivo === "json_invalido") {
      return { ok: false, code: "invalid_json", message: "invalid_json" };
    }
    return {
      ok: false,
      code: "contrato_violado",
      message: `payload fora do contrato do canal: ${leitura.campos.join(", ")}`,
    };
  }
  const payload = leitura.envelope;
  if (input.session.provider === CHANNEL_PROVIDER_SOCIAL) {
    const result = await ingestSocialInbound(admin, input.session.organization_id, input.session.id, payload);
    return { ok: true, body: { ...result } };
  }

  // ─── O que a plataforma decide sozinha ───────────────────────────────────
  //
  // Revisão de modelo e mudança de estado do número não são mensagens, mas são
  // o tipo de coisa que só se descobre no disparo que não sai — com a campanha
  // montada e o cliente esperando. Vira aviso na Central, onde o humano já
  // procura o que está errado.
  //
  // ─── Evento de NÚMERO: só vale se o número é o desta sessão ──────────────
  //
  // `whatsapp.number.*` não traz conta — a guarda de conta deixa passar —, e o
  // webhook do provedor é por espaço de trabalho, não por número. Sem esta
  // conferência, o status de outro número do mesmo espaço mudaria o estado
  // DESTE canal e abriria aviso crítico aqui. Quem decide é `number.phoneNumber`
  // (campo do schema publicado pelo provedor) contra `channel_sessions.phone_number`.
  //
  // Sem os dois lados não há comparação, e o evento fica só no arquivo do
  // webhook: sem mudar status e sem aviso. É o lado seguro também se a rota um
  // dia deixar de trazer `phone_number` — o efeito é não aplicar, nunca
  // aplicar o de outro número.
  if (payload.event?.startsWith("whatsapp.number.")) {
    const doEvento = payload.number?.phoneNumber;
    const daSessao = input.session.phone_number;
    if (!doEvento || !daSessao) {
      return { ok: true, body: { status: "ignored", reason: "numero_sem_comparacao" } };
    }
    if (!samePhone(doEvento, daSessao)) {
      return { ok: true, body: { status: "ignored", reason: "evento_de_outro_numero" } };
    }
  }

  const aviso = avisoDoEvento(payload);
  if (aviso) {
    // O espelho local também: o aviso empurra para olhar, e a tela de modelos
    // precisa mostrar o estado novo. Ver o estado velho depois de ler o aviso é
    // pior que não ter avisado.
    const espelhado = await atualizarEspelhoDoTemplate(
      admin,
      input.session.organization_id,
      payload,
      input.session.id,
    );

    // ─── Evento de CONEXÃO passa pelo vigia, não por um insert cru ──────────
    //
    // `sincronizarSaudeDaConexao` é quem grava o episódio, carimba
    // `ref_kind`+`ref_id` no ítem e — a metade que faltava — RESOLVE o aviso
    // quando a conta volta. Chamando `registrarAviso` direto, o crítico ficava
    // aberto para sempre e a reconexão abria um `info` novo ao lado dele.
    //
    // Um caminho só: quem entra aqui NÃO passa também pelo insert cru, senão a
    // Central mostraria o mesmo problema duas vezes.
    const saude = saudeDoEvento(payload);
    if (saude) {
      const desfecho = await sincronizarSaudeDaConexao(
        admin,
        // O `status` que vai para `channel_session_health` é o OBSERVADO agora,
        // não o guardado: quem acabou de falar foi o provedor, e a linha do
        // episódio serve justamente para registrar o que ele disse.
        { id: input.session.id, organization_id: input.session.organization_id, status: saude.status },
        saude,
        // O APELIDO da conexão, não o texto do evento. Passar `aviso.title` aqui
        // produzia `WhatsApp "Número SUSPENSO — não é possível enviar." fora do
        // ar (FAILED)`: título quebrado que não identifica a conexão — exatamente
        // o que o apelido existe para resolver. E fica gravado na linha.
        input.session.display_name ?? input.session.phone_number ?? "sem nome",
        // Empurrão do provedor: ele é a autoridade sobre o estado do NÚMERO, e
        // por isso a varredura não fecha o que ele abriu.
        "empurrao",
      );
      return { ok: true, body: { status: "saude", kind: aviso.kind, desfecho, espelhado } };
    }

    const desfecho = await registrarAviso(admin, input.session.organization_id, aviso);
    return { ok: true, body: { status: "aviso", kind: aviso.kind, desfecho, espelhado } };
  }

  // ─── Edição e apagamento ────────────────────────────────────────────────
  //
  // Vêm ANTES da ingestão, como os avisos: são correções de linha que já
  // existe, não mensagens novas. Deixá-los cair no `ingest` faria uma edição
  // criar uma conversa do nada, com um texto sem nada antes dele.
  const edicao = parseZernioEdicao(payload);
  if (edicao) {
    const desfecho = await aplicarEdicaoZernio(admin, input.session.organization_id, edicao);
    return { ok: true, body: { status: "edicao", tipo: edicao.tipo, desfecho } };
  }

  const r = await ingestZernioInbound(admin, {
    organizationId: input.session.organization_id,
    channelSessionId: input.session.id,
    payload,
  });
  return { ok: true, body: { ...r } };
}

/**
 * Entrada do canal Datafy (recorte do #1130, @vgamkt).
 *
 * O payload é IDÊNTICO ao da Meta (o parceiro espelha a Cloud API), então a
 * leitura reusa `lerEnvelopeMeta` + `parseMetaWebhook` + `ingestMetaInbound`. A
 * autenticação fica na fronteira compartilhada `handleInboundWebhook`, que
 * também protege chamadas diretas fora da rota.
 *
 * Fail-closed: sem o segredo `whsec_` gravado, nada entra. O evento só é aceito
 * se for do número e da conta DESTA sessão — a sessão veio do token do path, e
 * o corpo não escolhe onde gravar.
 */
async function datafyInbound(
  admin: SupabaseClient,
  input: InboundWebhookInput,
): Promise<InboundWebhookOutcome> {
  const leitura = lerEnvelopeMeta(input.rawBody);
  if (!leitura.ok) {
    if (leitura.motivo === "json_invalido") {
      return { ok: false, code: "invalid_json", message: "invalid_json" };
    }
    return {
      ok: false,
      code: "contrato_violado",
      message: `payload fora do contrato do canal: ${leitura.campos.join(", ")}`,
    };
  }

  const orgId = input.session.organization_id;
  const refs = await graphPartnerRefsDaSessao(admin, orgId, input.session.id);
  const eventos = parseMetaWebhook(leitura.envelope);
  const desfechos: string[] = [];
  const agora = new Date().toISOString();

  for (const e of eventos) {
    // Mesma régua da rota do canal oficial: evento carimbado com outra conta é
    // de outra sessão, e ignorá-lo é o certo (200, para o provedor não repetir).
    if (refs.wabaId && e.wabaId && e.wabaId !== refs.wabaId) {
      desfechos.push("outra_conta");
      continue;
    }
    if (e.kind === "inbound_message") {
      if (e.phoneNumberId !== refs.phoneNumberId) {
        desfechos.push("outro_numero");
        continue;
      }
      const r = await ingestMetaInbound(admin, e, {
        organizationId: orgId,
        channelSessionId: input.session.id,
      });
      desfechos.push(r.status);
      continue;
    }
    if (e.kind === "outbound_echo") {
      // Coexistência pelo parceiro: resposta dada pelo app WhatsApp Business.
      if (e.phoneNumberId !== refs.phoneNumberId) {
        desfechos.push("outro_numero");
        continue;
      }
      const r = await ingestMetaEcho(admin, e, {
        organizationId: orgId,
        channelSessionId: input.session.id,
      });
      desfechos.push(`eco:${r.status}`);
      continue;
    }
    if (e.kind === "message_status") {
      await admin
        .from("messages")
        .update({ status: e.status === "failed" ? "failed" : "sent", updated_at: agora })
        .eq("organization_id", orgId)
        .eq("external_id", e.externalId);
      desfechos.push("status");
      continue;
    }
    if (e.kind === "template_status") {
      // A revisão da plataforma decide depois da criação: sem isto a definição
      // ficava PENDING no espelho até alguém clicar em Sincronizar, e o seletor
      // do inbox não a oferecia. Escopo pela CONEXÃO desta entrega — a coluna
      // `waba_id` do espelho deste canal guarda o número, não a conta.
      const { error } = await admin
        .from("meta_templates")
        .update({ status: e.event, rejected_reason: e.reason, updated_at: agora })
        .eq("organization_id", orgId)
        .eq("channel_session_id", input.session.id)
        .eq("name", e.templateName)
        .eq("language", e.templateLanguage);
      desfechos.push(error ? "modelo_nao_atualizado" : "modelo");
      continue;
    }
    desfechos.push("ignorado");
  }

  return { ok: true, body: { received: eventos.length, outcomes: desfechos } };
}
