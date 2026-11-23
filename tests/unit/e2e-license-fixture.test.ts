import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { prepareE2eLicense } from "@/scripts/prepare-e2e-license";
import { verifyLicense } from "@/lib/licensing/verify";
import { E2E_TEST_LICENSE_KEY_ID } from "@/lib/licensing/e2e-test-trusted-key";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

describe("licença descartável do build E2E", () => {
  it("assina uma licença com todos os recursos de teste e mantém os arquivos no diretório temporário", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "clientix-e2e-license-"));
    tempDirs.push(root);
    const runtimeRoot = path.join(root, ".clientix-local", "e2e");
    const licensePath = path.join(runtimeRoot, "licensing", "license.json");
    const installationIdPath = path.join(runtimeRoot, "licensing", "installation_id");
    const keyModulePath = path.join(root, "e2e-test-trusted-key.ts");
    const installationId = "inst_00000000-0000-4000-8000-000000000001";

    const prepared = await prepareE2eLicense({
      installationId,
      licensePath,
      installationIdPath,
      keyModulePath,
      runtimeRoot,
      now: new Date("2026-11-23T12:00:00.000Z"),
    });
    const verify = verifyLicense(prepared.document, {
      expectedInstallationId: installationId,
      trustedKeys: { [E2E_TEST_LICENSE_KEY_ID]: prepared.publicKeyPem },
      now: new Date("2026-11-23T12:00:01.000Z"),
    });
    const [licenseFile, idFile, keyModule] = await Promise.all([
      fs.readFile(licensePath, "utf8"),
      fs.readFile(installationIdPath, "utf8"),
      fs.readFile(keyModulePath, "utf8"),
    ]);

    expect(verify).toMatchObject({ valid: true, usable: true, cryptographic_valid: true });
    expect(JSON.parse(licenseFile)).toMatchObject({ key_id: E2E_TEST_LICENSE_KEY_ID });
    expect(idFile.trim()).toBe(installationId);
    expect(keyModule).toContain(JSON.stringify(prepared.publicKeyPem));
    expect(keyModule).not.toContain("PRIVATE KEY");
    expect(prepared.document.payload.entitlements).toMatchObject({
      max_installations: 1,
      max_tenants: null,
      resale_allowed: true,
      white_label: true,
    });
  });

  it("recusa gravar licença fora da área descartável", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "clientix-e2e-license-outside-"));
    tempDirs.push(root);

    await expect(
      prepareE2eLicense({
        installationId: "inst_00000000-0000-4000-8000-000000000001",
        licensePath: path.join(root, "license.json"),
        installationIdPath: path.join(root, "installation_id"),
        keyModulePath: path.join(root, "key.ts"),
        runtimeRoot: path.join(root, ".clientix-local", "e2e"),
      }),
    ).rejects.toThrow("área descartável");
  });
});
