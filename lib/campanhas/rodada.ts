/**
 * Uma RODADA de campanha: no máximo um envio por NÚMERO, e só se o ritmo
 * permitir.
 *
 * ═══ Por que um por número, e não um lote ═══
 *
 * O ritmo é o produto. Quem dispara 500 de uma vez queima o número, e número
 * queimado não volta em dias — volta em semanas de warm-up, com o cliente sem
 * canal. A rodada pergunta ao motor de pacing (o MESMO do agente, não um espelho)
 * se pode enviar AGORA, envia um, registra no `pacing_ledger`, e acabou. A
 * cadência real é a do cron × a do throttle, o que for mais lento.
 *
 * Um por NÚMERO e não um por instalação: duas conexões diferentes não disputam
 * ritmo entre si — o `pacing_ledger` é por `channel_session_id` —, e serializar
 * tudo faria a campanha de um cliente esperar a do outro.
 *
 * ═══ Por que o motor de pacing do AGENTE ═══
 *
 * `lib/automation/throttle.ts` espaça por um `Map` de módulo (não sobrevive a
 * restart nem a dois processos) e o cap diário dele lê `channel_session_warmup`,
 * tabela sem escritor — o ramo nunca dispara (medido; está escrito no cabeçalho
 * de lá). Campanha é exatamente o caso que estoura número: precisa do contador
 * real (`pacing_ledger`) e do mesmo lock por número que a cadeia de envio usa,
 * para campanha e agente não furarem o ritmo um do outro.
 *
 * ═══ Por que a rodada vazia não audita ═══
 *
 * Regra do `CLAUDE.md`: rodada de cron que não fez nada NÃO é mutação. Numa
 * instalação sem campanha rodando, auditar cada tique encheria o audit log — foi
 * o achado 17 do mapa de jornadas (95% do audit log de uma VPS era batida de
 * cron vazia).
 *
 * Nunca lança para o cron: uma campanha quebrada não pode derrubar a rodada.
 */
import { randomUUID } from "node:crypto";

import type { SupabaseClient } from "@supabase/supabase-js";

import { sendMessageHandler } from "@/app/api/v1/messages/_handler";
import { getRequestPool } from "@/lib/agent-engine/db/request-pool";
import { decidePacing, dayStartInTz } from "@/lib/agent-engine/pacing/engine";
import { loadChannelKnobs, loadPacingState, recordSend } from "@/lib/agent-engine/pacing/store";
import { beginServiceAtOrigin } from "@/lib/atendimento/origem";
import { logger } from "@/lib/logger";
import { OrgNaoOperanteError, idsDeOrgsParadas } from "@/lib/organizacao/operante";
import { checkFeatureQuota } from "@/lib/tenant/plan-limits";
import { capabilitiesOf, DEFAULT_CHANNEL_PROVIDER } from "@/lib/channels/capabilities";
import type { ChannelProvider } from "@/lib/channels/types";

import { motivoParaExcluir, recusouMarketing } from "./elegibilidade";
import { hashDoEndereco } from "./exclusoes";
import { renderizar } from "./renderizador";
import { escolherNumero, poolDaCampanha, type NumeroDisponivel } from "./rodizio";
import { podeMandarAgora, proximaTentativa, type RitmoDaCampanha } from "./ritmo";
import { nomeDoContato } from "@/lib/contacts/rotulo-do-contato";
import { TEXTO_DA_EXCLUSAO } from "./tipos";
import { chaveDaBolha, idDaMensagemDaBolha, separarMensagemDeCampanha } from "./baloes";
import type { PacingKnobs } from "@/lib/agent-engine/pacing/defaults";

export interface ResultadoDaRodada {
  /** Mensagens que saíram de fato. */
  enviadas: number;
  /** Destinatários marcados como excluídos nesta rodada (veto revalidado). */
  pulados: number;
  /** Campanhas que terminaram. */
  concluidas: number;
  /** Campanhas agendadas que viraram `running` porque a hora chegou. */
  promovidas: number;
  detalhe: string;
}

const VAZIA: ResultadoDaRodada = {
  enviadas: 0,
  pulados: 0,
  concluidas: 0,
  promovidas: 0,
  detalhe: "nada_a_fazer",
};

/** Teto de números atendidos por rodada — a rodada é de um minuto, não de um dia. */
const NUMEROS_POR_RODADA = 10;

interface CampanhaRow {
  id: string;
  organization_id: string;
  channel?: "whatsapp" | "telegram" | "email";
  email_subject?: string | null;
  /** O número PRINCIPAL. O pool efetivo inclui os vinculados (migration 0377). */
  channel_session_id: string;
  name: string;
  message_body: string | null;
  content_version: number;
  intervalo_segundos: number | null;
  janela_inicio_hora: number | null;
  janela_fim_hora: number | null;
  teto_diario: number | null;
  teto_horario: number | null;
  split_messages?: boolean;
}

const COLUNAS_DA_CAMPANHA =
  "id, organization_id, channel, email_subject, channel_session_id, name, message_body, content_version, " +
  "intervalo_segundos, janela_inicio_hora, janela_fim_hora, teto_diario, teto_horario, split_messages";

export async function rodarUmaRodadaDeCampanha(
  admin: SupabaseClient,
  agora: Date = new Date(),
): Promise<ResultadoDaRodada> {
  // Organização que não OPERA (suspensa, redigida ou arquivada) não dispara
  // campanha: disparo em massa custa ao dono da instalação e sai para fora. A
  // régua é a única do produto, `lib/organizacao/operante.ts`. O comentário que
  // morava aqui dizia que `= 'suspended'` era "a mesma decisão da fila do
  // agente"; a fila nunca filtrou status (o `CLAIM_SQL` de
  // `lib/agent-engine/queue/queue.ts` não olha `organizations`), e quem fecha a
  // fila é `fn_suspender_organizacao`, que falha os jobs pendentes.
  const idsParadas = await idsDeOrgsParadas(admin);

  const promovidas = await promoverAgendadas(admin, idsParadas, agora);

  let consulta = admin
    .from("campaigns")
    .select(COLUNAS_DA_CAMPANHA)
    .eq("status", "running")
    .order("started_at", { ascending: true })
    .limit(NUMEROS_POR_RODADA * 3);
  if (idsParadas.length > 0) {
    consulta = consulta.not("organization_id", "in", `(${idsParadas.join(",")})`);
  }
  const { data: campanhas, error: falhaDaBusca } = await consulta;
  if (falhaDaBusca) {
    // Sem isto a falha virava "nada_a_fazer": indistinguível de rodada vazia.
    logger.warn("[campanha] busca das campanhas em andamento falhou", { motivo: falhaDaBusca.message });
    return { ...VAZIA, promovidas, detalhe: "busca_falhou" };
  }
  // `as unknown as`: a lista de colunas é montada por concatenação, e o tipo
  // gerado do PostgREST só sabe inferir literal — o mesmo caminho que
  // `lib/asaas/*` já usa para tabela que ainda não está em `database.types.ts`.
  const emExecucao = (campanhas ?? []) as unknown as CampanhaRow[];
  if (emExecucao.length === 0) {
    return promovidas > 0 ? { ...VAZIA, promovidas, detalhe: "promovidas" } : VAZIA;
  }

  const numerosAtendidos = new Set<string>();
  const total: ResultadoDaRodada = { ...VAZIA, promovidas, detalhe: "" };
  const detalhes: string[] = [];

  for (const campanha of emExecucao) {
    // Um número, uma mensagem por rodada. A campanha mais antiga do número ganha
    // a vez: sem isso, a última criada poderia monopolizar a fila para sempre.
    if (numerosAtendidos.has(campanha.channel_session_id)) continue;
    if (numerosAtendidos.size >= NUMEROS_POR_RODADA) break;

    try {
      const r = await rodarUmaCampanha(admin, campanha, agora);
      total.enviadas += r.enviadas;
      total.pulados += r.pulados;
      total.concluidas += r.concluidas;
      detalhes.push(`${campanha.id.slice(0, 8)}:${r.detalhe}`);
      // Só ocupa o número quem de fato enviou: campanha parada por ritmo não
      // pode impedir a campanha seguinte do mesmo número de ser avaliada... mas
      // se o veto foi do CANAL, a seguinte receberia o mesmo veto. Ocupar em
      // ambos os casos economiza a consulta; o que não pode é ocupar quando a
      // campanha só CONCLUIU (aí o número está livre de verdade).
      if (r.concluidas === 0) numerosAtendidos.add(campanha.channel_session_id);
    } catch (err) {
      const motivo = err instanceof Error ? err.message : String(err);
      logger.warn("[campanha] rodada falhou", { campanha: campanha.id, motivo });
      detalhes.push(`${campanha.id.slice(0, 8)}:erro`);
      numerosAtendidos.add(campanha.channel_session_id);
    }
  }

  total.detalhe = detalhes.join(" ") || "nada_a_fazer";
  return total;
}

