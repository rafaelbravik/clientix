import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { materializeCustomerRuntimeDependencies } from "./materialize-customer-runtime";

const temporaryRoots: string[] = [];

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("materializeCustomerRuntimeDependencies", () => {
  it("substitui aliases staged e remove o grafo .pnpm do artefato standalone", () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "clientix-customer-runtime-"));
    temporaryRoots.push(root);

    const stagedProjectRoot = path.join(root, "staged", "project");
    const artifactRoot = path.join(root, "artifact");
    const stagedModules = path.join(stagedProjectRoot, "node_modules");
    const standaloneModules = path.join(artifactRoot, "standalone", "node_modules");
    const nextRoot = path.join(stagedModules, ".pnpm", "next@1.0.0", "node_modules", "next");
    const depRoot = path.join(stagedModules, ".pnpm", "dep-a@1.0.0", "node_modules", "dep-a");

    mkdirSync(stagedModules, { recursive: true });
    mkdirSync(standaloneModules, { recursive: true });
    mkdirSync(nextRoot, { recursive: true });
    mkdirSync(depRoot, { recursive: true });
    writeFileSync(
      path.join(stagedProjectRoot, "package.json"),
      JSON.stringify({ name: "clientix-customer", dependencies: { next: "1.0.0" } }),
    );
    writeFileSync(
      path.join(nextRoot, "package.json"),
      JSON.stringify({ name: "next", version: "1.0.0", dependencies: { "dep-a": "1.0.0" } }),
    );
    writeFileSync(
      path.join(depRoot, "package.json"),
      JSON.stringify({ name: "dep-a", version: "1.0.0" }),
    );

    const symlinkType = process.platform === "win32" ? "junction" : "dir";
    symlinkSync(nextRoot, path.join(stagedModules, "next"), symlinkType);
    symlinkSync(depRoot, path.join(stagedModules, "dep-a"), symlinkType);
    mkdirSync(path.join(standaloneModules, ".pnpm", "next@1.0.0", "node_modules"), {
      recursive: true,
    });
    symlinkSync(nextRoot, path.join(standaloneModules, "next"), symlinkType);
    symlinkSync(depRoot, path.join(standaloneModules, "dep-a"), symlinkType);

    const runtimeNames = materializeCustomerRuntimeDependencies({
      artifactRoot,
      stagedProjectRoot,
    });

    expect(runtimeNames).toEqual(expect.arrayContaining(["next", "dep-a"]));
    expect(existsSync(path.join(standaloneModules, ".pnpm"))).toBe(false);
    expect(lstatSync(path.join(standaloneModules, "next")).isSymbolicLink()).toBe(false);
    expect(lstatSync(path.join(standaloneModules, "dep-a")).isSymbolicLink()).toBe(false);
    expect(
      JSON.parse(readFileSync(path.join(standaloneModules, "dep-a", "package.json"), "utf8")),
    ).toMatchObject({ name: "dep-a", version: "1.0.0" });
  });
});
