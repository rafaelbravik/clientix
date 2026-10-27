/**
 * O CASO QUE NINGUÉM ABRIU VOLTA A PEDIR PASSAGEM.
 *
 * Um caso em `awaiting_human` é a IA esperando uma pessoa destravar alguma
 * coisa, com um cliente do outro lado. Se ninguém olha, ele fica lá — e nada no
 * sistema avisa. O cliente espera para sempre e a única evidência de que ele
 * existiu é uma linha numa tela que ninguém abriu naquele dia.
 *
 * ⚠️ ISTO NÃO É HIPÓTESE. Medido num CRM em produção com o mesmo desenho de
 * fila (2026-09-14): **22 pedidos parados, o mais antigo há 17,6 dias**, e onze
 * deles eram gente pedindo para falar com uma pessoa. A fila era usada — 72 de
 * 102 pedidos foram resolvidos — e mesmo assim esses 22 ficaram para trás,
 * porque não havia nada que os trouxesse de volta.
 *
 * ═══ POR QUE ESTE VIGIA COBRA SÓ NA CENTRAL ═══
 *
 * O destinatário da cobrança é a EQUIPE, não o cliente. Um aviso na Central
 * (com o sino) chega a quem pode resolver, não consome janela de envio do
 * WhatsApp, não gasta o número e não corre o risco de a cobrança interna vazar
 * para fora. O sistema que originou este defeito mandava WhatsApp para a dona do
 * negócio; aqui o canal certo já existe.
 *
 * ⚠️ **Isto vale para a COBRANÇA REPETIDA, que é o que este cron faz — e deixou
 * de valer para o produto inteiro** (migration 0292). O WhatsApp da equipe
 * passou a ser avisado na ABERTURA do caso, uma vez, por opt-in de quem
 * administra (`config_aviso_de_caso`, tela `/app/ai/cases/avisos`). Decisão do
 * dono do produto: quem toca uma empresa não fica com o CRM aberto o dia todo,
 * fica com o WhatsApp aberto.
 *
 * Os dois NÃO se sobrepõem, e é por isso que este cron continua só na Central:
 * o aviso no WhatsApp sai uma vez, na abertura; a insistência sobre o caso que
 * ninguém abriu é daqui, tem teto de três e mora no sino. Mandar a cobrança
 * repetida por mensagem gastaria o número da organização três vezes por caso
 * esquecido — e o `followup_attempts` que segura o teto não protege um canal
 * que ele não conhece. Quem for "consertar" isto e ligar o WhatsApp aqui está
 * mudando essa decisão, não completando-a.
 *
 * ═══ POR QUE ELE PARA DE COBRAR ═══
 *
 * `followup_attempts` continua sendo a métrica histórica de insistência. O teto
 * desta rotina agora usa `case_wait_reminders_sent`, que zera em cada nova
 * entrada do caso em `awaiting_human`.
 *
 * O padrão continua em três avisos por espera. Ao voltar de `awaiting_lead`, o
 * caso ganha um relógio e um teto novos; um alarme ilimitado treina a equipe a
 * ignorar o alarme certo — o mesmo argumento que o dedup da Central já faz.
 */
import { randomUUID } from "node:crypto";
import type { NextRequest } from "next/server";

import { ok, fail } from "@/lib/api/wrappers";
import { audit } from "@/lib/audit";
import { traduzir } from "@/lib/i18n/dicionario";
import { normalizarIdioma, type Idioma } from "@/lib/i18n/idiomas";
import { logger } from "@/lib/logger";
import { createAdminClient } from "@/lib/supabase/admin";
import { autorizaCron } from "@/lib/auth/cron-auth";

export const dynamic = "force-dynamic";

/** Teto por rodada. O cron permanece horário; o intervalo é por organização. */
const SILENCIO_ATE_COBRAR_MS = 24 * 60 * 60 * 1000;
const LIMITE_DA_VARREDURA = 200;
/** O limite dos avisos de passagem continua separado da cadência de casos. */
const TETO_DE_COBRANCAS = 3;

/**
 * O MESMO "há N dias", mas montado a partir de PEDAÇOS TRADUZÍVEIS.
 *
 * Monta a frase a partir de pedaços traduzíveis — `t("há 2 dias")` não casa
 * chave nenhuma no dicionário e devolveria o português para quem escolheu
 * espanhol, em silêncio, que é o modo de falha de i18n que esta casa já pagou.
 * Aqui o número fica fora da tradução e só as palavras passam por `t()`.
 *
 */