/** `scheduled` cuja hora chegou vira `running`. */
async function promoverAgendadas(
  admin: SupabaseClient,
  idsParadas: string[],
  agora: Date,
): Promise<number> {
  let consulta = admin
    .from("campaigns")
    .update({ status: "running", started_at: agora.toISOString() })
    .eq("status", "scheduled")
    .lte("scheduled_at", agora.toISOString());
  if (idsParadas.length > 0) {
    consulta = consulta.not("organization_id", "in", `(${idsParadas.join(",")})`);
  }
  const { data, error } = await consulta.select("id");
  if (error) {
    logger.warn("[campanha] promoção de agendadas falhou", { motivo: error.message });
    return 0;
  }
  return (data ?? []).length;
}

interface DestinatarioRow {
  id: string;
  organization_id?: string;
  contact_id: string;
  recipient_address: string | null;
  rendered_body: string | null;
  status?: string;
  channel_session_id?: string | null;
  message_id?: string | null;
  split_bubble_count?: number | null;
  next_bubble_index?: number | null;
  sending_at?: string | null;
  next_attempt_at?: string | null;
  conversation_id?: string | null;
  channel?: "whatsapp" | "telegram" | "email" | null;
  contacts: {
    id: string;
    name: string | null;
    display_name: string | null;
    phone_number: string | null;
    email?: string | null;
    social_identity?: string | null;
    is_blocked: boolean;
    is_anonymized: boolean;
    consent: unknown;
  } | null;
}

