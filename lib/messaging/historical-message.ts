/** Classification that survives database persistence and all worker restarts. */
export const HISTORICAL_MESSAGE_MARKER = "historico_importado" as const;

export function isHistoricalImportedMessage(value: unknown): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const row = value as Record<string, unknown>;
  const metadata = row.metadata;
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) return false;
  const meta = metadata as Record<string, unknown>;
  return meta[HISTORICAL_MESSAGE_MARKER] === true
    || meta[HISTORICAL_MESSAGE_MARKER] === "true"
    || typeof meta.importacao_id === "string";
}
