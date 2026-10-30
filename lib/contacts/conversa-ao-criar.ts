import type { SupabaseClient } from "@supabase/supabase-js";

import { ensureConversation, sessaoProntaParaEnvio } from "@/lib/automation/start-conversation";
import { logger } from "@/lib/logger";

export type PortaDaCriacao = "manual" | "importacao_csv" | "prospeccao";

const ABRE_CONVERSA: Readonly<Record<PortaDaCriacao, boolean>> = {
  manual: true,
  importacao_csv: false,
  // A prospecção abre explicitamente na sessão da campanha depois de criar o lead.
  prospeccao: false,
};

export function abreConversaAoCriar(porta: PortaDaCriacao): boolean {
  return ABRE_CONVERSA[porta];
}

export interface ContatoRecemCriado {
  porta: PortaDaCriacao;
  organizationId: string;
  contactId: string;
  phoneNumber: string | null;
  requestId?: string;
}

export type DesfechoDaConversa =
  | { aberta: true; conversationId: string }
  | {
      aberta: false;
      motivo: "porta_nao_abre" | "fluxo_proprio" | "sem_telefone" | "sem_sessao" | "falhou";
    };

function mensagemDoErro(erro: unknown): string {
  if (erro instanceof Error) return erro.message;
  if (typeof erro === "string" && erro.trim()) return erro;
  if (erro && typeof erro === "object") {
    const mensagem = (erro as { message?: unknown }).message;
    if (typeof mensagem === "string" && mensagem.trim()) return mensagem;
  }
  return "erro_desconhecido";
}

function detalheSeguro(erro: unknown): string {
  return mensagemDoErro(erro)
    .replace(/\b[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}\b/g, "[email]")
    .replace(/\+?\d(?:[\d\s().-]{6,}\d)/g, "[telefone]")
    .replace(/[\r\n\t]+/g, " ")
    .slice(0, 300);
}

/** A abertura é posterior ao cadastro: falha aqui nunca desfaz nem rejeita o contato. */
export async function abrirConversaDoContatoNovo(
  supabase: SupabaseClient,
  contato: ContatoRecemCriado,
): Promise<DesfechoDaConversa> {
  // Esta decisão ocorre antes do primeiro acesso ao banco: CSV e prospecção usam
  // seus fluxos explícitos e nunca consultam sessões por este seam.
  if (contato.porta === "prospeccao") return { aberta: false, motivo: "fluxo_proprio" };
  if (!abreConversaAoCriar(contato.porta)) return { aberta: false, motivo: "porta_nao_abre" };
  if (!contato.phoneNumber) return { aberta: false, motivo: "sem_telefone" };

  try {
    const sessionId = await sessaoProntaParaEnvio(supabase, contato.organizationId, {
      preferirTelefone: true,
      propagarErro: true,
    });
    if (!sessionId) return { aberta: false, motivo: "sem_sessao" };

    const conversationId = await ensureConversation(
      supabase,
      contato.organizationId,
      contato.contactId,
      sessionId,
    );
    return { aberta: true, conversationId };
  } catch (erro) {
    logger.warn("contato criado: a conversa não abriu; o contato continua criado", {
      organization_id: contato.organizationId,
      contact_id: contato.contactId,
      porta: contato.porta,
      request_id: contato.requestId,
      detail: detalheSeguro(erro),
    });
    return { aberta: false, motivo: "falhou" };
  }
}
