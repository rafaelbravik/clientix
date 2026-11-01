import { describe, expect, it } from "vitest";
import { searchSchema, safePublicLink } from "./schema";
import { sitePreparationOptions } from "./site-options";

describe("opções persistidas para preparação de sites", () => {
  it("usa avaliar_site=true por padrão e mantém prévia desligada até a wave própria", () => {
    expect(sitePreparationOptions(undefined)).toEqual({ avaliarSite: true, gerarPrevia: false });
    expect(sitePreparationOptions({ })).toEqual({ avaliarSite: true, gerarPrevia: false });
    expect(sitePreparationOptions({ avaliar_site: false, gerar_previa: true })).toEqual({ avaliarSite: false, gerarPrevia: false });
    expect(sitePreparationOptions({ avaliar_site: true, gerar_previa: true })).toEqual({ avaliarSite: true, gerarPrevia: true });
  });

  it("persiste as opções tipadas no JSON da busca sem tornar o preview obrigatório", () => {
    const parsed = searchSchema.parse({ name: "Busca", niche: "clínica", location: "São Paulo", enrich: true });
    expect(parsed.avaliar_site).toBe(true);
    expect(parsed.gerar_previa).toBeUndefined();
    expect(sitePreparationOptions(parsed)).toEqual({ avaliarSite: true, gerarPrevia: false });
  });

  it("só oferece links externos http(s) sem userinfo nem IP literal privado", () => {
    expect(safePublicLink("https://empresa.example/contato")).toBe("https://empresa.example/contato");
    expect(safePublicLink("empresa.example/contato")).toBe("https://empresa.example/contato");
    for (const value of [
      "javascript:alert(1)",
      "file:///etc/passwd",
      "http://user:pass@empresa.example/",
      "http://127.0.0.1/",
      "http://10.0.0.2/",
      "http://[::1]/",
      "http://169.254.169.254/",
    ]) expect(safePublicLink(value)).toBeUndefined();
  });
});
