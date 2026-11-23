import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const baseline = readFileSync("supabase/baseline.sql", "utf8");
const manifest = JSON.parse(readFileSync("supabase/manifest.json", "utf8")) as {
  schema_target: string;
  baseline: { checksum: string; size_bytes: number; incorporated_through_sequence: number };
  migrations: Array<{
    file: string;
    version: string;
    sequence: number;
    slug: string;
    checksum: string;
    transactional: boolean;
    size_bytes: number;
  }>;
};
const sha256 = (content: Buffer | string) => createHash("sha256").update(content).digest("hex");

function functionStatement(sql: string): string {
  const start = sql.indexOf("create or replace function public.fn_definir_marca_da_organizacao(");
  expect(start).toBeGreaterThanOrEqual(0);
  const delimiter = sql.indexOf("as $$", start);
  expect(delimiter).toBeGreaterThan(start);
  const end = sql.indexOf("$$;", delimiter) + 3;
  expect(end).toBeGreaterThan(delimiter + 2);
  return sql.slice(start, end).replace(/\r\n/g, "\n").trim();
}

describe.each([
  {
    sequence: 9066,
    file: "20261118090000_9066_tenant_appearance_palettes.sql",
    version: "20261118090000",
    slug: "tenant_appearance_palettes",
    next: "-- ---- paletas visuais por organização (migration 9067) ----",
  },
  {
    sequence: 9067,
    file: "20261118100000_9067_tenant_green_palette.sql",
    version: "20261118100000",
    slug: "tenant_green_palette",
    next: "-- ---- VARREDURA anon:",
  },
])("migration $sequence — paleta visual da organização", ({ sequence, file, version, slug, next }) => {
  it("espelha a função SQL no baseline antes da próxima migração/varredura ACL", () => {
    const marker = `-- ---- paletas visuais por organização (migration ${sequence}) ----`;
    const start = baseline.lastIndexOf(marker);
    const end = baseline.indexOf(next, start);
    const source = readFileSync(`supabase/migrations/${file}`, "utf8");

    expect(start).toBeGreaterThanOrEqual(0);
    expect(end).toBeGreaterThan(start);
    expect(functionStatement(baseline.slice(start, end))).toBe(functionStatement(source));
  });

  it("registra checksums e alvo 9067 no manifest de instalação", () => {
    const baselineBytes = readFileSync("supabase/baseline.sql");
    const migration = readFileSync(`supabase/migrations/${file}`);
    const entry = manifest.migrations.find((item) => item.sequence === sequence);

    expect(manifest.schema_target).toBe("9067");
    expect(manifest.baseline.incorporated_through_sequence).toBe(9067);
    expect(manifest.baseline.checksum).toBe(sha256(baselineBytes));
    expect(manifest.baseline.size_bytes).toBe(baselineBytes.byteLength);
    expect(entry).toMatchObject({
      file,
      version,
      sequence,
      slug,
      checksum: sha256(migration),
      transactional: true,
      size_bytes: migration.byteLength,
    });
  });
});
