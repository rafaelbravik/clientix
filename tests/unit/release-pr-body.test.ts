import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

describe("descrição do PR de release", () => {
  it("mantém o caminho .changes/ literal no corpo do PR", () => {
    const workflow = readFileSync(join(process.cwd(), ".github/workflows/release.yml"), "utf8");
    const comando = workflow.split("\n").find((linha) => linha.includes("O corte mantém em"));

    if (!comando) throw new Error("A linha sobre os fragmentos preservados sumiu do workflow.");

    const saida = execFileSync("bash", ["-c", comando.trim()], { encoding: "utf8" }).trimEnd();
    expect(saida).toContain("O corte mantém em `.changes/` os fragmentos que não couberam;");
  });
});