async function rodarUmaCampanha(
  admin: SupabaseClient,
  campanha: CampanhaRow,
  agora: Date,
): Promise<{ enviadas: number; pulados: number; concluidas: number; detalhe: string }> {
  // Revalidação canônica de plano/entitlement no momento da execução operacional:
  // Se a organização sofreu downgrade para um plano sem campanhas (ex: Standard),
  // novos disparos são interrompidos e a campanha é pausada com segurança.
  const featureCheck = await checkFeatureQuota(admin, campanha.organization_id, "campaigns");
  if (!featureCheck.allowed) {
    logger.warn("[campanha] execução bloqueada por downgrade de plano", {
      campanhaId: campanha.id,
      organizationId: campanha.organization_id,
      motivo: featureCheck.reason,
    });
    await admin
      .from("campaigns")
      .update({ status: "paused", paused_at: agora.toISOString() })
      .eq("id", campanha.id)
      .eq("status", "running");

    return { enviadas: 0, pulados: 0, concluidas: 0, detalhe: "bloqueado:plano_sem_campanhas" };
  }

  let alvo: DestinatarioRow | undefined;
  let continuacao = false;
  if (campanha.split_messages && (campanha.channel ?? "whatsapp") === "whatsapp") {
    const sequencia = await buscarContinuacaoDeBaloes(admin, campanha, agora);
    if (sequencia.alvo) {
      alvo = sequencia.alvo;
      continuacao = true;
    } else if (sequencia.ocupada) {
      return { enviadas: 0, pulados: 0, concluidas: 0, detalhe: "baloes:aguardando_lease_ou_ack" };
    }
  }

  if (!alvo) {
    const { data: fila } = await admin
      .from("campaign_recipients")
      .select(
        "organization_id, id, contact_id, recipient_address, rendered_body, channel, status, channel_session_id, " +
          "message_id, split_bubble_count, next_bubble_index, sending_at, next_attempt_at, " +
          "contacts(id, name, display_name, phone_number, email, social_identity, is_blocked, is_anonymized, consent)",
      )
      .eq("organization_id", campanha.organization_id)
      .eq("campaign_id", campanha.id)
      .eq("status", "pending")
      .or(`next_attempt_at.is.null,next_attempt_at.lte.${agora.toISOString()}`)
      .order("created_at", { ascending: true })
      .limit(1);
    alvo = (fila ?? [])[0] as DestinatarioRow | undefined;
  }

  if (!alvo) {
    // Nada pendente AGORA não é o mesmo que nada pendente: pode haver gente
    // esperando `next_attempt_at`. Só conclui quem não tem mais nenhum em voo.
    const { count } = await admin
      .from("campaign_recipients")
      .select("id", { count: "exact", head: true })
      .eq("campaign_id", campanha.id)
      .in("status", ["pending", "queued", "sending"]);
    if ((count ?? 0) > 0) return { enviadas: 0, pulados: 0, concluidas: 0, detalhe: "aguardando" };

    const { data } = await admin
      .from("campaigns")
      .update({ status: "completed", completed_at: agora.toISOString() })
      .eq("id", campanha.id)
      .eq("status", "running")
      .select("id");
    return {
      enviadas: 0,
      pulados: 0,
      concluidas: (data ?? []).length,
      detalhe: (data ?? []).length > 0 ? "concluida" : "ja_concluida",
    };
  }

  // ─── Os vetos por PESSOA, revalidados ───
  // Vêm ANTES do ritmo de propósito: pular não gasta janela de envio, e uma fila
  // cheia de bloqueados não pode consumir o teto diário do número. E são
  // revalidados porque entre a preparação e agora a pessoa pode ter pedido para
  // parar — honrar o pedido com um dia de atraso é o mesmo que não honrar.
  const contato = alvo.contacts;
  const canalCampanha = campanha.channel ?? alvo.channel ?? "whatsapp";
  const motivo = motivoParaExcluir({
    contactId: alvo.contact_id,
    telefone: contato?.phone_number ?? alvo.recipient_address,
    email: contato?.email ?? alvo.recipient_address,
    telegramChatId: contato?.social_identity?.startsWith("telegram:")
      ? contato.social_identity.replace(/^telegram:/, "")
      : null,
    bloqueado: !!contato?.is_blocked,
    anonimizado: !!contato?.is_anonymized,
    recusouMarketing: recusouMarketing(contato?.consent),
    canal: canalCampanha,
  }, canalCampanha);
  if (motivo) {
    let consulta = admin
      .from("campaign_recipients")
      .update({
        status: motivo === "opt_out" ? "opted_out" : "skipped",
        eligibility_status: "excluded",
        exclusion_reason: motivo,
        opted_out_at: motivo === "opt_out" ? agora.toISOString() : null,
      })
      .eq("id", alvo.id)
      .eq("status", alvo.status ?? "pending");
    if (alvo.status === "sending" && alvo.sending_at) consulta = consulta.eq("sending_at", alvo.sending_at);
    await consulta;
    return { enviadas: 0, pulados: 1, concluidas: 0, detalhe: `pulado:${motivo}` };
  }

  // A lista de exclusão da operação, revalidada AQUI e não só na preparação:
  // ela pode ter crescido depois do snapshot, e o ponto dela é impedir o envio.
  const enderecoAtual = (contato?.phone_number ?? alvo.recipient_address ?? "").trim();
  if (enderecoAtual !== "") {
    const { data: suprimido } = await admin
      .from("campaign_suppressions")
      .select("id")
      .eq("organization_id", campanha.organization_id)
      .eq("recipient_address_hash", hashDoEndereco(enderecoAtual))
      .maybeSingle();
    if (suprimido) {
      let consulta = admin
        .from("campaign_recipients")
        .update({
          status: "skipped",
          eligibility_status: "excluded",
          exclusion_reason: "suprimido",
        })
        .eq("id", alvo.id)
        .eq("status", alvo.status ?? "pending");
      if (alvo.status === "sending" && alvo.sending_at) consulta = consulta.eq("sending_at", alvo.sending_at);
      await consulta;
      return { enviadas: 0, pulados: 1, concluidas: 0, detalhe: "pulado:suprimido" };
    }
  }

  // ─── O ritmo da CAMPANHA, que vale para ela inteira ───
  //
  // Antes do rodízio de propósito: o intervalo e o teto da campanha somam TODOS
  // os números dela. Quem quer que o rodízio aumente o volume deixa o ritmo da
  // campanha em branco e herda o de cada número; quem põe 60s aqui manda uma a
  // cada 60s no total, com um número ou com cinco.
  const pool = getRequestPool();
  const ritmo: RitmoDaCampanha = {
    intervaloSegundos: campanha.intervalo_segundos,
    janelaInicioHora: campanha.janela_inicio_hora,
    janelaFimHora: campanha.janela_fim_hora,
    tetoDiario: campanha.teto_diario,
    tetoHorario: campanha.teto_horario,
  };
  const dividirBaloes = campanha.split_messages === true && canalCampanha === "whatsapp";
  const numeros = continuacao
    ? alvo.channel_session_id
      ? [alvo.channel_session_id]
      : []
    : await numerosDaCampanha(admin, campanha);
  // O fuso da janela da campanha é o do número PRINCIPAL: ela é uma decisão da
  // campanha, e precisa de um relógio só — três números em fusos diferentes
  // fariam a mesma campanha abrir e fechar a janela três vezes.
  const knobsDoPrincipal = await loadChannelKnobs(pool, campanha.organization_id, campanha.channel_session_id);
  // ⚠️ O estado do ritmo é lido DEPOIS dos knobs porque precisa do MESMO fuso
  // que a janela usa. Com `setUTCHours`, o "dia" virava 21h no horário de
  // Brasília — DENTRO da janela de envio —, e uma campanha que já tinha batido
  // o teto diário voltava a enviar com uma hora de janela pela frente.
  const estado = await estadoDeEnvio(
    admin,
    campanha.id,
    agora,
    knobsDoPrincipal.knobs.timezone,
    dividirBaloes ? { organizationId: campanha.organization_id, contarMensagensFisicas: true } : undefined,
  );
  // O intervalo da campanha rege o INÍCIO de um destinatário. Balões da mesma
  // pessoa obedecem ao pacing do canal, sem aplicar novamente esse intervalo.
  const ritmoDaVez = continuacao ? { ...ritmo, intervaloSegundos: null } : ritmo;
  const doRitmo = podeMandarAgora(ritmoDaVez, estado, agora, knobsDoPrincipal.knobs.timezone);
  if (!doRitmo.pode) {
    // Espera não é falha: grava QUANDO tentar de novo para a fila não ser varrida
    // a cada tique por uma campanha que só volta amanhã.
    const proxima = proximaTentativa(doRitmo, agora);
    if (proxima) {
      await adiarDestinatario(admin, alvo, proxima);
    }
    return { enviadas: 0, pulados: 0, concluidas: 0, detalhe: `ritmo:${doRitmo.motivo}` };
  }

  // ─── O RODÍZIO: qual número fala com esta pessoa ───
  const disponiveis: NumeroDisponivel[] = [];
  const knobsPorNumero = new Map<string, Awaited<ReturnType<typeof loadChannelKnobs>>>();
  const candidatosPorNumero = new Map<
    string,
    {
      corpo: string;
      baloes: string[];
      limiteDiario: number | null;
      intervaloMinimoMs: number;
      numeroAtivadoEm: Date | null;
    }
  >();
  let vetoDaCampanha: Extract<ReturnType<typeof podeMandarAgora>, { pode: false }> | null = null;
  let esperaDePacingMs: number | null = null;
  const congelado = alvo.rendered_body ?? campanha.message_body ?? "";
  for (const sessionId of numeros) {
    const k =
      sessionId === campanha.channel_session_id
        ? knobsDoPrincipal
        : await loadChannelKnobs(pool, campanha.organization_id, sessionId);
    knobsPorNumero.set(sessionId, k);

    const { data: canal } = await admin
      .from("channel_sessions")
      .select("daily_message_limit, status, provider")
      .eq("organization_id", campanha.organization_id)
      .eq("id", sessionId)
      .maybeSingle();
    const linha = canal as { daily_message_limit: number | null; status: string; provider: string | null } | null;
    // Número/canal fora do ar não entra no rodízio: mandar por ele seria fabricar uma
    // mensagem presa em `sending` que o recovery depois marca como falha.
    if (!linha || (linha.status !== "WORKING" && linha.status !== "connected")) continue;

    const corpo = continuacao
      ? congelado
      : renderizar(congelado, { nome: nomeDoContato(contato) }, { agora, fuso: k.knobs.timezone }).texto;
    const baloes = dividirBaloes
      ? separarMensagemDeCampanha(corpo, true, "whatsapp")
      : [corpo];
    const sequenciaDeBaloes = dividirBaloes && baloes.length > 1;
    const indiceInicial = continuacao ? (alvo.next_bubble_index ?? 0) : 0;
    const restantes = Math.max(1, baloes.length - indiceInicial);
    const estadoDaCampanhaParaSequencia = {
      ...estado,
      enviadasHoje: estado.enviadasHoje + restantes - 1,
      enviadasNaUltimaHora: estado.enviadasNaUltimaHora + restantes - 1,
    };
    const ritmoDaSequencia = continuacao ? { ...ritmo, intervaloSegundos: null } : ritmo;
    const cabeNaCampanha = podeMandarAgora(
      ritmoDaSequencia,
      estadoDaCampanhaParaSequencia,
      agora,
      knobsDoPrincipal.knobs.timezone,
    );
    if (!cabeNaCampanha.pode) {
      vetoDaCampanha = cabeNaCampanha;
      continue;
    }

    const estadoDoNumero = await loadPacingState(pool, campanha.organization_id, sessionId, {
      now: agora,
      timezone: k.knobs.timezone,
      numberActivatedAt: k.numberActivatedAt,
    });
    const intervaloMinimoMs = capabilitiesOf(
      (linha.provider ?? DEFAULT_CHANNEL_PROVIDER) as ChannelProvider,
    ).minIntervalMs ?? 0;
    const decisao = decidePacing({
      now: agora,
      knobs: k.knobs,
      state: { ...estadoDoNumero, sentToday: estadoDoNumero.sentToday + restantes - 1 },
      crmDailyLimit: linha.daily_message_limit ?? null,
      minimumIntervalMs: intervaloMinimoMs,
    });
    if (sequenciaDeBaloes && decisao.allow && decisao.waitMs > 0) {
      esperaDePacingMs = esperaDePacingMs === null ? decisao.waitMs : Math.min(esperaDePacingMs, decisao.waitMs);
    }
    candidatosPorNumero.set(sessionId, {
      corpo,
      baloes,
      limiteDiario: linha.daily_message_limit,
      intervaloMinimoMs,
      numeroAtivadoEm: k.numberActivatedAt,
    });
    disponiveis.push({
      sessionId,
      folgaDoDia:
        linha.daily_message_limit === null
          ? null
          : Math.max(0, linha.daily_message_limit - estadoDoNumero.sentToday - (restantes - 1)),
      podeAgora: decisao.allow && (!sequenciaDeBaloes || decisao.waitMs === 0),
      ultimoEnvio: estadoDoNumero.lastSentAt,
    });
  }

  const escolha = escolherNumero(disponiveis, await numeroDoHistorico(admin, campanha, alvo.contact_id));
  if (!escolha) {
    if (vetoDaCampanha) {
      const proxima = proximaTentativa(vetoDaCampanha, agora);
      if (proxima) await adiarDestinatario(admin, alvo, proxima);
      return { enviadas: 0, pulados: 0, concluidas: 0, detalhe: `ritmo:${vetoDaCampanha.motivo}` };
    }
    if (esperaDePacingMs !== null) {
      await adiarDestinatario(admin, alvo, new Date(agora.getTime() + esperaDePacingMs));
      return { enviadas: 0, pulados: 0, concluidas: 0, detalhe: "canal:aguardando_pacing" };
    }
    // Nenhum número pode agora. Não é falha do destinatário: é o ritmo dos
    // números. Volta para a fila e tenta no próximo tique.
    return { enviadas: 0, pulados: 0, concluidas: 0, detalhe: "canal:sem_numero_livre" };
  }
  const sessionEscolhida = escolha.sessionId;
  const knobs = knobsPorNumero.get(sessionEscolhida)!.knobs;

  if (dividirBaloes && candidatosPorNumero.get(sessionEscolhida)!.baloes.length > 1) {
    const candidato = candidatosPorNumero.get(sessionEscolhida)!;
    return enviarSequenciaDeBaloes({
      admin,
      pool,
      campanha,
      alvo,
      sessionId: sessionEscolhida,
      corpo: candidato.corpo,
      baloes: candidato.baloes,
      indiceInicial: continuacao ? (alvo.next_bubble_index ?? 0) : 0,
      continuacao,
      knobs,
      numeroAtivadoEm: candidato.numeroAtivadoEm,
      limiteDiario: candidato.limiteDiario,
      intervaloMinimoMs: candidato.intervaloMinimoMs,
      requestReason: escolha.motivo,
      agora,
    });
  }

  // ─── O envio ───
  // O id da mensagem nasce AQUI, e não do insert: com ele, o destinatário já
  // aponta para a mensagem antes de ela existir, e o trigger de ack sempre
  // encontra a linha. É também a chave de idempotência do `sendMessageHandler` —
  // uma repetição depois de queda relê a linha em vez de mandar de novo.
  const messageId = randomUUID();
  const reserva = await reservarDestinatario(admin, alvo.id, agora);
  if (!reserva.reservado) {
    return {
      enviadas: 0,
      pulados: 0,
      concluidas: 0,
      detalhe: reserva.erro ? `erro_na_reserva:${reserva.erro.slice(0, 40)}` : "ja_reservado",
    };
  }

  // O corpo é montado DEPOIS do ritmo: a saudação ("bom dia" × "boa tarde") tem
  // de ser a do instante em que a mensagem SAI, no fuso do canal. Montá-la na
  // preparação produziria "bom dia" numa mensagem enviada à tarde — foi o
  // defeito do primeiro piloto.
  const corpo = renderizar(
    congelado,
    { nome: nomeDoContato(contato) },
    { agora, fuso: knobs.timezone },
  ).texto;

  try {
    const boundary = await beginServiceAtOrigin(
      admin,
      campanha.organization_id,
      alvo.contact_id,
      sessionEscolhida,
    );
    await admin
      .from("campaign_recipients")
      .update({ conversation_id: boundary.conversation_id, channel_session_id: sessionEscolhida })
      .eq("id", alvo.id);

    const mensagem = await sendMessageHandler(
      admin,
      {
        organization_id: campanha.organization_id,
        serviceBoundary: boundary,
        proactiveContext: { organizationId: campanha.organization_id, contactId: alvo.contact_id },
        actor: { type: "webhook_source", id: `campaign:${campanha.id}` },
        requestId: `campaign:${campanha.id}:${alvo.id}`,
        internalMessageId: messageId,
      } as Parameters<typeof sendMessageHandler>[1],
      {
        conversation_id: boundary.conversation_id,
        type: "text",
        body: corpo,
        metadata: {
          source: "campaign",
          campaign_id: campanha.id,
          campaign_recipient_id: alvo.id,
          campaign_content_version: campanha.content_version,
          idempotency_key: `campaign:${alvo.id}`,
        },
      } as Parameters<typeof sendMessageHandler>[2],
    );
    await recordSend(pool, campanha.organization_id, sessionEscolhida, agora);

    // O desfecho vem do ESTADO da mensagem, nunca da ausência de exceção — o
    // handler marca `failed` e devolve normalmente.
    const status = (mensagem as { status?: string }).status;
    const falhou = status === "failed";
    // `.eq("status","sending")` porque o ack pode ter chegado ANTES desta linha:
    // o trigger já teria avançado o destinatário para `sent`/`delivered`, e
    // escrever por cima o rebaixaria.
    await admin
      .from("campaign_recipients")
      .update({
        status: falhou ? "failed" : "sent",
        sent_at: falhou ? null : agora.toISOString(),
        last_error_code: falhou ? "send_failed" : null,
        // O `message_id` só pode ser gravado AQUI: a coluna tem FK para
        // `messages`, e a linha da mensagem só existe depois do envio. Gravá-lo
        // antes — que era o desenho original, para o trigger de ack sempre achar
        // o destinatário — viola a FK e a reserva falha inteira.
        message_id: (mensagem as { id?: string }).id ?? messageId,
      })
      .eq("id", alvo.id)
      .eq("status", "sending");

    return {
      enviadas: falhou ? 0 : 1,
      pulados: 0,
      concluidas: 0,
      detalhe: `enviado:${status ?? "?"}:${escolha.motivo}`,
    };
  } catch (err) {
    logger.warn("[campanha] envio falhou", { campanha: campanha.id, destinatario: alvo.id });
    return { enviadas: 0, pulados: 0, concluidas: 0, detalhe: await registrarExcecaoDoEnvio(admin, alvo.id, err) };
  }
}

