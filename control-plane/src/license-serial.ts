import crypto from "node:crypto";

const ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

/** Friendly identifier only; authorization always uses the internal license id. */
export function generateLicenseSerial(
  now = new Date(),
  randomBytes = crypto.randomBytes(8),
): string {
  let bitBuffer = 0;
  let bitCount = 0;
  let encoded = "";
  for (const byte of randomBytes) {
    bitBuffer = (bitBuffer << 8) | byte;
    bitCount += 8;
    while (bitCount >= 5 && encoded.length < 8) {
      bitCount -= 5;
      encoded += ALPHABET.charAt((bitBuffer >>> bitCount) & 31);
    }
  }
  if (encoded.length !== 8) throw new Error("Unable to generate license serial.");
  return `CLX-${now.getUTCFullYear()}-${encoded.slice(0, 4)}-${encoded.slice(4)}`;
}
