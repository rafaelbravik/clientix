import { execFileSync, spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

const raiz = path.resolve(__dirname, "../..");

describe("o preparo habitual do E2E usa o stack do checkout e inclui o catálogo local de extensões", () => {
  it.each(["", "56330"])("inclui o catálogo e respeita E2E_PORT=%s", (porta) => {
    // Executa o gerador real em outro diretório, sem consultar Docker, projetos
    // Supabase ou arquivos de ambiente da estação de trabalho.
    const destino = mkdtempSync(path.join(tmpdir(), "deskcomm-env-extensoes-"));
    try {
      mkdirSync(path.join(destino, "scripts"));
      const script = path.join(destino, "scripts/gerar-env-e2e.sh");
      copyFileSync(path.join(raiz, "scripts/gerar-env-e2e.sh"), script);
      writeFileSync(
        path.join(destino, "scripts/local-supabase.sh"),
        `#!/usr/bin/env bash
set -eu
[ "$*" = 'status' ] || exit 2
printf '%s\\n' '{"API_URL":"http://127.0.0.1:54321","ANON_KEY":"synthetic-anon","SERVICE_ROLE_KEY":"synthetic-service","DB_URL":"postgresql://postgres:senha-sintetica@127.0.0.1:54322/postgres","MAILPIT_URL":"http://127.0.0.1:54324"}'
`,
        { mode: 0o700 },
      );
      const chave = Buffer.alloc(32, 1).toString("base64");
      writeFileSync(
        path.join(destino, ".env.e2e"),
        ["CPF_ENCRYPTION_KEY", "WAHA_BYO_ENCRYPTION_KEY", "AI_CRED_AES_KEY"]
          .map((nome) => `${nome}=${chave}\n`)
          .join(""),
        { mode: 0o600 },
      );
      const resultado = spawnSync("bash", [script], {
        cwd: destino,
        env: { ...process.env, E2E_PORT: porta },
        encoding: "utf8",
        timeout: 10_000,
      });
      expect(resultado.status).toBe(0);
      expect(resultado.stderr).not.toMatch(/command not found/i);
      const ambiente = readFileSync(path.join(destino, ".env.e2e"), "utf8");
      expect(ambiente).toContain(`NEXT_PUBLIC_APP_URL=http://localhost:${porta || "3001"}\n`);
      expect(ambiente).toContain("CLIENTIX_INGRESS_MODE=local\n");
      expect(ambiente).toContain("CLIENTIX_ALLOW_INSECURE_HTTP=true\n");
      expect(ambiente).toContain("NEXT_PUBLIC_SUPABASE_URL=http://127.0.0.1:54321\n");
      expect(ambiente).toContain("SUPABASE_SERVER_URL=http://127.0.0.1:54321\n");
      expect(ambiente).toContain("MAILPIT_URL=http://127.0.0.1:54324\n");
      expect(ambiente).toContain("EXTENSIONS_LOCAL_CATALOG_ORIGIN=http://127.0.0.1:56331\n");
      // A spec do Jev sobe o dublê nesta porta; o servidor sob teste só o
      // alcança se o gerador a escrever.
      expect(ambiente).toContain("JEV_API_BASE_URL=http://127.0.0.1:3996\n");
      expect(ambiente).toContain(`CPF_ENCRYPTION_KEY=${chave}\n`);
      expect(ambiente).toContain("SENTRY_DSN=off\n");
    } finally {
      rmSync(destino, { recursive: true, force: true });
    }
  });

  it("recusa URL remota retornada pelo stack antes de gerar o ambiente", () => {
    const destino = mkdtempSync(path.join(tmpdir(), "deskcomm-env-e2e-remoto-"));
    try {
      mkdirSync(path.join(destino, "scripts"));
      copyFileSync(path.join(raiz, "scripts/gerar-env-e2e.sh"), path.join(destino, "scripts/gerar-env-e2e.sh"));
      writeFileSync(
        path.join(destino, "scripts/local-supabase.sh"),
        `#!/usr/bin/env bash
set -eu
[ "$*" = 'status' ] || exit 2
printf '%s\\n' '{"API_URL":"https://projeto-remoto.example.test","ANON_KEY":"synthetic-anon","SERVICE_ROLE_KEY":"synthetic-service","DB_URL":"postgresql://postgres:senha-sintetica@127.0.0.1:54322/postgres"}'
`,
        { mode: 0o700 },
      );
      const erro = (() => {
        try {
          execFileSync("bash", [path.join(destino, "scripts/gerar-env-e2e.sh")], {
            cwd: destino,
            stdio: "pipe",
            timeout: 10_000,
          });
          return null;
        } catch (causa) {
          return causa as Error;
        }
      })();
      expect(erro).not.toBeNull();
      expect(existsSync(path.join(destino, ".env.e2e"))).toBe(false);
    } finally {
      rmSync(destino, { recursive: true, force: true });
    }
  });
});