const LEASE_BOLHA_MS = 5 * 60_000;
const MAX_ESPERA_INLINE_BOLHA_MS = 10_000;

/**
 * Retoma uma sequência antes de escolher um destinatário novo. O índice salvo
 * no banco e o status/lease são relidos por rodada; dois cron concorrentes não
 * podem avançar a mesma sequência.
 */
async function buscarContinuacaoDeBaloes(
  admin: SupabaseClient,
  campanha: CampanhaRow,
  agora: Date,
): Promise<{ alvo?: DestinatarioRow; ocupada: boolean }> {
  const { data, error } = await admin
    .from("campaign_recipients")
    .select(
      "organization_id, id, contact_id, recipient_address, rendered_body, channel, status, channel_session_id, " +
        "message_id, split_bubble_count, next_bubble_index, sending_at, next_attempt_at, conversation_id, " +
        "contacts(id, name, display_name, phone_number, email, social_identity, is_blocked, is_anonymized, consent)",
    )
    .eq("organization_id", campanha.organization_id)
    .eq("campaign_id", campanha.id)
    .in("status", ["pending", "sending", "sent", "delivered", "read"])
    .not("split_bubble_count", "is", null)
    .or(
      "and(split_bubble_count.eq.2,next_bubble_index.lt.2),and(split_bubble_count.eq.3,next_bubble_index.lt.3)",
    )
    .or(`next_attempt_at.is.null,next_attempt_at.lte.${agora.toISOString()}`)
    .order("created_at", { ascending: true })
    .limit(1);

  if (error) {
    logger.warn("[campanha] busca da sequência de balões falhou", {
      campanhaId: campanha.id,
      motivo: error.code ?? "query_failed",
    });
    return { ocupada: true };
  }
  const alvo = (data ?? [])[0] as DestinatarioRow | undefined;
  if (!alvo) return { ocupada: false };

  if (alvo.status === "sending") {
    const lease = alvo.sending_at ? Date.parse(alvo.sending_at) : 0;
    if (Number.isFinite(lease) && agora.getTime() - lease < LEASE_BOLHA_MS) {
      return { ocupada: true };
    }
  }
  return { alvo, ocupada: false };
}

