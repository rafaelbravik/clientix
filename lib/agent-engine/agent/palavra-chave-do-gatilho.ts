import type { Queryable } from "../queue/queue";

export type ResultadoDoFiltroDeEntrada =
  | "sem_filtro"
  | "regex_invalida"
  | "sem_texto"
  | "corresponde"
  | "nao_corresponde";

/** O gatilho só bloqueia a primeira entrada; nunca silencia agente já engajado. */
export function deveBloquearEntradaDoAgente(
  resultado: ResultadoDoFiltroDeEntrada,
  agenteJaEngajado: boolean,
): boolean {
  return resultado === "nao_corresponde" && !agenteJaEngajado;
}

/** Lê apenas `trigger_config.filters.keyword_regex`; o JSON do banco é livre. */
export function lerFiltroDeEntrada(triggerConfig: unknown): string | null {
  if (typeof triggerConfig !== "object" || triggerConfig === null) return null;
  const filters = (triggerConfig as { filters?: unknown }).filters;
  if (typeof filters !== "object" || filters === null) return null;
  const regex = (filters as { keyword_regex?: unknown }).keyword_regex;
  return typeof regex === "string" && regex.trim() !== "" ? regex : null;
}

/**
 * Avalia o lote de mensagens ainda sem resposta para a admissão do agente.
 * A regex inválida e um lote sem texto são fail-open, como no contrato upstream.
 */
export function avaliarFiltroDeEntrada(
  regex: string | null,
  mensagens: readonly (string | null | undefined)[],
): ResultadoDoFiltroDeEntrada {
  if (regex === null || regex.trim() === "") return "sem_filtro";

  let padrao: RegExp;
  try {
    padrao = new RegExp(regex, "i");
  } catch {
    return "regex_invalida";
  }

  const textos = mensagens.filter(
    (mensagem): mensagem is string =>
      typeof mensagem === "string" &&
      mensagem.trim() !== "" &&
      !/^\[[a-z_]+\]$/i.test(mensagem.trim()),
  );
  if (textos.length === 0) return "sem_texto";
  return textos.some((texto) => padrao.test(texto)) ? "corresponde" : "nao_corresponde";
}

/**
 * A conversa só está engajada para este agente quando ele já enviou uma
 * mensagem outbound não falha dentro do serviço atual. `active_ai_agent_id`
 * é só estado de roteamento e pode ser gravado antes de qualquer resposta.
 */
export async function agenteJaRespondeuNoServico(
  db: Queryable,
  input: { organizationId: string; conversationId: string; agentId: string },
): Promise<boolean> {
  const { rows } = await db.query<{ ja_respondeu: boolean }>(
    `select exists (
       select 1
         from messages m
         join conversations c
           on c.organization_id = m.organization_id
          and c.id = m.conversation_id
        where m.organization_id = $1
          and m.conversation_id = $2
          and m.direction = 'outbound'
          and m.sent_via = 'ai'
          and m.metadata ->> 'ai_actor_id' = $3
          and m.status <> 'failed'
          and (c.service_started_at is null or m.sent_at >= c.service_started_at)
     ) as ja_respondeu`,
    [input.organizationId, input.conversationId, input.agentId],
  );
  return rows[0]?.ja_respondeu === true;
}
