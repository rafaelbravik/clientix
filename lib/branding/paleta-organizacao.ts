/**
 * Paletas opcionais por organização. `null` preserva exatamente os tokens
 * atuais; o modo claro/escuro continua sendo uma preferência de cada pessoa.
 */
export const PALETAS_VISUAIS_ORGANIZACAO = ["ocean", "sand", "forest"] as const;

export type PaletaVisualOrganizacao = (typeof PALETAS_VISUAIS_ORGANIZACAO)[number];

/** Lê a configuração sem confiar na forma livre de `organizations.settings`. */
export function paletaVisualDaOrganizacao(settings: unknown): PaletaVisualOrganizacao | null {
  if (typeof settings !== "object" || settings === null || Array.isArray(settings)) return null;

  const branding = (settings as Record<string, unknown>).branding;
  if (typeof branding !== "object" || branding === null || Array.isArray(branding)) return null;

  const preset = (branding as Record<string, unknown>).appearance_preset;
  return preset === "ocean" || preset === "sand" || preset === "forest" ? preset : null;
}
