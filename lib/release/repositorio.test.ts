import { describe, expect, it } from "vitest";

import { resolverRepositorioDaRelease, urlDeComparacaoDaRelease } from "./repositorio";

describe("identidade do repositório nos links de release", () => {
  it("usa o repositório informado pelo GitHub Actions", () => {
    expect(resolverRepositorioDaRelease("rafaelbravik/clientix")).toBe("rafaelbravik/clientix");
  });

  it("mantém o contexto de um fork que execute o próprio workflow", () => {
    expect(resolverRepositorioDaRelease("equipe/clientix-fork")).toBe("equipe/clientix-fork");
  });

  it("usa o repositório Clientix quando o contexto está ausente ou malformado", () => {
    expect(resolverRepositorioDaRelease()).toBe("rafaelbravik/clientix");
    expect(resolverRepositorioDaRelease("owner/repo/extra")).toBe("rafaelbravik/clientix");
    expect(resolverRepositorioDaRelease("invalid\n/repo")).toBe("rafaelbravik/clientix");
  });

  it("gera a URL de comparação usando o servidor e repositório selecionados", () => {
    expect(urlDeComparacaoDaRelease("https://code.example", "rafaelbravik/clientix", "v2.0.0", "v2.1.0")).toBe(
      "https://code.example/rafaelbravik/clientix/compare/v2.0.0...v2.1.0",
    );
  });

  it("recusa uma origem que não usa HTTPS", () => {
    expect(() => urlDeComparacaoDaRelease("http://code.example", "equipe/repo", "v1.0.0", "v1.1.0")).toThrow(
      "Origem inválida",
    );
  });
});