async function reivindicarContinuacaoDeBaloes(
  admin: SupabaseClient,
  alvo: DestinatarioRow,
  agora: Date,
): Promise<{ reservado: boolean; erro?: string }> {
  const status = alvo.status ?? "pending";
  const indice = alvo.next_bubble_index ?? 0;
  let consulta = admin
    .from("campaign_recipients")
    .update({
      status: "sending",
      sending_at: agora.toISOString(),
      last_attempt_at: agora.toISOString(),
      next_attempt_at: null,
      // Desvincula o ack do balão anterior enquanto o próximo está em voo.
      message_id: null,
    })
    .eq("organization_id", alvo.organization_id ?? "")
    .eq("id", alvo.id)
    .eq("status", status)
    .eq("next_bubble_index", indice);
  if (status === "sending") {
    if (!alvo.sending_at) return { reservado: false };
    consulta = consulta.eq("sending_at", alvo.sending_at);
  } else if (status === "pending") {
    consulta = consulta.or(`next_attempt_at.is.null,next_attempt_at.lte.${agora.toISOString()}`);
  }

  const { data, error } = await consulta.select("id");
  if (error) {
    logger.warn("[campanha] retomada da sequência falhou", {
      destinatarioId: alvo.id,
      motivo: error.code ?? "claim_failed",
    });
    return { reservado: false, erro: error.code ?? "claim_failed" };
  }
  return { reservado: (data ?? []).length > 0 };
}

async function adiarDestinatario(admin: SupabaseClient, alvo: DestinatarioRow, quando: Date): Promise<void> {
  const status = alvo.status ?? "pending";
  let consulta = admin
    .from("campaign_recipients")
    .update({ status: "pending", sending_at: null, next_attempt_at: quando.toISOString() })
    .eq("organization_id", alvo.organization_id ?? "")
    .eq("id", alvo.id)
    .eq("status", status);
  if (status === "sending" && alvo.sending_at) consulta = consulta.eq("sending_at", alvo.sending_at);
  await consulta;
}

async function atualizarSequencia(
  admin: SupabaseClient,
  alvo: DestinatarioRow,
  indiceAtual: number,
  patch: Record<string, unknown>,
): Promise<boolean> {
  if (!alvo.sending_at) return false;
  const { data, error } = await admin
    .from("campaign_recipients")
    .update(patch)
    .eq("organization_id", alvo.organization_id ?? "")
    .eq("id", alvo.id)
    .eq("status", "sending")
    .eq("next_bubble_index", indiceAtual)
    .eq("sending_at", alvo.sending_at)
    .select("id");
  if (error) {
    logger.warn("[campanha] checkpoint do balão falhou", {
      destinatarioId: alvo.id,
      motivo: error.code ?? "checkpoint_failed",
    });
  }
  return !error && (data ?? []).length > 0;
}

/**
 * Vincula o recipient à mensagem e fecha a corrida em que o ACK chega antes
 * do vínculo. O trigger existente só encontra o recipient por message_id; se
 * o canal confirmar antes do update, ele não verá a linha. A releitura feita
 * depois do vínculo transforma o ACK antecipado no mesmo checkpoint que o
 * trigger teria feito.
 */
async function reconciliarAckDaBolha(input: {
  admin: SupabaseClient;
  pool: ReturnType<typeof getRequestPool>;
  campanha: CampanhaRow;
  destinatarioId: string;
  sessionId: string;
  messageId: string;
  indice: number;
  quantidade: number;
  enviadoEm: Date;
}): Promise<boolean> {
  const { admin, pool, campanha, destinatarioId, sessionId, messageId, indice, quantidade, enviadoEm } = input;
  const { data, error } = await admin
    .from("messages")
    .select("id, status, sent_at, delivered_at, read_at")
    .eq("organization_id", campanha.organization_id)
    .eq("id", messageId)
    .maybeSingle();
  if (error || !data) return false;

  const mensagem = data as {
    id: string;
    status: string;
    sent_at: string | null;
    delivered_at: string | null;
    read_at: string | null;
  };
  if (["queued", "sending"].includes(mensagem.status)) return false;

  if (["sent", "delivered", "read"].includes(mensagem.status)) {
    // O ledger é registrado antes do avanço persistente. Se ele falhar, a
    // sequência fica parada neste índice e uma rodada futura tenta novamente.
    await recordSend(
      pool,
      campanha.organization_id,
      sessionId,
      mensagem.sent_at ? new Date(mensagem.sent_at) : enviadoEm,
    );
  }

  const sucesso = ["sent", "delivered", "read"].includes(mensagem.status);
  const final = indice === quantidade - 1;
  const proximoEstado = sucesso
    ? final
      ? mensagem.status
      : "pending"
    : "failed";
  const proximaTentativa = sucesso && !final ? new Date().toISOString() : null;
  const { data: atualizada, error: updateError } = await admin
    .from("campaign_recipients")
    .update({
      next_bubble_index: sucesso ? indice + 1 : indice,
      status: proximoEstado,
      sending_at: null,
      next_attempt_at: proximaTentativa,
      sent_at: final && sucesso ? (mensagem.sent_at ?? enviadoEm.toISOString()) : null,
      delivered_at: final && sucesso ? mensagem.delivered_at : null,
      read_at: final && sucesso ? mensagem.read_at : null,
      message_id: final && sucesso ? messageId : sucesso ? null : messageId,
      last_error_code: sucesso ? null : "send_failed",
    })
    .eq("organization_id", campanha.organization_id)
    .eq("id", destinatarioId)
    .eq("next_bubble_index", indice)
    .in("status", ["queued", "sent", "delivered", "read", "sending", "failed"])
    .select("id");
  if (updateError) {
    logger.warn("[campanha] reconciliação do ack da bolha falhou", {
      campanhaId: campanha.id,
      destinatarioId,
      motivo: updateError.code ?? "ack_checkpoint_failed",
    });
    return false;
  }
  return (atualizada ?? []).length > 0 && sucesso;
}

async function interromperSeCampanhaParou(
  admin: SupabaseClient,
  campanha: CampanhaRow,
  alvo: DestinatarioRow,
  indice: number,
  agora: Date,
): Promise<boolean> {
  const { data, error } = await admin
    .from("campaigns")
    .select("status")
    .eq("id", campanha.id)
    .eq("organization_id", campanha.organization_id)
    .maybeSingle();
  if (error) {
    await atualizarSequencia(admin, alvo, indice, {
      status: "pending",
      sending_at: null,
      next_attempt_at: new Date(agora.getTime() + 60_000).toISOString(),
    });
    return true;
  }
  if ((data as { status?: string } | null)?.status === "running") return false;
  const statusCampanha = (data as { status?: string } | null)?.status;
  await atualizarSequencia(admin, alvo, indice, {
    status: statusCampanha === "cancelled" ? "cancelled" : "pending",
    sending_at: null,
    next_attempt_at: statusCampanha === "cancelled" ? null : new Date(agora.getTime() + 60_000).toISOString(),
    cancelled_at: statusCampanha === "cancelled" ? agora.toISOString() : null,
  });
  return true;
}

