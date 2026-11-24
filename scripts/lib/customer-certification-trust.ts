import { createPublicKey } from "node:crypto";

export interface CustomerBuildArguments {
  mode: "production" | "certification";
  keyId?: string;
  publicKeyBase64?: string;
  outputPath?: string;
}

const CERTIFICATION_KEY_ID_PATTERN = /^clientix-certification-test-[a-z0-9-]{8,80}$/;

export function parseCustomerBuildArguments(arguments_: string[]): CustomerBuildArguments {
  const args = arguments_.filter((argument) => argument !== "--");
  const certification = args.includes("--certification");
  const values = new Map<string, string>();
  const positional: string[] = [];

  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (!argument) continue;
    if (argument.startsWith("--")) {
      if (argument === "--certification") continue;
      const value = args[index + 1];
      if (!value || value.startsWith("--")) {
        throw new Error("Build customer recebeu parâmetros obrigatórios incompletos.");
      }
      if (!new Set(["--key-id", "--public-key-base64"]).has(argument) || values.has(argument)) {
        throw new Error("Build customer recebeu uma opção não suportada.");
      }
      values.set(argument, value);
      index += 1;
      continue;
    }
    positional.push(argument);
  }

  const keyId = values.get("--key-id");
  const publicKeyBase64 = values.get("--public-key-base64");
  if (positional.length > 1) throw new Error("Use no máximo um argumento: o diretório vazio de saída.");
  if (!certification && (keyId || publicKeyBase64)) {
    throw new Error("Parâmetros de trust root só podem ser usados com modo de certificação explícito.");
  }
  if (certification && (!keyId || !publicKeyBase64)) {
    throw new Error("Build de certificação exige parâmetros obrigatórios: key ID e chave pública.");
  }

  return {
    mode: certification ? "certification" : "production",
    ...(keyId ? { keyId } : {}),
    ...(publicKeyBase64 ? { publicKeyBase64 } : {}),
    ...(positional[0] ? { outputPath: positional[0] } : {}),
  };
}

export function createCustomerCertificationTrustModule(keyId: string, publicKeyBase64: string): string {
  if (!CERTIFICATION_KEY_ID_PATTERN.test(keyId)) {
    throw new Error("O key ID deve usar o namespace de certificação Clientix.");
  }

  const publicKeyPem = decodeEd25519PublicKey(publicKeyBase64);
  return [
    "export const DEFAULT_TRUSTED_KEYS: Record<string, string> = {",
    `  ${JSON.stringify(keyId)}: ${JSON.stringify(publicKeyPem)},`,
    "};",
    "",
    "export function trustedKeysForBuild(): Record<string, string> {",
    "  return DEFAULT_TRUSTED_KEYS;",
    "}",
    "",
  ].join("\n");
}

function decodeEd25519PublicKey(publicKeyBase64: string): string {
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(publicKeyBase64) || publicKeyBase64.length % 4 === 1) {
    throw new Error("A chave pública Ed25519 inválida foi recusada.");
  }

  let decoded: string;
  try {
    decoded = Buffer.from(publicKeyBase64, "base64").toString("utf8");
    if (Buffer.from(decoded, "utf8").toString("base64").replace(/=+$/, "") !== publicKeyBase64.replace(/=+$/, "")) {
      throw new Error("encoding mismatch");
    }
    if (decoded.includes("PRIVATE KEY")) throw new Error("private material");
    const key = createPublicKey(decoded);
    if (key.asymmetricKeyType !== "ed25519") throw new Error("wrong key type");
    return key.export({ format: "pem", type: "spki" }).toString();
  } catch {
    throw new Error("A chave pública Ed25519 inválida foi recusada; somente uma chave pública Ed25519 é aceita.");
  }
}
