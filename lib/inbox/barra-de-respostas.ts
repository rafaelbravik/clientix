import type { MessageTemplate } from "@/hooks/inbox/useMessageTemplates";

export const LIMITE_RESPOSTAS_RAPIDAS_RECOLHIDAS = 6;
const PREFIXO_PREFERENCIA = "inbox:respostas-rapidas:";

export function respostasVisiveisNaBarra(templates: MessageTemplate[]): MessageTemplate[] {
  // `undefined` é compatível com registros/cache anteriores à flag e equivale ao default true.
  return templates.filter((template) => template.mostrar_na_barra !== false);
}

export function respostasMostradas(
  templates: MessageTemplate[],
  expandida: boolean,
): { visiveis: MessageTemplate[]; restantes: number } {
  const permitidas = respostasVisiveisNaBarra(templates);
  if (expandida || permitidas.length <= LIMITE_RESPOSTAS_RAPIDAS_RECOLHIDAS) {
    return { visiveis: permitidas, restantes: 0 };
  }
  return {
    visiveis: permitidas.slice(0, LIMITE_RESPOSTAS_RAPIDAS_RECOLHIDAS),
    restantes: permitidas.length - LIMITE_RESPOSTAS_RAPIDAS_RECOLHIDAS,
  };
}

function obterStorage(storage?: Storage): Storage | null {
  if (storage) return storage;
  try {
    return typeof window === "undefined" ? null : window.localStorage;
  } catch {
    return null;
  }
}

export function chaveDaPreferenciaDaBarra(usuarioId: string): string {
  return `${PREFIXO_PREFERENCIA}${usuarioId}`;
}

export function lerBarraExpandida(usuarioId: string | null, storage?: Storage): boolean {
  if (!usuarioId) return false;
  try {
    return obterStorage(storage)?.getItem(chaveDaPreferenciaDaBarra(usuarioId)) === "expanded";
  } catch {
    return false;
  }
}

export function salvarBarraExpandida(
  usuarioId: string | null,
  expandida: boolean,
  storage?: Storage,
): void {
  if (!usuarioId) return;
  try {
    obterStorage(storage)?.setItem(
      chaveDaPreferenciaDaBarra(usuarioId),
      expandida ? "expanded" : "collapsed",
    );
  } catch {
    // A preferência é cosmética; storage indisponível não bloqueia o Inbox.
  }
}
