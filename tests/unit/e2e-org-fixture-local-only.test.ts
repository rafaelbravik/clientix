import * as fs from "node:fs";
import * as path from "node:path";

import { describe, expect, it } from "vitest";

import { exigirSupabaseLocalParaFixture } from "@/scripts/lib/organizations-e2e";

describe("fixtures E2E de organizações só usam instalações locais", () => {
  it.each([
    {
      url: "http://127.0.0.1:54321",
      dbUrl: "postgresql://postgres:senha@127.0.0.1:54322/postgres",
    },
    {
      url: "http://localhost:54321",
      dbUrl: "postgresql://postgres:senha@[::1]:54322/postgres",
    },
  ])("aceita API e Postgres locais", (alvos) => {
    expect(() => exigirSupabaseLocalParaFixture(alvos, "teste")).not.toThrow();
  });

  it.each([
    { url: "https://supabase.example.test", dbUrl: "postgresql://u:p@127.0.0.1:54322/postgres" },
    { url: "http://127.0.0.1:54321", dbUrl: "postgresql://u:p@db.example.test:5432/postgres" },
    { url: "http://127.0.0.1:54321", dbUrl: "" },
  ])("recusa destino remoto ou ausente sem revelar credenciais", (alvos) => {
    expect(() => exigirSupabaseLocalParaFixture(alvos, "teste")).toThrow(
      "fixture administrativa exige Supabase HTTP e PostgreSQL locais",
    );
    try {
      exigirSupabaseLocalParaFixture(alvos, "teste");
    } catch (erro) {
      expect(String(erro)).not.toContain("senha");
      expect(String(erro)).not.toContain(":p@");
    }
  });

  it("mantém as criações E2E no helper DB local, fora do service_role", () => {
    const raiz = path.resolve(__dirname, "../..");
    const scripts = [
      "scripts/create-test-user.ts",
      "scripts/reset-user-onboarding.ts",
      "scripts/seed-e2e-credentials.ts",
      "scripts/seed-e2e-duas-organizacoes.ts",
      "scripts/seed-e2e-funis.ts",
      "scripts/seed-e2e-tenant-b.ts",
      "scripts/seed-e2e-zona-de-perigo.ts",
    ];

    for (const relativo of scripts) {
      const fonte = fs.readFileSync(path.join(raiz, relativo), "utf8");
      expect(fonte, `${relativo} precisa recusar destinos não locais`).toContain(
        "exigirSupabaseLocalParaFixture",
      );
      expect(fonte, `${relativo} precisa usar a conexão fixture local`).toContain(
        "criarOrganizacaoFixtureE2E",
      );
      expect(fonte, `${relativo} não pode inserir por service_role`).not.toMatch(
        /\.from\(["']organizations["']\)\s*\.insert\(/s,
      );
    }
  });

  it("restringe a fixture SQL do smoke de LLM ao Postgres local", () => {
    const smoke = fs.readFileSync(path.resolve(__dirname, "../../scripts/smoke-llm.ts"), "utf8");
    expect(smoke).toContain("destinoEhLocal(DB_URL)");
    expect(smoke).toContain("SMOKE_DB_URL deve apontar para um Postgres local");
  });
});
