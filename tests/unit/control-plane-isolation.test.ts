import { describe, it, expect } from "vitest";
import fs from "fs/promises";
import path from "path";

describe("L8.1B Control Plane Isolation Invariant", () => {
  const repoRoot = path.resolve(__dirname, "../..");

  it("ensures supabase/manifest.json does NOT contain control-plane files or tables", async () => {
    const manifestPath = path.join(repoRoot, "supabase", "manifest.json");
    const manifestRaw = await fs.readFile(manifestPath, "utf-8");
    const manifest = JSON.parse(manifestRaw);

    expect(manifest.migrations).toBeDefined();
    for (const m of manifest.migrations) {
      expect(m.file).not.toMatch(/control[-_]plane/i);
      expect(m.slug).not.toMatch(/licensing_(customers|installations|activation_codes|nonces)/i);
    }
  });

  it("ensures Dockerfile.migrator strictly excludes control-plane and copies only client sql/manifests", async () => {
    const dockerfilePath = path.join(repoRoot, "Dockerfile.migrator");
    const content = await fs.readFile(dockerfilePath, "utf-8");

    // Must copy supabase baseline, migrations, manifest, verify-schema
    expect(content).toContain("COPY supabase/baseline.sql ./sql/baseline.sql");
    expect(content).toContain("COPY supabase/migrations ./sql/migrations");
    expect(content).toContain("COPY supabase/manifest.json ./manifest/manifest.json");

    // Must never copy control-plane
    expect(content).not.toContain("control-plane");
  });

  it("ensures client supabase/baseline.sql does not define control plane tables", async () => {
    const baselinePath = path.join(repoRoot, "supabase", "baseline.sql");
    const baselineContent = await fs.readFile(baselinePath, "utf-8");

    expect(baselineContent).not.toContain("create table if not exists licensing_customers");
    expect(baselineContent).not.toContain("create table if not exists licensing_installations");
    expect(baselineContent).not.toContain("create table if not exists licensing_activation_codes");
    expect(baselineContent).not.toContain("create table if not exists licensing_nonces");
  });
});
