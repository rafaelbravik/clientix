import { createHash, timingSafeEqual } from "node:crypto";

/** Compare bootstrap secrets without exposing length-dependent timing. */
export function bootstrapTokenMatches(candidate: string, configured: string): boolean {
  if (configured.length < 32 || candidate.length === 0 || candidate.length > 512) return false;
  const candidateDigest = createHash("sha256").update(candidate, "utf8").digest();
  const configuredDigest = createHash("sha256").update(configured, "utf8").digest();
  return timingSafeEqual(candidateDigest, configuredDigest);
}

/** A rate-limit key is opaque and namespaced; the raw address is never stored. */
export function setupRateLimitSubjectHash(address: string | null): string {
  const source = address?.trim().slice(0, 256) || "unknown";
  return createHash("sha256").update(`clientix:platform-setup:ip:${source}`, "utf8").digest("hex");
}

/** Setup writes are accepted only from the same browser origin. */
export function isSameOrigin(origin: string | null, requestOrigin: string): boolean {
  if (!origin || origin === "null") return false;
  try {
    return new URL(origin).origin === new URL(requestOrigin).origin;
  } catch {
    return false;
  }
}
