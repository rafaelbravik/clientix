export const AVISO_DE_UMA_ETAPA =
  "Com 1 etapa, uma chamada de ferramenta pode encerrar o turno antes de o agente enviar uma resposta.";

export function avisoDeLimiteDeEtapas(maxSteps: number): string | null {
  return maxSteps === 1 ? AVISO_DE_UMA_ETAPA : null;
}