function esperaEmPalavras(horas: number, t: (texto: string) => string): string {
  const dias = Math.floor(horas / 24);
  if (dias >= 1) return `${t("há")} ${dias} ${dias === 1 ? t("dia") : t("dias")}`;
  const h = Math.max(1, Math.round(horas));
  return `${t("há")} ${h} ${h === 1 ? t("hora") : t("horas")}`;
}

async function handle(req: NextRequest): Promise<Response> {
  const requestId = randomUUID();

  if (!autorizaCron(req)) {
    return fail("forbidden", "Cron secret missing or invalid.", 403, { requestId });
  }

  const admin = createAdminClient();
  const agora = Date.now();
  const corte = new Date(agora - SILENCIO_ATE_COBRAR_MS).toISOString();
  const { data, error } = await admin.rpc("fn_claim_case_wait_reminders", {
    p_limit: LIMITE_DA_VARREDURA,
  });

  if (error) {
    logger.error("[case-stale-watcher] claim de casos falhou", { error: error.message, requestId });
    return fail("internal_error", "Falha ao buscar casos parados.", 500, { requestId });
  }

  const resumo = data?.[0] ?? { examinados: 0, avisados: 0, ja_avisados: 0 };
  const casosExaminados = resumo.examinados;
  const avisados = resumo.avisados;
  const jaAvisados = resumo.ja_avisados;

  // Rodada que não avisou ninguém NÃO é mutação e não audita (CLAUDE.md §Audit
  // log, vigiado por `cron-audita-so-quando-ha-efeito.test.ts`).
  if (avisados > 0) {
    await audit({
      action: "ai.caso_parado_cobrado",
      resourceType: "agent_case",
      requestId,
      metadata: { avisados, examinados: casosExaminados },
    });
  }

  const passagens = await cobrarPassagensEsquecidas(admin, corte, requestId);

  if (passagens.cobradas > 0) {
    await audit({
      action: "ai.passagem_parada_cobrada",
      resourceType: "conversation",
      requestId,
      metadata: { cobradas: passagens.cobradas, examinadas: passagens.examinadas },
    });
  }

  return ok(
    {
      examinados: casosExaminados,
      avisados,
      ja_avisados: jaAvisados,
      passagens_examinadas: passagens.examinadas,
      passagens_cobradas: passagens.cobradas,
    },
    { requestId },
  );
}

/* ───────────────────────────────────────────────────────────────────────────
 * O SEGUNDO BRAÇO — a passagem que ninguém assumiu
 * ────────────────────────────────────────────────────────────────────────── */

/**
 * O idioma da ORGANIZAÇÃO, com cache por rodada.
 *
 * Ninguém está logado quando um cron escreve, e o corpo do aviso é DADO na
 * Central — ela o mostra cru, de propósito, e há um teste que guarda isso. Então
 * a tradução acontece aqui, no instante do insert, e não na tela. Nunca lança:
 * aviso em português é infinitamente melhor que aviso nenhum.
 */
async function idiomaDaOrganizacao(
  admin: ReturnType<typeof createAdminClient>,
  organizationId: string,
  cache: Map<string, Idioma>,
): Promise<Idioma> {
  const guardado = cache.get(organizationId);
  if (guardado !== undefined) return guardado;
  let idioma: Idioma = "pt-BR";
  try {
    const { data } = await admin
      .from("organizations")
      .select("locale")
      .eq("id", organizationId)
      .maybeSingle();
    idioma = normalizarIdioma((data as { locale?: string | null } | null)?.locale ?? null);
  } catch {
    idioma = "pt-BR";
  }
  cache.set(organizationId, idioma);
  return idioma;
}

/**
 * VARRE AS PASSAGENS QUE NINGUÉM RECONHECEU E TRAZ O AVISO DE VOLTA.
 *
 * ═══ Por que este braço precisou existir ═══
 *
 * O reconhecimento da passagem (migration 0293) só acontece por GESTO de quem
 * chegou: alguém assume a conversa, ou a devolve ao automático. Ninguém cobra a
 * passagem em que ninguém chegou. E o braço de cima não cobre isso nem por
 * acidente: dos TREZE caminhos que passam conversa para uma pessoa, um único
 * nasce de caso — os outros doze (pedido explícito, ferramenta do modelo, teto
 * de gasto, sentimento, MCP, os cinco legados…) não têm `agent_case` nenhum.
 *
 * ⚠️ E a população não é hipótese: os 22 pedidos parados citados no topo deste
 * arquivo eram, em ONZE casos, gente pedindo para falar com uma pessoa.
 *
 * ═══ As três decisões, e o que cada uma evita ═══
 *
 *   · **Reusa o aviso `handoff` daquela conversa** (reabre o resolvido, atualiza
 *     o aberto) em vez de inserir um segundo. Dois avisos sobre o mesmo
 *     atendimento fazem a pessoa resolver um e continuar vendo o outro.
 *   · **Continua `warn`, nunca `critical`.** Há um cliente esperando, mas nada
 *     quebrou. O vermelho é para o que está fora do ar — usá-lo aqui o
 *     desvaloriza, que é o argumento que o braço de cima já faz.
 *   · **Para no terceiro.** `passagens_de_atendimento.cobrancas` (migration
 *     0294) segura o teto, pelo mesmo motivo de `agent_cases.followup_attempts`:
 *     quem ignorou três vezes não atende no quarto, e alarme que nunca cala
 *     treina a equipe a ignorar o alarme certo.
 *
 * Sem tabela nova, sem `kind` novo, sem evento novo.
 */
