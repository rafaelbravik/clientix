import { z } from "zod";

const textoComExemplo = z.object({
  body_text: z.array(z.array(z.string().min(1).max(1024)).min(1).max(10)).min(1).max(5),
}).strict();

const exemploCabecalhoTexto = z.object({
  header_text: z.array(z.string().min(1).max(60)).min(1).max(10),
}).strict();

const exemploCabecalhoImagem = z.object({
  header_handle: z.array(z.string().trim().min(1).max(4096)).length(1),
}).strict();

const componenteCabecalho = z.union([
  z.object({
    type: z.literal("HEADER"),
    format: z.literal("TEXT"),
    text: z.string().trim().min(1).max(60),
    example: exemploCabecalhoTexto.optional(),
  }).strict(),
  z.object({
    type: z.literal("HEADER"),
    format: z.literal("IMAGE"),
    example: exemploCabecalhoImagem,
  }).strict(),
]);

const componenteCorpo = z.object({
  type: z.literal("BODY"),
  text: z.string().trim().min(1).max(1024),
  example: textoComExemplo.optional(),
}).strict();

const componenteRodape = z.object({
  type: z.literal("FOOTER"),
  text: z.string().trim().min(1).max(60),
}).strict();

const botao = z.discriminatedUnion("type", [
  z.object({ type: z.literal("QUICK_REPLY"), text: z.string().trim().min(1).max(25) }).strict(),
  z.object({
    type: z.literal("URL"),
    text: z.string().trim().min(1).max(25),
    url: z.string().trim().min(1).max(2000),
  }).strict(),
  z.object({
    type: z.literal("PHONE_NUMBER"),
    text: z.string().trim().min(1).max(25),
    phone_number: z.string().trim().min(1).max(32),
  }).strict(),
]);

const componenteBotoes = z.object({
  type: z.literal("BUTTONS"),
  buttons: z.array(botao).min(1).max(3),
}).strict();

const componente = z.union([
  componenteCabecalho,
  componenteCorpo,
  componenteRodape,
  componenteBotoes,
]);

/** Só os componentes que o formulário Clientix constrói; estrutura desconhecida é rejeitada. */
export const componentesDeTemplateMetaSchema = z.array(componente).min(1).max(10).superRefine((lista, ctx) => {
  const tipos = lista.map((item) => item.type);
  if (tipos.filter((tipo) => tipo === "BODY").length !== 1) {
    ctx.addIssue({ code: "custom", message: "Um modelo precisa de exatamente um corpo." });
  }
  if (new Set(tipos).size !== tipos.length) {
    ctx.addIssue({ code: "custom", message: "O modelo contém componentes repetidos." });
  }
  const ordem: Record<string, number> = { HEADER: 0, BODY: 1, FOOTER: 2, BUTTONS: 3 };
  if (tipos.some((tipo, index) => index > 0 && ordem[tipos[index - 1]!]! > ordem[tipo]!)) {
    ctx.addIssue({ code: "custom", message: "A ordem dos componentes não é suportada." });
  }
});

function handlesDeMidia(components: unknown[]): string[] {
  const handles: string[] = [];
  for (const item of components) {
    if (!item || typeof item !== "object" || Array.isArray(item)) continue;
    const header = item as { type?: unknown; format?: unknown; example?: { header_handle?: unknown } };
    if (header.type !== "HEADER" || header.format !== "IMAGE") continue;
    const handlesRaw = header.example?.header_handle;
    if (Array.isArray(handlesRaw)) {
      for (const handle of handlesRaw) if (typeof handle === "string") handles.push(handle);
    }
  }
  return handles;
}

/**
 * URLs de imagem novas só podem vir do upload privado desta organização.
 * Em edição, um handle opaco é aceito apenas se já constava no espelho oficial.
 */
export function midiaDeTemplatePermitida(input: {
  components: unknown[];
  organizationId: string;
  supabaseUrl: string;
  acao: "criar" | "editar";
  handlesExistentes?: string[];
}): boolean {
  const existentes = new Set(input.handlesExistentes ?? []);
  const base = new URL(input.supabaseUrl);
  const prefixo = `/storage/v1/object/sign/whatsapp-media/${input.organizationId}/templates/`;

  return handlesDeMidia(input.components).every((handle) => {
    let url: URL;
    try {
      url = new URL(handle);
    } catch {
      return input.acao === "editar" && existentes.has(handle);
    }
    const nomeValido = /^[0-9a-f-]{36}\.(?:jpe?g|png)$/i.test(url.pathname.slice(prefixo.length));
    return (
      url.origin === base.origin &&
      url.protocol === base.protocol &&
      !url.username &&
      !url.password &&
      url.pathname.startsWith(prefixo) &&
      nomeValido &&
      !!url.searchParams.get("token")
    );
  });
}

export function handlesExistentesDeTemplate(components: unknown): string[] {
  if (!Array.isArray(components)) return [];
  return handlesDeMidia(components);
}
