import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";
import { createHostgatorTemplateFixture } from "@/tests/fixtures/env-hostgator-template";

const RAIZ = process.cwd();
const template = createHostgatorTemplateFixture({
  app: "test/app:stable",
  worker: "test/worker:stable",
  scheduler: "test/scheduler:stable",
});
const install = readFileSync(join(RAIZ, "hostgator-setup-kit/install.sh"), "utf8");

function linhasAtivasDaChave(texto: string, chave: string): string[] {
  return texto
    .split("\n")
    .map((linha) => linha.trim())
    .filter((linha) => linha.startsWith(`${chave}=`));
}

describe("consentimento de telemetria no primeiro install", () => {
  it("a fixture sintética não decide SENTRY_DSN pela pessoa", () => {
    expect(
      linhasAtivasDaChave(template, "SENTRY_DSN"),
      "SENTRY_DSN ativo na fixture faria load_env marcar a variável e pular a pergunta de consentimento",
    ).toEqual([]);
    expect(template).toContain("# SENTRY_DSN=");
  });

  it("o instalador distingue primeira execução de uma escolha já gravada", () => {
    expect(install).toContain('if [ -z "${SENTRY_DSN+x}" ]; then');
    expect(install).toContain('SENTRY_DSN="off"');
    expect(install).toContain('SENTRY_DSN=""');
    expect(install).toContain('envq SENTRY_DSN "${SENTRY_DSN:-}"');
  });

  it("a fixture explica as três escolhas persistentes", () => {
    expect(template).toContain("O install.sh pergunta na primeira instalação");
    expect(template).toContain("SENTRY_DSN=off");
    expect(template).toContain("SENTRY_DSN=             → aceita o Sentry da comunidade");
    expect(template).toContain("SENTRY_DSN=<seu-dsn>");
  });
});
