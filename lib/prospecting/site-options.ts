/** Shared defaults for new search requests and older persisted search JSON. */
export interface SitePreparationOptions {
  avaliarSite: boolean;
  gerarPrevia: boolean;
}

export function sitePreparationOptions(search: unknown): SitePreparationOptions {
  const value = search && typeof search === "object" ? (search as Record<string, unknown>) : {};
  const avaliarSite = value.avaliar_site !== false;
  return { avaliarSite, gerarPrevia: avaliarSite && value.gerar_previa === true };
}
