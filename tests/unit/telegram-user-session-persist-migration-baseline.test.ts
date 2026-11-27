import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = process.cwd();
const MIGRATION_FILE = "20261126220000_9068_telegram_user_no_webhook_secret.sql";
const BLOCK_HEADER = "-- ---- 9068 — telegram user sem segredo de webhook (migration 9068) ----";
const sha256 = (content: Buffer | string) => createHash("sha256").update(content).digest("hex");

describe("migration 9068 — sessão Telegram User sem webhook", () => {
  it("mantém a constraint uma única vez no baseline e amplia o vocabulário para MTProto", () => {
    const baseline = readFileSync(resolve(ROOT, "supabase/baseline.sql"), "utf8");
    const migration = readFileSync(resolve(ROOT, "supabase/migrations", MIGRATION_FILE), "utf8");
    const start = baseline.lastIndexOf(BLOCK_HEADER);
    const additions = [
      ...baseline.matchAll(/add\s+constraint\s+channel_sessions_webhook_secret_provider_check\s+check\s*\(([\s\S]*?)\);/gi),
    ];
    const baselineCheck = additions[0]?.[1]?.replace(/\s+/g, " ").trim();
    const migrationCheck = migration
      .match(/add\s+constraint\s+channel_sessions_webhook_secret_provider_check\s+check\s*\(([\s\S]*?)\);/i)?.[1]
      ?.replace(/\s+/g, " ")
      .trim();

    expect(start).toBeGreaterThanOrEqual(0);
    expect(additions).toHaveLength(1);
    expect(baselineCheck).toBe("provider in ('webchat', 'telegram_user') or webhook_secret_encrypted is not null");
    expect(migrationCheck).toBe(baselineCheck);
    expect(baseline.slice(start)).not.toMatch(/drop\s+constraint|add\s+constraint/i);
    expect(baseline.slice(start)).toMatch(/comment\s+on\s+constraint\s+channel_sessions_webhook_secret_provider_check/i);
  });

  it("registra sequência, checksums e tamanho do baseline no manifest", () => {
    const baseline = readFileSync(resolve(ROOT, "supabase/baseline.sql"));
    const migration = readFileSync(resolve(ROOT, "supabase/migrations", MIGRATION_FILE));
    const manifest = JSON.parse(readFileSync(resolve(ROOT, "supabase/manifest.json"), "utf8")) as {
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
    const entry = manifest.migrations.find((item) => item.sequence === 9068);

    expect(manifest.schema_target).toBe("9068");
    expect(manifest.baseline.incorporated_through_sequence).toBe(9068);
    expect(manifest.baseline.checksum).toBe(sha256(baseline));
    expect(manifest.baseline.size_bytes).toBe(baseline.byteLength);
    expect(entry).toMatchObject({
      file: MIGRATION_FILE,
      version: "20261126220000",
      sequence: 9068,
      slug: "telegram_user_no_webhook_secret",
      checksum: sha256(migration),
      transactional: true,
      size_bytes: migration.byteLength,
    });
  });
});
