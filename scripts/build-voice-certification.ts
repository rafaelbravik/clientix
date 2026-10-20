import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

import { createCustomerCertificationTrustModule } from "./lib/customer-certification-trust";

const keyId = process.env.TEST_LICENSE_KEY_ID;
const publicKeyBase64 = process.env.TEST_LICENSE_PUBLIC_KEY_BASE64;
if (!keyId || !publicKeyBase64) {
  throw new Error("Build voice-certification exige somente key ID e chave pública TEST.");
}

const trustModule = createCustomerCertificationTrustModule(keyId, publicKeyBase64);
writeFileSync(resolve("lib/licensing/trusted-keys.ts"), trustModule, "utf8");

const build = spawnSync(process.execPath, ["scripts/build-worker-bundle.mjs", "voice-agent"], {
  stdio: "inherit",
  env: process.env,
});
if (build.error) throw build.error;
if (build.status !== 0) throw new Error("Build do bundle voice-certification falhou.");

const bundle = readFileSync(resolve("dist/voice-agent/index.js"), "utf8");
if (!bundle.includes(keyId)) {
  throw new Error("Bundle voice-certification não contém o key ID público TEST esperado.");
}
if (bundle.includes("clientix-license-2026-01")) {
  throw new Error("Bundle voice-certification contém a autoridade oficial de produção.");
}
if (/-----BEGIN [A-Z ]*PRIVATE KEY-----/.test(bundle)) {
  throw new Error("Bundle voice-certification contém material de chave privada.");
}
