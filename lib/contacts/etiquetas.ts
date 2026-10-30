import { normalizarTag } from "@/lib/contacts/tag-normalizada";

/** Chave de leitura: iguala caixa e acentos sem mudar o valor persistido. */
export function chaveDeComparacaoDeEtiqueta(tag: string): string {
  return normalizarTag(tag)
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "");
}

/** Mantém a primeira grafia canônica, na ordem de uso recebida do servidor. */
export function etiquetasConhecidas(vocabulario: readonly string[] | null | undefined): string[] {
  const vistas = new Set<string>();
  const conhecidas: string[] = [];
  for (const valor of vocabulario ?? []) {
    const etiqueta = normalizarTag(valor);
    const chave = chaveDeComparacaoDeEtiqueta(etiqueta);
    if (!chave || vistas.has(chave)) continue;
    vistas.add(chave);
    conhecidas.push(etiqueta);
  }
  return conhecidas;
}

/** Sugestões parciais preservam ordem, filtrando o vocabulário completo. */
export function sugestoesDeEtiqueta(args: {
  conhecidas: readonly string[];
  selecionadas: readonly string[];
  digitado: string;
  limite?: number;
}): string[] {
  const selecionadas = new Set(args.selecionadas.map(chaveDeComparacaoDeEtiqueta));
  const busca = chaveDeComparacaoDeEtiqueta(args.digitado);
  return args.conhecidas
    .filter((etiqueta) => {
      const chave = chaveDeComparacaoDeEtiqueta(etiqueta);
      return chave !== "" && !selecionadas.has(chave) && (!busca || chave.includes(busca));
    })
    .slice(0, args.limite ?? 8);
}

/** Resolve um texto para a grafia existente quando houver equivalência. */
export function etiquetaExistentePara(
  conhecidas: readonly string[],
  digitado: string,
): string | null {
  const chave = chaveDeComparacaoDeEtiqueta(digitado);
  if (!chave) return null;
  return conhecidas.find((etiqueta) => chaveDeComparacaoDeEtiqueta(etiqueta) === chave) ?? null;
}

/** Nome normalizado da opção final de criação, ou null quando não há criação. */
export function opcaoDeCriar(args: {
  conhecidas: readonly string[];
  selecionadas: readonly string[];
  digitado: string;
}): string | null {
  const chave = chaveDeComparacaoDeEtiqueta(args.digitado);
  if (!chave) return null;
  if (etiquetaExistentePara(args.conhecidas, args.digitado) !== null) return null;
  if (args.selecionadas.some((etiqueta) => chaveDeComparacaoDeEtiqueta(etiqueta) === chave))
    return null;
  return normalizarTag(args.digitado);
}

/** Valor para persistir: existente canônica vence; duplicata/vazio não grava. */
export function etiquetaParaGravar(args: {
  conhecidas: readonly string[];
  selecionadas: readonly string[];
  digitado: string;
}): string | null {
  const chave = chaveDeComparacaoDeEtiqueta(args.digitado);
  if (
    !chave ||
    args.selecionadas.some((etiqueta) => chaveDeComparacaoDeEtiqueta(etiqueta) === chave)
  )
    return null;
  return etiquetaExistentePara(args.conhecidas, args.digitado) ?? normalizarTag(args.digitado);
}
