import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { E2E_TEST_LICENSE_KEY_ID } from "@/lib/licensing/e2e-test-trusted-key";
import { isValidInstallationId } from "@/lib/licensing/installation-id";
import { signLicensePayload } from "./licensing/sign-license";

interface PrepareE2eLicenseOptions {
  installationId: string;
  licensePath: string;
  installationIdPath: string;
  keyModulePath: string;
  runtimeRoot: string;
  now?: Date;
}

interface PreparedE2eLicense {
  document: ReturnType<typeof signLicensePayload>;
  publicKeyPem: string;
}

function isInside(parent: string, child: string): boolean {
  const relative = path.relative(path.resolve(parent), path.resolve(child));
  return relative !== "" && !relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative);
}

export async function prepareE2eLicense(
  options: PrepareE2eLicenseOptions,
): Promise<PreparedE2eLicense> {
  if (!isValidInstallationId(options.installationId)) {
    throw new Error("INSTALLATION_ID ausente ou inválido para a licença E2E.");
  }

  if (
    !isInside(options.runtimeRoot, options.licensePath) ||
    !isInside(options.runtimeRoot, options.installationIdPath) ||
    path.resolve(options.licensePath) === path.resolve(options.installationIdPath)
  ) {
    throw new Error("Os arquivos da licença E2E precisam ficar na área descartável .clientix-local/e2e.");
  }

  const now = options.now ?? new Date();
  const issuedAt = now.toISOString();
  const validFrom = new Date(now.getTime() - 60_000).toISOString();
  const expiresAt = new Date(now.getTime() + 365 * 24 * 60 * 60 * 1000).toISOString();
  const { privateKey, publicKey } = crypto.generateKeyPairSync("ed25519");
  const publicKeyPem = publicKey.export({ type: "spki", format: "pem" }).toString();

  const document = signLicensePayload(
    {
      license_version: 1,
      license_id: `clientix-e2e-${crypto.randomUUID()}`,
      customer: { id: "e2e-suite", name: "Clientix E2E" },
      license_type: "partner",
      plan: "enterprise",
      product: "clientix",
      deployment: "self-hosted",
      status: "ACTIVE",
      installation_id: options.installationId,
      entitlements: {
        max_installations: 1,
        max_tenants: null,
        resale_allowed: true,
        white_label: true,
        features: ["messages", "voice", "ai_agent", "white_label", "multi_tenant"],
      },
      grace_period_days: 7,
      issued_at: issuedAt,
      valid_from: validFrom,
      expires_at: expiresAt,
    },
    { privateKey, keyId: E2E_TEST_LICENSE_KEY_ID },
  );

  await fs.mkdir(path.dirname(options.licensePath), { recursive: true, mode: 0o700 });
  await fs.mkdir(path.dirname(options.installationIdPath), { recursive: true, mode: 0o700 });
  await fs.writeFile(options.licensePath, `${JSON.stringify(document, null, 2)}\n`, { mode: 0o600 });
  await fs.chmod(options.licensePath, 0o600);
  await fs.writeFile(options.installationIdPath, `${options.installationId}\n`, { mode: 0o600 });
  await fs.chmod(options.installationIdPath, 0o600);
  await fs.writeFile(
    options.keyModulePath,
    `/** Generated for this E2E build only; the checked-in version is null. */\n` +
      `export const E2E_TEST_LICENSE_KEY_ID = ${JSON.stringify(E2E_TEST_LICENSE_KEY_ID)};\n` +
      `export const E2E_TEST_LICENSE_PUBLIC_KEY: string | null = ${JSON.stringify(publicKeyPem)};\n`,
    { mode: 0o600 },
  );
  await fs.chmod(options.keyModulePath, 0o600);

  return { document, publicKeyPem };
}

async function run(): Promise<void> {
  const installationId = process.env.INSTALLATION_ID?.trim() ?? "";
  const runtimeRoot = path.resolve(process.cwd(), ".clientix-local/e2e");
  const licensePath = process.env.CLIENTIX_LICENSE_PATH?.trim() ?? "";
  const installationIdPath = process.env.CLIENTIX_INSTALLATION_ID_PATH?.trim() ?? "";
  if (!licensePath || !installationIdPath) {
    throw new Error("CLIENTIX_LICENSE_PATH e CLIENTIX_INSTALLATION_ID_PATH devem apontar para a área E2E.");
  }

  await prepareE2eLicense({
    installationId,
    licensePath,
    installationIdPath,
    keyModulePath: path.resolve(process.cwd(), "lib/licensing/e2e-test-trusted-key.ts"),
    runtimeRoot,
  });
  console.info("Licença assinada de teste preparada na área descartável do E2E.");
}

if (require.main === module) {
  run().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : "Falha ao preparar licença E2E.");
    process.exit(1);
  });
}
