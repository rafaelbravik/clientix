import { resolveField } from "@/lib/automation/conditions";
import {
  ehVariavelDeCampoPersonalizado,
  resolverCampoPersonalizado,
  valorRenderizadoDeCampo,
} from "@/lib/automation/campos-do-render";

const ALIASES: Record<string, string> = {
  nome: "contact.name",
  primeiro_nome: "contact.name",
  telefone: "contact.phone_number",
  email: "contact.email",
  protocolo: "conversation.protocolo",
};

/** Padrão único para renderização e descoberta das variáveis de mensagem. */
export const MARCACAO = /\{\{\s*([\w.]+)(?:\s*\|\s*"([^{}"]{0,200})")?\s*\}\}/g;

export interface OpcoesDeRender {
  /** Mantém tokens sem valor, como o follow-up fazia antes desta integração. */
  preserveUnknown?: boolean;
  /** No follow-up, muda apenas custom fields e preserva todo o resto do texto. */
  onlyCustomFields?: boolean;
}

/**
 * A marcação tem dono no CRM (contato ou negócio) — e por isso NÃO se preenche
 * de fora.
 *
 * Existe para quem recebe valor de terceiro (as variáveis do integrador em
 * `lib/operacao/modelos-de-mensagem.ts`): `{{nome}}` é alias de `contact.name`,
 * então um valor mandado para "nome" seria descartado em silêncio pelo render
 * — e quem mandou receberia o texto com a marcação vazia achando que preencheu.
 * A régua é por NOME, e não pelo dado: sem contato informado a marcação também
 * estaria vazia, e aí a recusa sumiria justamente no caso mais enganoso.
 */
export function marcacaoDoCrm(nome: string, context?: Record<string, unknown>): boolean {
  return (
    ALIASES[nome] !== undefined ||
    nome.startsWith("contact.") ||
    nome.startsWith("lead.") ||
    nome.startsWith("conversation.") ||
    (context !== undefined && ehVariavelDeCampoPersonalizado(context, nome))
  );
}

export function renderTemplate(
  template: string,
  context: Record<string, unknown>,
  options: OpcoesDeRender = {},
): string {
  return template.replace(
    new RegExp(MARCACAO.source, "g"),
    (match, path: string, fallback?: string) => {
      const alias = ALIASES[path];
      const customField = alias === undefined ? resolverCampoPersonalizado(context, path) : null;
      if (options.onlyCustomFields && !customField?.recognized) return match;

      const resolved = customField?.recognized
        ? customField.value
        : resolveField(context, alias ?? path);
      const vazio =
        resolved === null ||
        resolved === undefined ||
        (typeof resolved === "string" && resolved.trim() === "") ||
        (Array.isArray(resolved) && resolved.length === 0);
      if (vazio && fallback !== undefined) return fallback;
      if (resolved === undefined && options.preserveUnknown) return match;

      // `{{primeiro_nome}}` = primeira palavra do nome, como no Inbox e na campanha.
      const texto = customField?.recognized
        ? valorRenderizadoDeCampo(resolved, customField.definition)
        : String(resolved ?? "");
      return path === "primeiro_nome" ? (texto.trim().split(/\s+/)[0] ?? "") : texto;
    },
  );
}
