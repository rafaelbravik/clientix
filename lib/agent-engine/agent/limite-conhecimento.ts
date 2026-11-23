/** Limite de fatos empresariais quando a versão não tem material aprovado. */
export function blocoLimiteDeConhecimento(
  config: {
    knowledgeSourceIds?: readonly string[] | null;
    activeKbVersionId?: string | null;
    handoffToolEnabled?: boolean;
  } | null,
): string | null {
  if (config === null) return null;

  const temMaterial =
    (config.knowledgeSourceIds?.length ?? 0) > 0 || config.activeKbVersionId != null;
  if (temMaterial) return null;

  return [
    "## Limite de conhecimento da organização",
    "Esta versão não tem material da empresa habilitado para consulta.",
    "Não responda horário, endereço, preço, serviço, disponibilidade, prazo, política ou outro fato da empresa usando conhecimento geral, estimativa ou padrão de mercado.",
    "Use somente informações ditas explicitamente nesta conversa ou retornadas por ferramentas habilitadas. Se nenhuma fonte confirmar a resposta, diga que não tem a informação confirmada e não chute.",
    config.handoffToolEnabled
      ? "Se a pessoa pedir ajuda humana, use o caminho de transferência disponível. Só diga que alguém foi acionado depois que a ferramenta concluir com sucesso."
      : "Não prometa retorno nem diga que acionou alguém. Oriente a pessoa a confirmar com a equipe da empresa pelos canais disponíveis.",
  ].join("\n");
}