async function verificarElegibilidadeAntesDoProximoBalao(
  admin: SupabaseClient,
  campanha: CampanhaRow,
  alvo: DestinatarioRow,
  indice: number,
  agora: Date,
): Promise<boolean> {
  const { data, error } = await admin
    .from("contacts")
    .select("id, phone_number, email, social_identity, is_blocked, is_anonymized, consent")
    .eq("organization_id", campanha.organization_id)
    .eq("id", alvo.contact_id)
    .maybeSingle();
  if (error) {
    await atualizarSequencia(admin, alvo, indice, {
      status: "pending",
      sending_at: null,
      next_attempt_at: new Date(agora.getTime() + 60_000).toISOString(),
    });
    return false;
  }
  if (!data) {
    await atualizarSequencia(admin, alvo, indice, {
      status: "skipped",
      sending_at: null,
      exclusion_reason: "contato_inexistente",
      eligibility_status: "excluded",
    });
    return false;
  }
  const contatoAtual = data as {
    id: string;
    phone_number: string | null;
    email: string | null;
    social_identity: string | null;
    is_blocked: boolean;
    is_anonymized: boolean;
    consent: unknown;
  };
  const canal = campanha.channel ?? alvo.channel ?? "whatsapp";
  const motivo = motivoParaExcluir({
    contactId: contatoAtual.id,
    telefone: contatoAtual.phone_number,
    email: contatoAtual.email,
    telegramChatId: contatoAtual.social_identity?.startsWith("telegram:")
      ? contatoAtual.social_identity.replace(/^telegram:/, "")
      : null,
    bloqueado: contatoAtual.is_blocked,
    anonimizado: contatoAtual.is_anonymized,
    recusouMarketing: recusouMarketing(contatoAtual.consent),
    canal,
  }, canal);
  const endereco = (contatoAtual.phone_number ?? alvo.recipient_address ?? "").trim();
  let suprimido = false;
  if (!motivo && endereco) {
    const { data: suppressions, error: suppressionError } = await admin
      .from("campaign_suppressions")
      .select("id")
      .eq("organization_id", campanha.organization_id)
      .eq("recipient_address_hash", hashDoEndereco(endereco))
      .maybeSingle();
    if (suppressionError) {
      await atualizarSequencia(admin, alvo, indice, {
        status: "pending",
        sending_at: null,
        next_attempt_at: new Date(agora.getTime() + 60_000).toISOString(),
      });
      return false;
    }
    suprimido = !!suppressions;
  }
  if (!motivo && !suprimido) return true;
  const optedOut = motivo === "opt_out";
  await atualizarSequencia(admin, alvo, indice, {
    status: optedOut ? "opted_out" : "skipped",
    sending_at: null,
    eligibility_status: "excluded",
    exclusion_reason: motivo ?? "suprimido",
    opted_out_at: optedOut ? agora.toISOString() : null,
  });
  return false;
}

