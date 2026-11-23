import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = process.cwd();
const MIGRATION_FILE = "20261117002000_9065_tenant_plan_subscriptions.sql";
const BLOCK_HEADER = "-- ---- 9065 — tenant plan subscriptions (migration 9065) ----";
const NEXT_MIGRATION = "-- ---- paletas visuais por organização (migration 9066) ----";
const sha256 = (content: Buffer | string) => createHash("sha256").update(content).digest("hex");

describe("migration 9065 — assinatura comercial por tenant", () => {
  it("espelha a migration no baseline antes da varredura final de ACL", () => {
    const baseline = readFileSync(resolve(ROOT, "supabase/baseline.sql"));
    const migration = readFileSync(resolve(ROOT, "supabase/migrations", MIGRATION_FILE), "utf8");
    const baselineText = baseline.toString("utf8");
    const start = baselineText.lastIndexOf(BLOCK_HEADER);
    const end = baselineText.indexOf(NEXT_MIGRATION, start);

    expect(start).toBeGreaterThanOrEqual(0);
    expect(end).toBeGreaterThan(start);
    expect(baselineText.slice(start, end).replace(/\r\n/g, "\n").trim()).toBe(
      `${BLOCK_HEADER}\n${migration.replace(/\r\n/g, "\n").trim()}`,
    );
  });

  it("registra sequência, hashes e tamanho corretos no manifest", () => {
    const baseline = readFileSync(resolve(ROOT, "supabase/baseline.sql"));
    const migration = readFileSync(resolve(ROOT, "supabase/migrations", MIGRATION_FILE));
    const manifest = JSON.parse(readFileSync(resolve(ROOT, "supabase/manifest.json"), "utf8")) as {
      schema_target: string;
      baseline: { checksum: string; size_bytes: number; incorporated_through_sequence: number };
      migrations: Array<{ file: string; version: string; sequence: number; slug: string; checksum: string; transactional: boolean; size_bytes: number }>;
    };
    const entry = manifest.migrations.find((item) => item.sequence === 9065);

    expect(manifest.schema_target).toBe("9067");
    expect(manifest.baseline.incorporated_through_sequence).toBe(9067);
    expect(manifest.baseline.checksum).toBe(sha256(baseline));
    expect(manifest.baseline.size_bytes).toBe(baseline.byteLength);
    expect(entry).toMatchObject({
      file: MIGRATION_FILE,
      version: "20261117002000",
      sequence: 9065,
      slug: "tenant_plan_subscriptions",
      checksum: sha256(migration),
      transactional: true,
      size_bytes: migration.byteLength,
    });
  });
});
