import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";
import { releaseImageMetadataMismatches } from "../../scripts/lib/release-image-metadata.mjs";

const ROOT = process.cwd();
const publishWorkflow = readFileSync(join(ROOT, ".github/workflows/publish-image.yml"), "utf8");
const EXPECTED_HEAD = "a".repeat(40);
const VALID_LABELS = {
  "com.clientix.source-head": EXPECTED_HEAD,
  "com.clientix.source-dirty": "false",
  "com.clientix.release-eligible": "true",
};

interface ReleaseRecipe {
  name: string;
  dockerfile: string;
  target?: string;
  title: string;
}

function recipesDaMatriz(): ReleaseRecipe[] {
  const include =
    /matrix:\s*\n\s{8}include:\s*\n([\s\S]*?)(?=\n\s{8}name:\s*\[)/.exec(publishWorkflow)?.[1] ?? "";
  return include
    .split(/(?=^\s{10}-\s+name:\s*)/m)
    .map((block) => block.trim())
    .filter(Boolean)
    .map((block) => {
      const field = (name: string) =>
        new RegExp(`^\\s+${name}:\\s*(.+?)\\s*$`, "m").exec(block)?.[1];
      const image = /^\s*-\s+name:\s*([A-Za-z0-9._-]+)\s*$/m.exec(block)?.[1];
      const dockerfile = field("dockerfile");
      const title = field("title");
      const target = field("target");
      if (!image || !dockerfile || !title) throw new Error("receita incompleta na matriz de publicação");
      return { name: image, dockerfile, title, ...(target ? { target } : {}) };
    });
}

function dockerStages(dockerfile: string): Array<{ name: string; block: string }> {
  const declarations = [...dockerfile.matchAll(/^FROM\s+.*$/gm)];
  return declarations.map((match, index) => {
    const line = match[0] ?? "";
    const name = /\s+AS\s+([A-Za-z0-9._-]+)\s*$/i.exec(line)?.[1] ?? "";
    const start = match.index ?? 0;
    const end = declarations[index + 1]?.index ?? dockerfile.length;
    return { name, block: dockerfile.slice(start, end) };
  });
}

function stageDaReceita(recipe: ReleaseRecipe): { name: string; block: string } {
  const source = readFileSync(join(ROOT, recipe.dockerfile), "utf8");
  const stages = dockerStages(source);
  const stage = recipe.target
    ? stages.find((candidate) => candidate.name === recipe.target)
    : stages.at(-1);
  if (!stage) throw new Error(`target ausente para ${recipe.name}`);
  return stage;
}

describe("proveniência das imagens próprias obrigatórias de release", () => {
  const recipes = recipesDaMatriz();

  it("usa a matriz de publicação como fonte única e não contém nomes duplicados", () => {
    const names = recipes.map(({ name }) => name);
    expect(names.length).toBeGreaterThan(0);
    expect(new Set(names).size).toBe(names.length);
    expect(names).toContain("clientix-ingress");
    expect(names).toContain("clientix-migrator");
  });

  it.each(recipes)("$name aceita e persiste provenance no target publicado", (recipe) => {
    const stages = dockerStages(readFileSync(join(ROOT, recipe.dockerfile), "utf8"));
    const target = stageDaReceita(recipe);
    expect(stages.at(-1), `${recipe.name} deve publicar o estágio final`).toEqual(target);
    expect(target.block).toMatch(/^ARG SOURCE_HEAD=unknown\s*$/m);
    expect(target.block).toMatch(/^ARG SOURCE_DIRTY=true\s*$/m);
    expect(target.block).toContain('com.clientix.source-head="$SOURCE_HEAD"');
    expect(target.block).toContain('com.clientix.source-dirty="$SOURCE_DIRTY"');
    expect(target.block).toContain('com.clientix.release-eligible="true"');
    expect(recipe.title).not.toBe("");
  });

  it("o build oficial envia o SHA limpo e o metadata-action grava identidade e versão OCI", () => {
    expect(publishWorkflow).toContain("uses: docker/metadata-action@v6");
    expect(publishWorkflow).toContain("labels: ${{ steps.meta.outputs.labels }}");
    expect(publishWorkflow).toContain("SOURCE_HEAD=${{ github.sha }}");
    expect(publishWorkflow).toContain("SOURCE_DIRTY=false");
    expect(publishWorkflow).toContain("APP_VERSION=${{ steps.ver.outputs.value }}");
  });

  it("aceita apenas imagem limpa, elegível e vinculada ao commit esperado", () => {
    expect(releaseImageMetadataMismatches(VALID_LABELS, EXPECTED_HEAD)).toEqual([]);
    expect(
      releaseImageMetadataMismatches(
        { ...VALID_LABELS, "com.clientix.source-dirty": "true" },
        EXPECTED_HEAD,
      ),
    ).toContain("com.clientix.source-dirty");
  });

  it("falha fechado para source-head ausente, malformado ou diferente", () => {
    expect(
      releaseImageMetadataMismatches(
        { ...VALID_LABELS, "com.clientix.source-head": undefined },
        EXPECTED_HEAD,
      ),
    ).toContain("com.clientix.source-head");
    expect(
      releaseImageMetadataMismatches(
        { ...VALID_LABELS, "com.clientix.source-head": "not-a-commit" },
        EXPECTED_HEAD,
      ),
    ).toContain("com.clientix.source-head");
    expect(
      releaseImageMetadataMismatches(
        { ...VALID_LABELS, "com.clientix.source-head": "b".repeat(40) },
        EXPECTED_HEAD,
      ),
    ).toContain("com.clientix.source-head");
  });

  it("falha fechado para release-eligible ausente ou falso e para SHA esperado inválido", () => {
    expect(
      releaseImageMetadataMismatches(
        { ...VALID_LABELS, "com.clientix.release-eligible": undefined },
        EXPECTED_HEAD,
      ),
    ).toContain("com.clientix.release-eligible");
    expect(
      releaseImageMetadataMismatches(
        { ...VALID_LABELS, "com.clientix.release-eligible": "false" },
        EXPECTED_HEAD,
      ),
    ).toContain("com.clientix.release-eligible");
    expect(releaseImageMetadataMismatches(VALID_LABELS, "malformed")).toEqual([
      "expected-source-head",
    ]);
  });
});