async function enviarSequenciaDeBaloes(input: {
  admin: SupabaseClient;
  pool: ReturnType<typeof getRequestPool>;
  campanha: CampanhaRow;
  alvo: DestinatarioRow;
  sessionId: string;
  corpo: string;
  baloes: string[];
  indiceInicial: number;
  continuacao: boolean;
  knobs: PacingKnobs;
  numeroAtivadoEm: Date | null;
  intervaloMinimoMs: number;
  limiteDiario: number | null;
  requestReason: string;
  agora: Date;
}): Promise<{ enviadas: number; pulados: number; concluidas: number; detalhe: string }> {
  const { admin, pool, campanha, alvo, baloes, sessionId } = input;
  const inicioRelogio = Date.now();
  const instante = () => new Date(input.agora.getTime() + (Date.now() - inicioRelogio));
  const inicio = Math.min(input.indiceInicial, baloes.length - 1);
  const leaseAt = instante();
  const reserva = input.continuacao
    ? await reivindicarContinuacaoDeBaloes(admin, alvo, leaseAt)
    : await reservarDestinatario(admin, alvo.id, leaseAt, {
        renderedBody: input.corpo,
        channelSessionId: sessionId,
        splitBubbleCount: baloes.length,
        organizationId: campanha.organization_id,
      });
  if (!reserva.reservado) {
    return {
      enviadas: 0,
      pulados: 0,
      concluidas: 0,
      detalhe: reserva.erro ? `erro_na_reserva:${reserva.erro.slice(0, 40)}` : "ja_reservado",
    };
  }
  const claimed: DestinatarioRow = {
    ...alvo,
    organization_id: campanha.organization_id,
    status: "sending",
    sending_at: leaseAt.toISOString(),
    channel_session_id: sessionId,
    rendered_body: input.corpo,
    split_bubble_count: baloes.length,
    next_bubble_index: inicio,
  };

  try {
    const boundary = await beginServiceAtOrigin(
      admin,
      campanha.organization_id,
      alvo.contact_id,
      sessionId,
    );
    const { error: boundaryError } = await admin
      .from("campaign_recipients")
      .update({ conversation_id: boundary.conversation_id, channel_session_id: sessionId })
      .eq("organization_id", campanha.organization_id)
      .eq("id", alvo.id)
      .eq("status", "sending")
      .eq("sending_at", claimed.sending_at!);
    if (boundaryError) throw new Error("campaign_conversation_checkpoint_failed");

    let enviadas = 0;
    for (let indice = inicio; indice < baloes.length; indice += 1) {
      const agora = instante();
      if (indice > inicio) {
        if (await interromperSeCampanhaParou(admin, campanha, claimed, indice, agora)) {
          return { enviadas, pulados: 0, concluidas: 0, detalhe: "sequencia:campanha_interrompida" };
        }
        if (!(await verificarElegibilidadeAntesDoProximoBalao(admin, campanha, claimed, indice, agora))) {
          return { enviadas, pulados: 1, concluidas: 0, detalhe: "sequencia:elegibilidade_revalidada" };
        }
        const state = await loadPacingState(pool, campanha.organization_id, sessionId, {
          now: agora,
          timezone: input.knobs.timezone,
          numberActivatedAt: input.numeroAtivadoEm,
        });
        const pacing = decidePacing({
          now: agora,
          knobs: input.knobs,
          state,
          crmDailyLimit: input.limiteDiario,
          minimumIntervalMs: input.intervaloMinimoMs,
        });
        if (!pacing.allow) {
          await adiarDestinatario(admin, claimed, pacing.nextAllowedAt);
          return { enviadas, pulados: 0, concluidas: 0, detalhe: `sequencia:ritmo:${pacing.code}` };
        }
        if (pacing.waitMs > MAX_ESPERA_INLINE_BOLHA_MS) {
          await adiarDestinatario(admin, claimed, new Date(agora.getTime() + pacing.waitMs));
          return { enviadas, pulados: 0, concluidas: 0, detalhe: "sequencia:retomada_por_pacing" };
        }
        if (pacing.waitMs > 0) await new Promise<void>((resolve) => setTimeout(resolve, pacing.waitMs));
      }

      const enviadoEm = instante();
      const messageId = idDaMensagemDaBolha(campanha.id, alvo.id, indice);
      const { data: existente, error: erroExistente } = await admin
        .from("messages")
        .select("id, status, sent_at, delivered_at, read_at, error_code, error_message")
        .eq("organization_id", campanha.organization_id)
        .eq("id", messageId)
        .maybeSingle();
      if (erroExistente) throw new Error("campaign_bubble_idempotency_read_failed");

      let mensagem: { id?: string; status?: string; sent_at?: string | null; delivered_at?: string | null; read_at?: string | null };
      if (existente) {
        mensagem = existente as typeof mensagem;
        if (["sent", "delivered", "read"].includes(mensagem.status ?? "")) {
          // Replay do ledger é conservador: se o processo caiu entre o envio e
          // o checkpoint, uma entrada duplicada só desacelera o número; nunca
          // permite ultrapassar o pacing.
          await recordSend(pool, campanha.organization_id, sessionId, enviadoEm);
        } else if (mensagem.status === "queued") {
          const linked = await atualizarSequencia(admin, claimed, indice, {
            status: "queued",
            message_id: messageId,
            sending_at: null,
            next_attempt_at: null,
          });
          if (!linked) {
            return { enviadas, pulados: 0, concluidas: 0, detalhe: "sequencia:claim_perdido" };
          }
          const ack = await reconciliarAckDaBolha({
            admin,
            pool,
            campanha,
            destinatarioId: alvo.id,
            sessionId,
            messageId,
            indice,
            quantidade: baloes.length,
            enviadoEm,
          });
          return { enviadas, pulados: 0, concluidas: 0, detalhe: ack ? "sequencia:ack_antecipado" : "sequencia:aguardando_ack" };
        } else if (mensagem.status === "sending") {
          await adiarDestinatario(admin, claimed, new Date(enviadoEm.getTime() + LEASE_BOLHA_MS));
          return { enviadas, pulados: 0, concluidas: 0, detalhe: "sequencia:mensagem_em_recuperacao" };
        } else {
          await atualizarSequencia(admin, claimed, indice, {
            status: "failed",
            message_id: messageId,
            sending_at: null,
            last_error_code: "send_failed",
          });
          return { enviadas, pulados: 0, concluidas: 0, detalhe: "sequencia:mensagem_ja_falhou" };
        }
      } else {
        const enviada = await sendMessageHandler(
          admin,
          {
            organization_id: campanha.organization_id,
            serviceBoundary: boundary,
            proactiveContext: { organizationId: campanha.organization_id, contactId: alvo.contact_id },
            actor: { type: "webhook_source", id: `campaign:${campanha.id}` },
            requestId: `campaign:${campanha.id}:${alvo.id}:bubble:${indice + 1}`,
            internalMessageId: messageId,
          } as Parameters<typeof sendMessageHandler>[1],
          {
            conversation_id: boundary.conversation_id,
            type: "text",
            body: baloes[indice],
            metadata: {
              source: "campaign",
              campaign_id: campanha.id,
              campaign_recipient_id: alvo.id,
              campaign_content_version: campanha.content_version,
              bubble_index: indice + 1,
              bubble_count: baloes.length,
              idempotency_key: chaveDaBolha(campanha.id, alvo.id, indice),
            },
          } as Parameters<typeof sendMessageHandler>[2],
        ) as { id?: string; status?: string; sent_at?: string | null; delivered_at?: string | null; read_at?: string | null };
        mensagem = enviada;
        if (mensagem.status === "failed") {
          await atualizarSequencia(admin, claimed, indice, {
            status: "failed",
            message_id: mensagem.id ?? messageId,
            sending_at: null,
            sent_at: null,
            last_error_code: "send_failed",
          });
          return { enviadas, pulados: 0, concluidas: 0, detalhe: `sequencia:falha_balao_${indice + 1}` };
        }
        if (mensagem.status === "queued") {
          const linked = await atualizarSequencia(admin, claimed, indice, {
            status: "queued",
            message_id: mensagem.id ?? messageId,
            sending_at: null,
            next_attempt_at: null,
          });
          if (!linked) {
            return { enviadas, pulados: 0, concluidas: 0, detalhe: "sequencia:claim_perdido" };
          }
          const ack = await reconciliarAckDaBolha({
            admin,
            pool,
            campanha,
            destinatarioId: alvo.id,
            sessionId,
            messageId: mensagem.id ?? messageId,
            indice,
            quantidade: baloes.length,
            enviadoEm,
          });
          return { enviadas, pulados: 0, concluidas: 0, detalhe: ack ? "sequencia:ack_antecipado" : "sequencia:aguardando_ack" };
        }
        if (!["sent", "delivered", "read"].includes(mensagem.status ?? "")) {
          await atualizarSequencia(admin, claimed, indice, {
            status: "failed",
            message_id: mensagem.id ?? messageId,
            sending_at: null,
            last_error_code: "send_state_unknown",
          });
          return { enviadas, pulados: 0, concluidas: 0, detalhe: "sequencia:estado_desconhecido" };
        }
        await recordSend(pool, campanha.organization_id, sessionId, enviadoEm);
      }

      const final = indice === baloes.length - 1;
      const statusFinal = mensagem.status === "read" ? "read" : mensagem.status === "delivered" ? "delivered" : "sent";
      const renewedLeaseAt = final ? null : instante().toISOString();
      const checkpointOk = await atualizarSequencia(admin, claimed, indice, {
        next_bubble_index: indice + 1,
        status: final ? statusFinal : "sending",
        sending_at: renewedLeaseAt,
        next_attempt_at: null,
        sent_at: final ? (mensagem.sent_at ?? enviadoEm.toISOString()) : null,
        delivered_at: final ? (mensagem.delivered_at ?? null) : null,
        read_at: final ? (mensagem.read_at ?? null) : null,
        message_id: final ? (mensagem.id ?? messageId) : null,
        last_error_code: null,
        last_error_detail: null,
      });
      if (!checkpointOk) {
        return { enviadas, pulados: 0, concluidas: 0, detalhe: "sequencia:checkpoint_concorrente" };
      }
      if (renewedLeaseAt) {
        claimed.sending_at = renewedLeaseAt;
        claimed.next_bubble_index = indice + 1;
      }
      enviadas += 1;
      if (final) {
        return { enviadas, pulados: 0, concluidas: 0, detalhe: `baloes:${enviadas}:${input.requestReason}` };
      }
    }
    return { enviadas, pulados: 0, concluidas: 0, detalhe: `baloes:${enviadas}:${input.requestReason}` };
  } catch (err) {
    logger.warn("[campanha] sequência de balões falhou", { campanhaId: campanha.id, destinatarioId: alvo.id });
    return {
      enviadas: 0,
      pulados: 0,
      concluidas: 0,
      detalhe: await registrarExcecaoDoEnvio(admin, alvo.id, err, campanha.organization_id),
    };
  }
}

/**
 * O que a exceção do envio faz com o destinatário já reservado (`sending`).
 * Exportada para o teste: o caminho inteiro da rodada precisa de ritmo, canal
 * e pool.
 *
 * Organização parada entre a leitura da rodada e o envio (`OrgNaoOperanteError`
 * da porta de saída) NÃO é falha do destinatário: ele volta a `pending` e sai
 * na reativação, no ritmo da campanha. Marcar `send_exception` o tiraria da
 * campanha para sempre por algo que não é dele.
 */
export async function registrarExcecaoDoEnvio(
  admin: SupabaseClient,
  destinatarioId: string,
  err: unknown,
  organizationId?: string,
): Promise<string> {
  if (err instanceof OrgNaoOperanteError) {
    let consulta = admin
      .from("campaign_recipients")
      .update({ status: "pending", sending_at: null })
      .eq("id", destinatarioId)
      .eq("status", "sending");
    if (organizationId) consulta = consulta.eq("organization_id", organizationId);
    await consulta;
    return "org_nao_operante";
  }
  const motivoErro = err instanceof Error ? err.message : String(err);
  let consulta = admin
    .from("campaign_recipients")
    .update({
      status: "failed",
      last_error_code: "send_exception",
      last_error_detail: motivoErro.slice(0, 300),
    })
    .eq("id", destinatarioId)
    .eq("status", "sending");
  if (organizationId) consulta = consulta.eq("organization_id", organizationId);
  await consulta;
  return "falhou";
}

