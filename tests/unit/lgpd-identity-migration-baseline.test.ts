import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = process.cwd();
const MIGRATION = "supabase/migrations/20261028180000_0541_lgpd_identity_suppression.sql";
const MARKER = "-- Impede que um titular anonimizado a pedido seja recriado por ingressos que";
const ANON_SCAN = "-- ---- VARREDURA anon:";

describe("migration 0541 — baseline e MANIFEST", () => {
  it("mantém a tripla SQL idêntica entre migration e apêndice final", () => {
    const baseline = readFileSync(resolve(ROOT, "supabase/baseline.sql"), "utf8");
    const migration = readFileSync(resolve(ROOT, MIGRATION), "utf8").trim();
    const index = baseline.lastIndexOf(MARKER);
    const scanIndex = baseline.indexOf(ANON_SCAN, index);
    expect(index, "baseline sem apêndice idempotente da 0541").toBeGreaterThanOrEqual(0);
    expect(scanIndex, "apêndice 0541 precisa preceder a varredura anon").toBeGreaterThan(index);
    expect(baseline.slice(index, scanIndex).trim()).toBe(migration);
  });

  it("declara a reserva usada no MANIFEST", () => {
    const manifest = readFileSync(resolve(ROOT, "supabase/migrations/MANIFEST.md"), "utf8");
    expect(manifest).toContain("| `20261028180000` | `0541_lgpd_identity_suppression` |");
  });
});
