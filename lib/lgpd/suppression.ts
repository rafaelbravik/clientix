/**
 * Erros estáveis emitidos pela cerca SQL de tombstones da identidade LGPD.
 * A decisão final fica no banco; este helper só permite que ingressos
 * reconheçam a recusa sem transformar um titular suprimido em falha/retry.
 */
export function isDeletedSubjectSuppressionError(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const row = error as { code?: unknown; message?: unknown; details?: unknown };
  const marker = [row.message, row.details].some(
    (value) => typeof value === "string" && value.includes("lgpd_subject_suppressed"),
  );
  return marker && row.code === "42501";
}

export function isSuppressionUnavailableError(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const row = error as { message?: unknown; details?: unknown };
  return [row.message, row.details].some(
    (value) => typeof value === "string" && value.includes("lgpd_suppression_unavailable"),
  );
}
