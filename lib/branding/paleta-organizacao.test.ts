import { describe, expect, it } from "vitest";
import { paletaVisualDaOrganizacao } from "./paleta-organizacao";

describe("paletaVisualDaOrganizacao", () => {
  it.each(["ocean", "sand", "forest"] as const)("aceita a paleta %s", (preset) => {
    expect(paletaVisualDaOrganizacao({ branding: { appearance_preset: preset } })).toBe(preset);
  });

  it.each([
    null,
    undefined,
    "ocean",
    [],
    { branding: null },
    { branding: [] },
    { branding: { appearance_preset: "unsupported" } },
  ])("ignora configuração ausente ou inválida: %j", (settings) => {
    expect(paletaVisualDaOrganizacao(settings)).toBeNull();
  });
});
