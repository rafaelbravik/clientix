import fs from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  candidataDoAcervo,
  medir,
  selecionarLoteDeRelease,
  vereditoDoAcervo,
} from "@/lib/release/cabe-na-tela";
import type { Fragmento } from "@/lib/release/fragmento";

const RAIZ = process.cwd();
const CHANGELOG = fs.readFileSync(path.join(RAIZ, "CHANGELOG.md"), "utf8");
const AGENT_SH = fs.readFileSync(path.join(RAIZ, "hostgator-setup-kit/agent.sh"), "utf8");

function fragmento(arquivo: string, tamanho: number, exigeAcao = false): Fragmento {
  return {
    arquivo,
    impacto: exigeAcao ? "exige_acao" : "nada_mudou",
    secao: "corrigido",
    titulo: `nota ${arquivo}`,
    corpo: "x".repeat(tamanho),
    atencao: exigeAcao ? "Conclua esta configuração antes de atualizar." : null,
  };
}

describe("o corte de release preserva tudo e respeita a tela da VPS", () => {
  it("consome o maior lote que cabe e prioriza todos os avisos obrigatórios", () => {
    const fragmentos = [
      fragmento("c-terceiro.md", 12_000),
      fragmento("z-aviso-obrigatorio.md", 1_000, true),
      fragmento("a-primeiro.md", 12_000),
      fragmento("b-segundo.md", 12_000),
    ];

    const lote = selecionarLoteDeRelease(CHANGELOG, fragmentos, AGENT_SH);

    expect(lote.selecionados.map((f) => f.arquivo)).toEqual([
      "z-aviso-obrigatorio.md",
      "a-primeiro.md",
      "b-segundo.md",
    ]);
    expect(lote.pendentes.map((f) => f.arquivo)).toEqual(["c-terceiro.md"]);
    expect(lote.pendentes.some((f) => f.impacto === "exige_acao")).toBe(false);
    expect(lote.medida.cabe).toBe(true);
    expect(lote.medida.completa).toBe(true);
    expect(lote.medida.avisoSobrevive).toBe(true);

    const proximo = candidataDoAcervo(CHANGELOG, [...lote.selecionados, lote.pendentes[0]!]);
    expect(proximo).not.toBeNull();
    expect(vereditoDoAcervo(medir(proximo!, AGENT_SH)).reprova).toBe(true);
  });

  it("falha fechado se os avisos `exige_acao` não couberem juntos", () => {
    const fragmentos = [fragmento("acao-a.md", 16_000, true), fragmento("acao-b.md", 16_000, true)];

    expect(() => selecionarLoteDeRelease(CHANGELOG, fragmentos, AGENT_SH)).toThrow(/exige_acao/);
  });

  it("não consome um único fragmento que excede o limite", () => {
    expect(() =>
      selecionarLoteDeRelease(CHANGELOG, [fragmento("grande.md", 31_000)], AGENT_SH),
    ).toThrow(/sozinho excede o limite/);
  });
});
