import { describe, expect, it } from "vitest";

import {
  chaveDeComparacaoDeEtiqueta,
  etiquetaExistentePara,
  etiquetaParaGravar,
  etiquetasConhecidas,
  opcaoDeCriar,
  sugestoesDeEtiqueta,
} from "@/lib/contacts/etiquetas";

describe("helpers compartilhados dos editores de etiquetas", () => {
  const conhecidas = etiquetasConhecidas([
    "carteira-andreia",
    "carteira-danilo",
    "vip",
    "Google ",
    "google",
    "São Paulo",
  ]);

  it("a chave ignora caixa e acento sem alterar o valor canônico", () => {
    expect(chaveDeComparacaoDeEtiqueta(" CARTEIRA-ANDRÉIA ")).toBe("carteira-andreia");
    expect(etiquetaExistentePara(conhecidas, "CARTEIRA-ANDRÉIA")).toBe("carteira-andreia");
  });

  it("deduplica equivalentes mantendo ordem e forma normalizada do vocabulário", () => {
    expect(conhecidas).toEqual([
      "carteira-andreia",
      "carteira-danilo",
      "vip",
      "google",
      "são paulo",
    ]);
  });

  it("filtra o vocabulário completo por trecho sem mudar a ordem", () => {
    expect(
      sugestoesDeEtiqueta({
        conhecidas,
        selecionadas: [],
        digitado: "CARTEIRA",
        limite: 8,
      }),
    ).toEqual(["carteira-andreia", "carteira-danilo"]);
  });

  it("busca depois das oito mais usadas antes de limitar as sugestões", () => {
    const vocabularioCompleto = [
      "uso-1",
      "uso-2",
      "uso-3",
      "uso-4",
      "uso-5",
      "uso-6",
      "uso-7",
      "uso-8",
      "carteira-andreia",
    ];
    expect(
      sugestoesDeEtiqueta({
        conhecidas: vocabularioCompleto,
        selecionadas: [],
        digitado: "carteira",
      }),
    ).toEqual(["carteira-andreia"]);
  });

  it("omite sugestão já selecionada por caixa/acento", () => {
    expect(
      sugestoesDeEtiqueta({
        conhecidas,
        selecionadas: ["CARTEIRA-ANDRÉIA"],
        digitado: "carteira",
      }),
    ).toEqual(["carteira-danilo"]);
  });

  it("só oferece criar por último quando há nome novo, não vazio ou equivalente", () => {
    expect(
      opcaoDeCriar({ conhecidas, selecionadas: [], digitado: "CARTEIRA-ANDRÉIA" }),
    ).toBeNull();
    expect(opcaoDeCriar({ conhecidas, selecionadas: [], digitado: "carteira" })).toBe("carteira");
    expect(opcaoDeCriar({ conhecidas, selecionadas: [], digitado: "   " })).toBeNull();
    expect(opcaoDeCriar({ conhecidas, selecionadas: ["VIP"], digitado: "vip" })).toBeNull();
  });

  it("aplica a etiqueta existente com a grafia canônica", () => {
    expect(
      etiquetaParaGravar({ conhecidas, selecionadas: [], digitado: "CARTEIRA-ANDRÉIA" }),
    ).toBe("carteira-andreia");
  });

  it("normaliza tag nova pelo contrato de trim, lowercase e tamanho", () => {
    expect(
      etiquetaParaGravar({
        conhecidas,
        selecionadas: [],
        digitado: `  NOVA ${"x".repeat(50)}  `,
      }),
    ).toBe(`nova ${"x".repeat(35)}`);
  });

  it("não grava vazio, whitespace nem equivalente que já esteja selecionado", () => {
    expect(etiquetaParaGravar({ conhecidas, selecionadas: [], digitado: " " })).toBeNull();
    expect(
      etiquetaParaGravar({ conhecidas, selecionadas: ["carteira-andreia"], digitado: "CARTEIRA-ANDRÉIA" }),
    ).toBeNull();
  });
});
