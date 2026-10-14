import { SOCIAL_NETWORKS } from "./social/catalog";

/**
 * O QUE PODE SER GRAVADO EM `conversations.channel`.
 *
 * O catálogo social (`SOCIAL_NETWORKS[].inbox`) fornece os canais atendidos
 * pelo parceiro. Os canais nativos da aplicação — WhatsApp, e-mail e WebChat —
 * não pertencem a esse catálogo e são declarados aqui. WebChat é customer-side:
 * suas rotas criam conversas que são gravadas em `conversations.channel`.
 *
 * O invariante `canal-da-conversa-banco-x-catalogo.test.ts` lê a CHECK real do
 * Postgres e exige igualdade exata com este valor derivado. Assim, um canal
 * social novo entra pelo catálogo do provider, enquanto um canal nativo precisa
 * ser explicitamente incluído aqui e na migration/baseline correspondente.
 * Nenhum dos dois caminhos pode divergir do banco silenciosamente.
 */
export const CANAIS_DE_CONVERSA = [
  "whatsapp",
  "email",
  "webchat",
  ...SOCIAL_NETWORKS.filter((rede) => rede.inbox).map((rede) => rede.id),
] as const satisfies readonly string[];

export type CanalDeConversa = (typeof CANAIS_DE_CONVERSA)[number];

/**
 * `true` quando este valor pode ir para `conversations.channel`.
 *
 * Aceita `string` de propósito: quem chama está com um valor vindo do
 * provedor externo, não de um tipo nosso.
 */
export function ehCanalDeConversa(valor: string | null | undefined): boolean {
  return typeof valor === "string" && (CANAIS_DE_CONVERSA as readonly string[]).includes(valor);
}
