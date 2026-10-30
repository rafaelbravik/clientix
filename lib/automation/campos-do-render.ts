import { camposDoFunil } from "@/lib/leads/campos-do-funil";
import type { CustomFieldDef } from "@/lib/schemas/settings";

const DEFINICOES_DE_LISTA = Symbol("definicoes-de-lista-do-render");

type DefinicaoDeLista = Pick<CustomFieldDef, "key" | "type" | "options">;
type ContextoComDefinicoes = Record<string, unknown> & {
  [DEFINICOES_DE_LISTA]?: Map<string, DefinicaoDeLista>;
};

const TIPOS_DE_LISTA: readonly string[] = ["select", "searchable_select", "multiselect"];

/** Anexa somente definições válidas, fora do espaço de nomes das variáveis. */
export function anexarDefinicoesDeLista(
  context: Record<string, unknown>,
  settings: Record<string, unknown> | null | undefined,
): void {
  const definitions = camposDoFunil(settings).filter(
    (field) =>
      TIPOS_DE_LISTA.includes(field.type) &&
      Array.isArray(field.options) &&
      field.options.length > 0,
  );
  if (definitions.length === 0) return;

  Object.defineProperty(context, DEFINICOES_DE_LISTA, {
    configurable: true,
    enumerable: false,
    value: new Map(definitions.map((field) => [field.key, field])),
  });
}

function definicoes(context: Record<string, unknown>): Map<string, DefinicaoDeLista> | undefined {
  return (context as ContextoComDefinicoes)[DEFINICOES_DE_LISTA];
}

export function resolverCampoPersonalizado(
  context: Record<string, unknown>,
  path: string,
): {
  recognized: boolean;
  value: unknown;
  definition?: DefinicaoDeLista;
} {
  const direct = /^((?:lead|contact)\.custom_fields)\.([\w]+)$/.exec(path);
  const shortcut = !path.includes(".") ? path : null;
  const key = direct?.[2] ?? shortcut;
  if (!key) return { recognized: false, value: undefined };

  const definitions = definicoes(context);
  const definition = definitions?.get(key);
  const leadFields = (context.lead as { custom_fields?: unknown } | undefined)?.custom_fields;
  const contactFields = (context.contact as { custom_fields?: unknown } | undefined)?.custom_fields;
  const ownsLeadValue =
    leadFields !== null &&
    typeof leadFields === "object" &&
    Object.prototype.hasOwnProperty.call(leadFields, key);
  const ownsContactValue =
    contactFields !== null &&
    typeof contactFields === "object" &&
    Object.prototype.hasOwnProperty.call(contactFields, key);

  if (!direct && definition === undefined && !ownsLeadValue && !ownsContactValue) {
    return { recognized: false, value: undefined };
  }

  const root =
    direct?.[1] === "contact.custom_fields" || (!ownsLeadValue && ownsContactValue)
      ? "contact"
      : "lead";
  const values = root === "contact" ? contactFields : leadFields;
  const value =
    values !== null && typeof values === "object"
      ? (values as Record<string, unknown>)[key]
      : undefined;

  return {
    recognized: true,
    value,
    ...(definition !== undefined ? { definition } : {}),
  };
}

/** Informa se um nome renderizável pertence a um campo do CRM deste contexto. */
export function ehVariavelDeCampoPersonalizado(
  context: Record<string, unknown>,
  path: string,
): boolean {
  return resolverCampoPersonalizado(context, path).recognized;
}

/** Um token simples ou explícito de custom field pode precisar de definições do funil. */
export function templatePodeUsarCampoPersonalizado(
  template: string,
  aliases: readonly string[],
): boolean {
  const pattern = /\{\{\s*([\w.]+)(?:\s*\|\s*"([^{}"]{0,200})")?\s*\}\}/g;
  for (const match of template.matchAll(pattern)) {
    const path = match[1]!;
    if (/^(?:lead|contact)\.custom_fields\.[\w]+$/.test(path)) return true;
    if (!path.includes(".") && !aliases.includes(path)) return true;
  }
  return false;
}

/** Traduz apenas valores declarados; valores antigos/desconhecidos continuam intactos. */
export function valorRenderizadoDeCampo(
  value: unknown,
  definition: DefinicaoDeLista | undefined,
): string {
  if (definition?.options === undefined || definition.options.length === 0)
    return textoAtual(value);

  const label = (item: unknown): string => {
    if (typeof item !== "string")
      return item === null || item === undefined ? "" : textoAtual(item);
    return definition.options?.find((option) => option.value === item)?.label ?? item;
  };

  if (Array.isArray(value)) return value.map(label).join(", ");
  return label(value);
}

function textoAtual(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (Array.isArray(value)) return String(value);
  if (typeof value === "object") return "";
  return String(value);
}
