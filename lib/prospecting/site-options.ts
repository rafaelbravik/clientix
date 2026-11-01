/** Shared defaults for the search JSONB flags; preview remains opt-in until its own wave. */
export interface SitePreparationOptions {
  avaliarSite: boolean;
  gerarPrevia: boolean;
}

export function sitePreparationOptions(search: unknown): SitePreparationOptions {
  const value = search && typeof search === "object" ? (search as Record<string, unknown>) : {};
  const avaliarSite = value.avaliar_site !== false;
  return { avaliarSite, gerarPrevia: avaliarSite && value.gerar_previa === true };
}