/**
 * Reserva o destinatário para ESTA rodada: `pending` → `sending`, em
 * compare-and-set.
 *
 * ═══ Por que o erro é devolvido, e não engolido ═══
 *
 * A primeira versão lia só o `data` do update. Qualquer falha dura — e houve
 * uma, a FK de `message_id` — virava "zero linhas", que o chamador lia como
 * "outro worker ganhou a corrida". Resultado medido em produção: a campanha
 * ficava `running` para sempre, o destinatário `pending` com zero tentativas, e
 * o cron respondia `ja_reservado` a cada minuto. Um erro disfarçado de
 * concorrência é a pior espécie: ele descreve um sistema saudável.
 */
export async function reservarDestinatario(
  admin: SupabaseClient,
  destinatarioId: string,
  agora: Date,
  sequencia?: {
    renderedBody: string;
    channelSessionId: string;
    splitBubbleCount: number;
    organizationId: string;
  },
): Promise<{ reservado: boolean; erro?: string }> {
  let consulta = admin
    .from("campaign_recipients")
    .update({
      status: "sending",
      sending_at: agora.toISOString(),
      last_attempt_at: agora.toISOString(),
      attempt_count: 1,
      ...(sequencia
        ? {
            rendered_body: sequencia.renderedBody,
            channel_session_id: sequencia.channelSessionId,
            split_bubble_count: sequencia.splitBubbleCount,
            next_bubble_index: 0,
          }
        : {}),
    })
    .eq("id", destinatarioId)
    .eq("status", "pending");
  if (sequencia) {
    consulta = consulta.eq("organization_id", sequencia.organizationId);
    consulta = consulta.or(`next_attempt_at.is.null,next_attempt_at.lte.${agora.toISOString()}`);
  }
  const { data, error } = await consulta.select("id");
  if (error) {
    logger.warn("[campanha] reserva do destinatário falhou", {
      destinatario: destinatarioId,
      motivo: error.message,
    });
    return { reservado: false, erro: error.message };
  }
  return { reservado: (data ?? []).length > 0 };
}

/**
 * Os números que esta campanha pode usar: o principal mais os vinculados.
 *
 * Falha ABERTA no principal: se a consulta dos vinculados quebrar, a campanha
 * segue falando pelo número principal em vez de parar. Rodízio é otimização;
 * parar de enviar por causa dela seria o remédio pior que a doença.
 */
async function numerosDaCampanha(admin: SupabaseClient, campanha: CampanhaRow): Promise<string[]> {
  const { data, error } = await admin
    .from("campaign_channel_sessions")
    .select("channel_session_id")
    .eq("organization_id", campanha.organization_id)
    .eq("campaign_id", campanha.id);
  if (error) {
    logger.warn("[campanha] pool de números falhou; seguindo pelo principal", {
      campanha: campanha.id,
      motivo: error.message,
    });
    return [campanha.channel_session_id];
  }
  return poolDaCampanha(
    campanha.channel_session_id,
    (data ?? []).map((l) => (l as { channel_session_id: string }).channel_session_id),
  );
}

/**
 * O número em que esta pessoa JÁ conversa, se houver.
 *
 * A conversa mais recente ganha: se ela falou com dois números da empresa, o
 * último é o que ela tem na cabeça.
 */
async function numeroDoHistorico(
  admin: SupabaseClient,
  campanha: CampanhaRow,
  contactId: string,
): Promise<string | null> {
  const { data } = await admin
    .from("conversations")
    .select("channel_session_id, last_message_at")
    .eq("organization_id", campanha.organization_id)
    .eq("contact_id", contactId)
    .order("last_message_at", { ascending: false, nullsFirst: false })
    .limit(1);
  const linha = (data ?? [])[0] as { channel_session_id: string } | undefined;
  return linha?.channel_session_id ?? null;
}

/** Quantas saíram hoje e na última hora, mais o último envio — o estado do ritmo. */
export async function estadoDeEnvio(
  admin: SupabaseClient,
  campanhaId: string,
  agora: Date,
  fuso: string,
  opcoes?: { organizationId: string; contarMensagensFisicas: true },
): Promise<{ ultimoEnvio: Date | null; enviadasHoje: number; enviadasNaUltimaHora: number }> {
  // O dia do teto diário é o dia DO CLIENTE, como o resto do ritmo. Ver a nota
  // no chamador: `setUTCHours` fazia o dia virar 21h em `America/Sao_Paulo`.
  const inicioDoDia = dayStartInTz(agora, fuso);
  if (opcoes?.contarMensagensFisicas) {
    const umaHoraAtras = new Date(agora.getTime() - 3_600_000).toISOString();
    const { count: hoje, error: hojeError } = await admin
      .from("messages")
      .select("id", { count: "exact", head: true })
      .eq("organization_id", opcoes.organizationId)
      .eq("direction", "outbound")
      .in("status", ["sent", "delivered", "read"])
      .contains("metadata", { campaign_id: campanhaId })
      .not("sent_at", "is", null)
      .gte("sent_at", inicioDoDia.toISOString());
    const { count: hora, error: horaError } = await admin
      .from("messages")
      .select("id", { count: "exact", head: true })
      .eq("organization_id", opcoes.organizationId)
      .eq("direction", "outbound")
      .in("status", ["sent", "delivered", "read"])
      .contains("metadata", { campaign_id: campanhaId })
      .not("sent_at", "is", null)
      .gte("sent_at", umaHoraAtras);
    const { data: ultima, error: ultimaError } = await admin
      .from("messages")
      .select("sent_at")
      .eq("organization_id", opcoes.organizationId)
      .eq("direction", "outbound")
      .in("status", ["sent", "delivered", "read"])
      .contains("metadata", { campaign_id: campanhaId })
      .not("sent_at", "is", null)
      .order("sent_at", { ascending: false })
      .limit(1);
    if (hojeError || horaError || ultimaError) {
      logger.warn("[campanha] leitura de contagem física falhou; bloqueando por segurança", {
        campanhaId,
        motivo: hojeError?.code ?? horaError?.code ?? ultimaError?.code ?? "query_failed",
      });
      return {
        ultimoEnvio: null,
        enviadasHoje: Number.MAX_SAFE_INTEGER,
        enviadasNaUltimaHora: Number.MAX_SAFE_INTEGER,
      };
    }
    const sentAt = (ultima ?? [])[0] as { sent_at: string } | undefined;
    return {
      ultimoEnvio: sentAt ? new Date(sentAt.sent_at) : null,
      enviadasHoje: hoje ?? 0,
      enviadasNaUltimaHora: hora ?? 0,
    };
  }

  const { data } = await admin
    .from("campaign_recipients")
    .select("sent_at")
    .eq("campaign_id", campanhaId)
    .not("sent_at", "is", null)
    .gte("sent_at", inicioDoDia.toISOString())
    .order("sent_at", { ascending: false });

  const enviados = (data ?? []).map((r) => new Date((r as { sent_at: string }).sent_at));
  const umaHoraAtras = agora.getTime() - 3_600_000;
  return {
    ultimoEnvio: enviados[0] ?? null,
    enviadasHoje: enviados.length,
    enviadasNaUltimaHora: enviados.filter((d) => d.getTime() >= umaHoraAtras).length,
  };
}

/** Exportado só para a tela e o teste lerem a mesma frase do motivo. */
export { TEXTO_DA_EXCLUSAO };
