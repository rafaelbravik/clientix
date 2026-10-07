import crypto from "crypto";
import fs from "fs/promises";
import path from "path";
import { canonicalizeToBuffer } from "@/lib/licensing/canonicalize";
import { bufferToBase64url } from "@/lib/licensing/crypto";
import { parseLicensePayload } from "@/lib/licensing/schema";
import type { SignedLicenseDocument, LicensePayload } from "@/lib/licensing/types";

/**
 * Standard ASN.1 PKCS#8 prefix for Ed25519 private keys (16 bytes).
 * 30 2e 02 01 00 30 05 06 03 2b 65 70 04 22 04 20
 */
const ED25519_PKCS8_PREFIX = Buffer.from("302e020100300506032b657004220420", "hex");

export function parseEd25519PrivateKey(rawOrPem: string): crypto.KeyObject {
  const trimmed = rawOrPem.trim();

  if (trimmed.includes("-----BEGIN PRIVATE KEY-----")) {
    return crypto.createPrivateKey(trimmed);
  }

  // 32-byte hex
  if (/^[0-9a-fA-F]{64}$/.test(trimmed)) {
    const rawBytes = Buffer.from(trimmed, "hex");
    const der = Buffer.concat([ED25519_PKCS8_PREFIX, rawBytes]);
    return crypto.createPrivateKey({
      key: der,
      format: "der",
      type: "pkcs8",
    });
  }

  // 32-byte base64 / base64url
  let base64 = trimmed.replace(/-/g, "+").replace(/_/g, "/");
  while (base64.length % 4 !== 0) base64 += "=";
  const decoded = Buffer.from(base64, "base64");

  if (decoded.length === 32) {
    const der = Buffer.concat([ED25519_PKCS8_PREFIX, decoded]);
    return crypto.createPrivateKey({
      key: der,
      format: "der",
      type: "pkcs8",
    });
  }

  if (decoded.length === 48 && decoded.subarray(0, 16).equals(ED25519_PKCS8_PREFIX)) {
    return crypto.createPrivateKey({
      key: decoded,
      format: "der",
      type: "pkcs8",
    });
  }

  throw new Error("Formato de chave privada Ed25519 inválido (esperado PEM, hex 32B ou base64url 32B)");
}

export interface SignLicenseOptions {
  privateKey: string | crypto.KeyObject;
  keyId: string;
}

/**
 * Signs a license payload using an Ed25519 private key.
 * Used exclusively by developer tools and issuance systems.
 */
export function signLicensePayload(
  payloadInput: unknown,
  options: SignLicenseOptions
): SignedLicenseDocument {
  const validatedPayload: LicensePayload = parseLicensePayload(payloadInput);
  const canonicalBytes = canonicalizeToBuffer(validatedPayload);

  const keyObj =
    typeof options.privateKey === "string"
      ? parseEd25519PrivateKey(options.privateKey)
      : options.privateKey;

  const rawSig = crypto.sign(null, canonicalBytes, keyObj);
  const signatureBase64url = bufferToBase64url(rawSig);

  return {
    payload: validatedPayload,
    signature: signatureBase64url,
    algorithm: "Ed25519",
    key_id: options.keyId,
  };
}

/**
 * CLI execution entry point for developer signing tool.
 */
async function runCli(): Promise<void> {
  const args = process.argv.slice(2);
  let inputPath = "";
  let outputPath = "";
  let keyId = process.env.CLIENTIX_SIGNING_KEY_ID || "dev-key-1";
  let privateKey = process.env.CLIENTIX_SIGNING_PRIVATE_KEY || "";
  let keyFile = "";

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--input" && args[i + 1]) {
      inputPath = args[++i]!;
    } else if (arg === "--output" && args[i + 1]) {
      outputPath = args[++i]!;
    } else if (arg === "--key-id" && args[i + 1]) {
      keyId = args[++i]!;
    } else if (arg === "--key-file" && args[i + 1]) {
      keyFile = args[++i]!;
    }
  }

  if (!inputPath) {
    // If run without arguments in non-CLI context or just imported, return
    if (require.main !== module) return;
    console.error("Uso: tsx scripts/licensing/sign-license.ts --input <payload.json> [--output <license.json>] [--key-id <id>] [--key-file <key.pem>]");
    process.exit(1);
  }

  if (keyFile) {
    privateKey = await fs.readFile(path.resolve(process.cwd(), keyFile), "utf-8");
  }

  if (!privateKey) {
    console.error("Erro: Nenhuma chave privada fornecida via CLIENTIX_SIGNING_PRIVATE_KEY ou --key-file.");
    process.exit(1);
  }

  const payloadRaw = await fs.readFile(path.resolve(process.cwd(), inputPath), "utf-8");
  const payloadJson = JSON.parse(payloadRaw);

  const signedDoc = signLicensePayload(payloadJson, {
    privateKey,
    keyId,
  });

  const outputJson = JSON.stringify(signedDoc, null, 2);

  if (outputPath) {
    await fs.writeFile(path.resolve(process.cwd(), outputPath), outputJson, "utf-8");
    console.info(`Licença assinada com sucesso salva em: ${outputPath}`);
  } else {
    console.info(outputJson);
  }
}

if (require.main === module) {
  runCli().catch((err) => {
    console.error("Erro ao assinar licença:", err.message);
    process.exit(1);
  });
}
