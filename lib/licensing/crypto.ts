import crypto from "crypto";

/**
 * Standard ASN.1 SubjectPublicKeyInfo (SPKI) header for Ed25519 public keys (12 bytes).
 * OID 1.3.101.112 (id-Ed25519): 30 2a 30 05 06 03 2b 65 70 03 21 00
 */
const ED25519_SPKI_PREFIX = Buffer.from("302a300506032b6570032100", "hex");

/**
 * Converts a Base64URL string to standard Buffer.
 */
export function base64urlToBuffer(base64url: string): Buffer {
  let base64 = base64url.replace(/-/g, "+").replace(/_/g, "/");
  while (base64.length % 4 !== 0) {
    base64 += "=";
  }
  return Buffer.from(base64, "base64");
}

/**
 * Converts a Buffer to a Base64URL string (RFC 4648 §5).
 */
export function bufferToBase64url(buffer: Buffer): string {
  return buffer
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

/**
 * Resolves various public key input representations (PEM, raw hex 32-byte, base64 32-byte, base64url 32-byte)
 * into a Node.js crypto.KeyObject ready for Ed25519 verification.
 */
export function parseEd25519PublicKey(rawOrPem: string): crypto.KeyObject {
  const trimmed = rawOrPem.trim();

  // If already in PEM format
  if (trimmed.includes("-----BEGIN PUBLIC KEY-----")) {
    return crypto.createPublicKey(trimmed);
  }

  // Check if raw 32 bytes encoded in hex (64 chars)
  if (/^[0-9a-fA-F]{64}$/.test(trimmed)) {
    const rawBytes = Buffer.from(trimmed, "hex");
    const der = Buffer.concat([ED25519_SPKI_PREFIX, rawBytes]);
    return crypto.createPublicKey({
      key: der,
      format: "der",
      type: "spki",
    });
  }

  // Check if raw 32 bytes encoded in base64 / base64url (43 or 44 chars)
  const decoded = base64urlToBuffer(trimmed);
  if (decoded.length === 32) {
    const der = Buffer.concat([ED25519_SPKI_PREFIX, decoded]);
    return crypto.createPublicKey({
      key: der,
      format: "der",
      type: "spki",
    });
  }

  // If it's already full DER in base64
  if (decoded.length === 44 && decoded.subarray(0, 12).equals(ED25519_SPKI_PREFIX)) {
    return crypto.createPublicKey({
      key: decoded,
      format: "der",
      type: "spki",
    });
  }

  throw new Error("Formato de chave pública Ed25519 inválido (esperado PEM, hex 32B ou base64url 32B)");
}

/**
 * Performs Ed25519 cryptographic verification using native Node.js crypto.
 *
 * @param data Buffer of canonicalized bytes to verify
 * @param signature Base64url signature string
 * @param publicKey Raw or PEM public key string
 * @returns boolean true if signature is mathematically valid for data
 */
export function verifyEd25519Signature(
  data: Buffer,
  signatureBase64url: string,
  publicKey: string | crypto.KeyObject
): boolean {
  try {
    const sigBuffer = base64urlToBuffer(signatureBase64url);
    if (sigBuffer.length !== 64) {
      return false;
    }

    const keyObj = typeof publicKey === "string" ? parseEd25519PublicKey(publicKey) : publicKey;
    return crypto.verify(null, data, keyObj, sigBuffer);
  } catch {
    return false;
  }
}
