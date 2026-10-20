import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

const RAIZ = process.cwd();

describe("cercas de hardening de runtime do worker e voice-agent (L3.1)", () => {
  it("Dockerfile.worker usa multi-stage builder e executa via node dist/worker/main.js", () => {
    const conteudo = readFileSync(join(RAIZ, "Dockerfile.worker"), "utf8");
    expect(conteudo).toMatch(/FROM\s+node:22-alpine\s+AS\s+build-base/i);
    expect(conteudo).toMatch(/FROM\s+build-base\s+AS\s+builder/i);
    expect(conteudo).toMatch(/FROM\s+node:22-alpine\s+AS\s+runner/i);
    const producao = conteudo.split("FROM build-base AS certification-builder", 1)[0] ?? conteudo;
    expect(producao).not.toContain("pnpm exec tsx");
    expect(conteudo).toContain('CMD ["node", "dist/worker/main.js"]');
    expect(conteudo).not.toContain("tsx workers/agent-worker");
  });

  it("Dockerfile.voice-agent usa multi-stage builder e executa via node dist/voice-agent/index.js", () => {
    const conteudo = readFileSync(join(RAIZ, "Dockerfile.voice-agent"), "utf8");
    expect(conteudo).toMatch(/FROM\s+node:22-alpine\s+AS\s+builder/i);
    expect(conteudo).toMatch(/FROM\s+node:22-alpine\s+AS\s+runner/i);
    expect(conteudo).toContain('CMD ["node", "dist/voice-agent/index.js"]');
    expect(conteudo).not.toContain("pnpm exec tsx");
    expect(conteudo).not.toContain("tsx workers/voice-agent");
  });

  it("o script de bundling build-worker-bundle.mjs existe e é válido", () => {
    const script = readFileSync(join(RAIZ, "scripts", "build-worker-bundle.mjs"), "utf8");
    expect(script).toContain("build-worker-bundle");
    expect(script).toContain("workers/agent-worker/main.ts");
    expect(script).toContain("workers/voice-agent/index.ts");
  });
});
