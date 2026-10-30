import {
  ProspectingError,
  providerRequest,
  readResults as readApifyResults,
  readSearch as readApifySearch,
  startSearch as startApifySearch,
} from "./provider";
import { localHttpProvider } from "./provider-local-http";
import type { SearchInput } from "./schema";

export const DEFAULT_PROSPECTING_PROVIDER = "apify" as const;
export type ProspectingProviderName = "apify" | "local-http";

export interface SearchRun {
  id: string;
  status: string;
  defaultDatasetId?: string;
  usageTotalUsd?: number;
}

export interface SearchProvider {
  startSearch(credential: string, input: SearchInput): Promise<SearchRun>;
  readSearch(credential: string, id: string): Promise<SearchRun>;
  readResults(credential: string, dataset: string, limit: number): Promise<Record<string, unknown>[]>;
}

const apifyProvider: SearchProvider = {
  startSearch: startApifySearch,
  readSearch: readApifySearch,
  readResults: readApifyResults,
};

export function providerNameFromSettings(settings: unknown): ProspectingProviderName {
  if (settings === null || typeof settings !== "object" || Array.isArray(settings))
    return DEFAULT_PROSPECTING_PROVIDER;
  const root = settings as Record<string, unknown>;
  if (!Object.hasOwn(root, "prospecting")) return DEFAULT_PROSPECTING_PROVIDER;
  const prospecting = root.prospecting;
  if (prospecting === null || typeof prospecting !== "object" || Array.isArray(prospecting))
    throw new ProspectingError("A configuração do provedor de prospecção é inválida.", 422);
  const config = prospecting as Record<string, unknown>;
  if (!Object.hasOwn(config, "provider")) return DEFAULT_PROSPECTING_PROVIDER;
  const value = config.provider;
  if (value === "apify" || value === "local-http") return value;
  throw new ProspectingError("O provedor de prospecção configurado não é reconhecido.", 422);
}

export async function providerNameForOrganization(
  db: { query(sql: string, params?: unknown[]): Promise<{ rows: { settings?: unknown }[] }> },
  organizationId: string,
): Promise<ProspectingProviderName> {
  const { rows } = await db.query("select settings from organizations where id=$1", [organizationId]);
  if (!rows.length) throw new ProspectingError("Organização não encontrada.", 404);
  return providerNameFromSettings(rows[0]?.settings);
}

export function providerByName(name: string): SearchProvider {
  if (name === "apify") return apifyProvider;
  if (name === "local-http") return localHttpProvider;
  throw new ProspectingError("O provedor de prospecção configurado não é reconhecido.", 422);
}

export async function validateApifyCredential(credential: string): Promise<void> {
  await providerRequest(credential, "users/me");
}

export async function updateProspectingProvider(
  pool: { query(sql: string, params?: unknown[]): Promise<{ rowCount?: number | null }> },
  organizationId: string,
  provider: ProspectingProviderName,
): Promise<void> {
  const result = await pool.query(
    `update organizations
        set settings = jsonb_set(
          coalesce(settings, '{}'::jsonb),
          '{prospecting}',
          coalesce(settings->'prospecting', '{}'::jsonb) || jsonb_build_object('provider', $2::text),
          true
        )
      where id = $1
        and jsonb_typeof(coalesce(settings, '{}'::jsonb)) = 'object'
        and (settings->'prospecting' is null or jsonb_typeof(settings->'prospecting') = 'object')`,
    [organizationId, provider],
  );
  if (result.rowCount !== 1)
    throw new ProspectingError("A configuração da organização não pôde ser atualizada.", 409);
}
