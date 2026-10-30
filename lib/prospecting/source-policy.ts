import { ProspectingError } from "./provider";

/** Nenhuma fonte real foi aprovada para esta wave. */
export const APPROVED_REAL_PROSPECTING_SOURCES: readonly string[] = [];

export function isProspectingSourceAllowed(
  source: string,
  nodeEnv: string | undefined = process.env.NODE_ENV,
): boolean {
  if (source === "synthetic") return nodeEnv === "test";
  return APPROVED_REAL_PROSPECTING_SOURCES.includes(source);
}

export function assertProspectingSourceAllowed(source: string): void {
  if (isProspectingSourceAllowed(source)) return;
  throw new ProspectingError(
    "Esta fonte de prospecção ainda não foi aprovada para coleta nesta instalação.",
    403,
    "campanha",
    "prospecting_source_not_approved",
  );
}
