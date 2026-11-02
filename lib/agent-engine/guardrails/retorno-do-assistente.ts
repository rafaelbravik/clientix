/**
 * Detector lexical conservador de promessa de retorno do próprio assistente.
 * A resposta deve ser bloqueada quando promete retomar a conversa e o turno não
 * registrou um follow-up. Mantemos apenas padrões medidos para reduzir falsos
 * positivos em mensagens comuns.
 */
function normalize(body: string): string {
  return body
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase();
}

const PATTERNS: readonly RegExp[] = [
  /\bretomar(?:ei|emos)\b/,
  /\b(?:volto|voltarei|vou voltar)\b[^.!?\n]{0,25}\b(?:fal|convers|contat|cham|procur|lig|escrev)\w*/,
  /\bte\s+(?:chamo|chamarei|procuro|procurarei|ligo|ligarei)\b/,
  /\b(?:chamo|chamarei)\b[^.!?\n]{0,12}\b(?:voce|vc|voces)\b/,
  /\ba gente se fala\b/,
];

const RETOMAR_AMBIGUO = /(?:retom(?:o|amos)|(?:vou|vamos|irei|iremos) retomar)/.source;
const OBJETO_DA_CONVERSA =
  /(?: (?:o|a|nosso|nossa|o nosso|a nossa) (?:contato|conversa|atendimento|assunto|papo)| de onde (?:paramos|parou|parei))?(?: com (?:voce|vc)| contigo)?/
    .source;
const QUANDO =
  /(?:amanha|depois|mais tarde|daqui (?:a|ha|uns|umas|\d)|em breve|logo mais|assim que|semana que vem|mes que vem|(?:na |no )?proxim[ao] (?:semana|mes|hora|dia|segunda|terca|quarta|quinta|sexta|sabado|domingo)|(?:na|no|ate|para|pra) (?:segunda|terca|quarta|quinta|sexta|sabado|domingo)|(?:segunda|terca|quarta|quinta|sexta)-feira|(?:de|pela|a|na|hoje a) (?:manha|tarde|noite)|(?:no )?(?:fim|final) do dia|outra hora|outro dia|as \d{1,2}(?:h|:\d{2}| ?horas?)\b|\d{1,2} ?h\b|\d{1,2}:\d{2}|em \d+ ?(?:min|minutos?|horas?|dias?)\b)/
    .source;
const RETOMADA_COM_QUANDO = new RegExp(
  `\\b${RETOMAR_AMBIGUO}${OBJETO_DA_CONVERSA},? ${QUANDO}` +
    `|(?:^|[.!?;:,\\n] *)${QUANDO}(?: ${QUANDO})?,? (?:a gente |nos |eu )?${RETOMAR_AMBIGUO}\\b`,
);

export function detectarPromessaDeRetornoDoAssistente(body: string): boolean {
  if (body.trim() === '') return false;
  const text = normalize(body);
  return PATTERNS.some((pattern) => pattern.test(text)) || RETOMADA_COM_QUANDO.test(text);
}
