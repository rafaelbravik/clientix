/** Repositório usado nos links de comparação gerados pelo corte de release. */
const REPOSITORIO_DO_PRODUTO = "rafaelbravik/clientix";
const PARTE_DO_NOME = /^[A-Za-z0-9_.-]+$/;

/**
 * Usa o contexto oficial do Actions quando disponível.
 * Em execução local, os cortes apontam para o repositório principal do Clientix.
 */
export function resolverRepositorioDaRelease(valor?: string): string {
  if (!valor) return REPOSITORIO_DO_PRODUTO;

  const partes = valor.trim().split("/");
  if (partes.length !== 2 || !partes[0] || !partes[1]) return REPOSITORIO_DO_PRODUTO;

  const [proprietario, repositorio] = partes;
  if (!PARTE_DO_NOME.test(proprietario) || !PARTE_DO_NOME.test(repositorio)) {
    return REPOSITORIO_DO_PRODUTO;
  }

  return `${proprietario}/${repositorio}`;
}

export function urlDeComparacaoDaRelease(
  servidor: string,
  repositorio: string,
  de: string,
  para: string,
): string {
  const base = new URL(servidor);
  if (base.protocol !== "https:" || base.username || base.password || base.search || base.hash) {
    throw new Error("Origem inválida para link de comparação da release.");
  }

  const caminho = base.pathname.replace(/\/+$/, "");
  return `${base.origin}${caminho}/${repositorio}/compare/${de}...${para}`;
}
