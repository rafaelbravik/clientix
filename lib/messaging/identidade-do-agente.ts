import type { SupabaseClient } from "@supabase/supabase-js";

import type { Actor } from "@/lib/api/handlers/types";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/**
 * ID canônico de `ai_agents` para uma mensagem de autoria IA.
 *
 * `actor.id` pode ser run, regra, token ou identificador do engine. Somente
 * `agent_id` é aceito, e a variante webhook só pode usá-lo quando declara que
 * o texto foi realmente escrito pela IA.
 */
export function idDoAgenteEmissor(actor: Actor): string | null {
  const id =
    actor.type === "ai_agent"
      ? actor.agent_id
      : actor.type === "webhook_source" && actor.textoEscritoPelaIA === true
        ? actor.agent_id
        : undefined;

  return typeof id === "string" && UUID.test(id) ? id : null;
}

/** Resolve o nome pelo par tenant + agente; falha de leitura só remove o nome. */
export async function nomeDoAgenteEmissor(
  supabase: SupabaseClient,
  organizationId: string,
  actor: Actor,
): Promise<string | null> {
  const agentId = idDoAgenteEmissor(actor);
  if (!agentId || !UUID.test(organizationId)) return null;

  try {
    const { data, error } = await supabase
      .from("ai_agents")
      .select("name")
      .eq("organization_id", organizationId)
      .eq("id", agentId)
      .maybeSingle();

    if (error || typeof data?.name !== "string") return null;
    return data.name.trim() || null;
  } catch {
    return null;
  }
}

/** Metadata reservada: entrada do cliente nunca determina o nome exibido. */
export function metadataComNomeDoAgente(
  metadata: Record<string, unknown> | undefined,
  mensagemDeIA: boolean,
  nome: string | null,
): Record<string, unknown> {
  const metadataPreservado = { ...(metadata ?? {}) };
  delete metadataPreservado.ai_actor_name;
  if (!mensagemDeIA) return metadataPreservado;

  return {
    ...metadataPreservado,
    ai_actor_name: typeof nome === "string" && nome.trim() ? nome.trim() : null,
  };
}
