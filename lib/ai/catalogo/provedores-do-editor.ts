import { PROVEDORES } from "@/lib/ai/pontos/provedores";
import {
  CHATGPT_SUBSCRIPTION_PROVIDER,
  CHATGPT_SUBSCRIPTION_PROVIDER_DESCRIPTION,
  CHATGPT_SUBSCRIPTION_PROVIDER_LABEL,
} from "@/lib/ai/credenciais/chatgpt-subscription-constants";

export const PROVEDOR_DE_ASSINATURA_PARA_EDITOR = {
  id: CHATGPT_SUBSCRIPTION_PROVIDER,
  rotulo: CHATGPT_SUBSCRIPTION_PROVIDER_LABEL,
  quandoUsar: CHATGPT_SUBSCRIPTION_PROVIDER_DESCRIPTION,
} as const;

export type ProvedorDoEditor =
  | (typeof PROVEDORES)[number]["id"]
  | typeof CHATGPT_SUBSCRIPTION_PROVIDER;

/** A oferta só aparece quando o módulo está ligado e a conta está conectada. */
export function provedoresDoEditorAgente(
  loginCodexLigado: boolean,
  assinaturaConectada: boolean,
) {
  return loginCodexLigado && assinaturaConectada
    ? [...PROVEDORES, PROVEDOR_DE_ASSINATURA_PARA_EDITOR]
    : PROVEDORES;
}