async function cobrarPassagensEsquecidas(
  admin: ReturnType<typeof createAdminClient>,
  corte: string,
  requestId: string,
): Promise<{ examinadas: number; cobradas: number }> {
  const { data, error } = await admin
    .from("passagens_de_atendimento")
    .select("id, organization_id, conversation_id, criado_em, cobrancas")
    .is("reconhecido_em", null)
    .lt("criado_em", corte)
    .lt("cobrancas", TETO_DE_COBRANCAS)
    .order("criado_em", { ascending: true })
    .limit(LIMITE_DA_VARREDURA);

  if (error) {
    logger.error("[case-stale-watcher] varredura de passagens falhou", {
      error: error.message,
      requestId,
    });
    return { examinadas: 0, cobradas: 0 };
  }

  const passagens = data ?? [];
  const idiomas = new Map<string, Idioma>();
  const agora = Date.now();
  let cobradas = 0;

  for (const p of passagens) {
    const orgId = p.organization_id as string;
    const conversaId = p.conversation_id as string;
    const tentativa = (p.cobrancas as number) + 1;
    const horas = (agora - Date.parse(p.criado_em as string)) / 3_600_000;
    const idioma = await idiomaDaOrganizacao(admin, orgId, idiomas);
    const t = (texto: string) => traduzir(texto, idioma);

    const titulo = `${t("Alguém pediu atendimento e ninguém assumiu")} — ${esperaEmPalavras(horas, t)}`;
    const corpo =
      t(
        "A IA passou esta conversa para uma pessoa e ninguém assumiu desde então. " +
          "Abra a conversa: o contexto do que já foi dito está lá.",
      ) +
      (tentativa >= TETO_DE_COBRANCAS
        ? ` ${t("Este é o último aviso automático sobre esta conversa.")}`
        : "");

    // O aviso mais recente daquela conversa, em QUALQUER estado: um resolvido
    // sem ninguém ter assumido é o caso que mais importa — ele sumiu da tela sem
    // o problema sumir junto.
    const { data: existente } = await admin
      .from("agent_inbox_items")
      .select("id, status")
      .eq("organization_id", orgId)
      .eq("kind", "handoff")
      .eq("ref_kind", "conversation")
      .eq("ref_id", conversaId)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();

    const erroDoAviso = existente
      ? (
          await admin
            .from("agent_inbox_items")
            .update({ status: "open", resolved_at: null, severity: "warn", title: titulo, body: corpo })
            .eq("id", (existente as { id: string }).id)
            .eq("organization_id", orgId)
        ).error
      : (
          await admin.from("agent_inbox_items").insert({
            organization_id: orgId,
            kind: "handoff",
            severity: "warn",
            title: titulo,
            body: corpo,
            ref_kind: "conversation",
            ref_id: conversaId,
          })
        ).error;

    if (erroDoAviso) {
      logger.error("[case-stale-watcher] cobrança da passagem não foi aberta", {
        passagem_id: p.id,
        organization_id: orgId,
        error: erroDoAviso.message,
        requestId,
      });
      continue;
    }

    // O contador sobe DEPOIS do aviso: subir antes faria uma falha de insert
    // gastar uma das três tentativas sem ninguém ter sido avisado de nada.
    const { error: erroContador } = await admin
      .from("passagens_de_atendimento")
      .update({ cobrancas: tentativa })
      .eq("id", p.id as string)
      .eq("organization_id", orgId);

    if (erroContador) {
      logger.error("[case-stale-watcher] contador da passagem não subiu", {
        passagem_id: p.id,
        error: erroContador.message,
        requestId,
      });
    }
    cobradas += 1;
  }

  return { examinadas: passagens.length, cobradas };
}

export const GET = handle;
export const POST = handle;
