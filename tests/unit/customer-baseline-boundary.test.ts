import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const temporarios: string[] = [];

function materializarBaselineCustomer() {
  const raiz = process.cwd();
  const destino = mkdtempSync(join(tmpdir(), "clientix-customer-baseline-test-"));
  temporarios.push(destino);
  const baselinePath = join(destino, "baseline.sql");
  const manifestPath = join(destino, "manifest.json");

  execFileSync(
    process.execPath,
    [
      resolve(raiz, "scripts/build-customer-baseline.mjs"),
      resolve(raiz, "supabase/baseline.sql"),
      resolve(raiz, "supabase/manifest.json"),
      baselinePath,
      manifestPath,
    ],
    { stdio: "pipe" },
  );

  return {
    baseline: readFileSync(baselinePath, "utf8"),
    manifest: JSON.parse(readFileSync(manifestPath, "utf8")) as {
      baseline: { checksum: string; size_bytes: number };
      schema_target: string;
    },
  };
}

afterEach(() => {
  while (temporarios.length > 0) {
    const destino = temporarios.pop();
    if (destino) rmSync(destino, { recursive: true, force: true });
  }
});

describe("baseline do migrador customer", () => {
  it("remove funções vendor e dependências executáveis de suporte mantendo o schema de compatibilidade", () => {
    const { baseline } = materializarBaselineCustomer();

    expect(baseline).toMatch(/create table if not exists public\.platform_support_sessions\s*\(/i);
    expect(baseline).not.toMatch(/public\.fn_support_context\s*\(/i);

    for (const nome of [
      "fn_support_context",
      "fn_start_support",
      "fn_end_support",
      "fn_support_callback_write_allowed",
    ]) {
      expect(baseline).not.toMatch(
        new RegExp(`create(?:\\s+or\\s+replace)?\\s+function\\s+public\\.${nome}\\s*\\(`, "i"),
      );
    }

    const funcoes = [
      "fn_user_org_ids",
      "fn_user_role_in_org",
      "fn_support_write_allowed",
      "fn_reply_delivery_policy",
    ];
    for (const nome of funcoes) {
      const inicio = baseline.lastIndexOf(`create or replace function public.${nome}`);
      expect(inicio, `${nome} deve permanecer no baseline customer`).toBeGreaterThanOrEqual(0);
      const fim = baseline.indexOf("$$;", inicio);
      const fimAlternativo = baseline.indexOf("$f$;", inicio);
      const terminador = [fim, fimAlternativo].filter((i) => i >= 0).sort((a, b) => a - b)[0];
      expect(terminador, `${nome} deve ter corpo SQL completo`).toBeDefined();
      const corpo = baseline.slice(inicio, terminador);
      expect(corpo).not.toMatch(/fn_support_context|platform_support_sessions/i);
    }

    const orgIdsStart = baseline.lastIndexOf("create or replace function public.fn_user_org_ids()");
    const orgIdsEnd = baseline.indexOf("$f$;", orgIdsStart);
    expect(baseline.slice(orgIdsStart, orgIdsEnd)).toContain("public.user_organizations");
    expect(baseline.slice(orgIdsStart, orgIdsEnd)).toContain("auth.uid()");
  });

  it("atualiza checksum e tamanho do manifest migrador ao baseline customer", () => {
    const { baseline, manifest } = materializarBaselineCustomer();

    expect(manifest.schema_target).toBe("0541");
    expect(manifest.baseline.checksum).toBe(
      createHash("sha256").update(baseline, "utf8").digest("hex"),
    );
    expect(manifest.baseline.size_bytes).toBe(Buffer.byteLength(baseline, "utf8"));
  });
});
