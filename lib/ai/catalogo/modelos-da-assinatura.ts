import { createAdminClient } from "@/lib/supabase/admin";
import {
  CHATGPT_SUBSCRIPTION_LABEL,
  CHATGPT_SUBSCRIPTION_PROVIDER,
} from "@/lib/ai/credenciais/chatgpt-siwc";
import { obterAccessTokenSiwc } from "@/lib/ai/credenciais/chatgpt-subscription";
import { moduloLigado } from "@/lib/instalacao/modulos";

type Admin = ReturnType<typeof createAdminClient>;

export const CHATGPT_MODELS_ENDPOINT = "https://api.openai.com/v1/models";
export const CHATGPT_MODELS_TIMEOUT_MS = 10_000;

export interface ModeloDaAssinatura {
  model_id: string;
  display_name: string;
}

export type ErroDoCatalogoDaAssinatura =
  | "feature_disabled"
  | "not_connected"
  | "credential_unreadable"
  | "credential_storage_failed"
  | "token_refresh_failed"
  | "models_http_error"
  | "models_timeout"
  | "models_network_error"
  | "models_invalid_payload"
  | "models_refresh_failed";

export type ResultadoDoCatalogoDaAssinatura =
  | {
      ok: true;
      catalog_status: "ready" | "models_empty_valid";
      models: ModeloDaAssinatura[];
    }
  | {
      ok: false;
      error: ErroDoCatalogoDaAssinatura;
      httpStatus?: number;
    };

function objeto(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function nomeDoErro(error: unknown): string {
  return objeto(error) && typeof error.name === "string" ? error.name : "";
}

function extrairModelos(value: unknown): ModeloDaAssinatura[] | null {
  if (!objeto(value) || !Array.isArray(value.models)) return null;

  const result: ModeloDaAssinatura[] = [];
  const vistos = new Set<string>();
  for (const item of value.models) {
    if (!objeto(item) || item.visibility !== "list") continue;
    const slug = typeof item.slug === "string" ? item.slug.trim() : "";
    const id = typeof item.id === "string" ? item.id.trim() : "";
    const modelId = slug || id;
    // Um item listado sem identificador válido torna a resposta ambígua. Não
    // persiste um catálogo parcial como se fosse completo.
    if (!modelId) return null;
    const displayName = typeof item.display_name === "string" ? item.display_name.trim() : "";
    if (vistos.has(modelId)) continue;
    vistos.add(modelId);
    result.push({ model_id: modelId, display_name: displayName || modelId });
  }
  return result;
}

function erroDoToken(error: string): ErroDoCatalogoDaAssinatura {
  switch (error) {
    case "feature_disabled":
    case "not_connected":
    case "credential_unreadable":
      return error;
    case "refresh_failed":
    case "refresh_in_progress":
      return "token_refresh_failed";
    case "storage_failed":
      return "credential_storage_failed";
    default:
      return "token_refresh_failed";
  }
}

/**
 * Lê apenas o catálogo permitido pela conta SIWC da organização e persiste
 * seus slugs em `models_available`. O token nunca sai deste processo.
 */
export async function listarModelosDaAssinatura(entrada: {
  organizationId: string;
  admin?: Admin;
  fetchImpl?: typeof fetch;
}): Promise<ResultadoDoCatalogoDaAssinatura> {
  const admin = entrada.admin ?? createAdminClient();
  const token = await obterAccessTokenSiwc({ admin, organizationId: entrada.organizationId });
  if (!token.ok) return { ok: false, error: erroDoToken(token.error) };

  const fetchImpl = entrada.fetchImpl ?? fetch;
  let response: Response;
  try {
    response = await fetchImpl(CHATGPT_MODELS_ENDPOINT, {
      method: "GET",
      headers: { Authorization: `Bearer ${token.accessToken}` },
      cache: "no-store",
      redirect: "error",
      signal: AbortSignal.timeout(CHATGPT_MODELS_TIMEOUT_MS),
    });
  } catch (error) {
    const name = nomeDoErro(error);
    return {
      ok: false,
      error: name === "TimeoutError" || name === "AbortError" ? "models_timeout" : "models_network_error",
    };
  }

  if (!response.ok) {
    return { ok: false, error: "models_http_error", httpStatus: response.status };
  }

  let body: unknown;
  try {
    body = await response.json();
  } catch (error) {
    const name = nomeDoErro(error);
    return {
      ok: false,
      error: name === "TimeoutError" || name === "AbortError"
        ? "models_timeout"
        : name === "TypeError"
          ? "models_network_error"
          : "models_invalid_payload",
    };
  }
  const models = extrairModelos(body);
  if (!models) return { ok: false, error: "models_invalid_payload" };

  const { data, error } = await admin
    .from("ai_provider_credentials")
    .update({ models_available: models.map((model) => model.model_id) })
    .eq("organization_id", entrada.organizationId)
    .eq("provider", CHATGPT_SUBSCRIPTION_PROVIDER)
    .eq("label", CHATGPT_SUBSCRIPTION_LABEL)
    .eq("is_active", true)
    .not("validated_at", "is", null)
    .select("id")
    .maybeSingle();

  if (error || !data) return { ok: false, error: "models_refresh_failed" };
  return {
    ok: true,
    catalog_status: models.length === 0 ? "models_empty_valid" : "ready",
    models,
  };
}

export type ResultadoDeValidarModeloDaAssinatura =
  | { ok: true }
  | { ok: false; error: "feature_disabled" | "not_connected" | "model_not_allowed" | "credential_storage_failed" };

/**
 * A validação server-side para drafts impede que um model ID digitado ou
 * enviado diretamente contorne o catálogo daquela conta/organização.
 */
export async function validarModeloDaAssinatura(entrada: {
  admin?: Admin;
  organizationId: string;
  credentialId: string | null;
  modelId: string;
}): Promise<ResultadoDeValidarModeloDaAssinatura> {
  const admin = entrada.admin ?? createAdminClient();
  if (!(await moduloLigado(admin, "login_codex"))) {
    return { ok: false, error: "feature_disabled" };
  }
  if (!entrada.credentialId) return { ok: false, error: "not_connected" };

  const { data, error } = await admin
    .from("ai_provider_credentials_safe")
    .select("id, models_available, is_active, validated_at")
    .eq("id", entrada.credentialId)
    .eq("organization_id", entrada.organizationId)
    .eq("provider", CHATGPT_SUBSCRIPTION_PROVIDER)
    .eq("label", CHATGPT_SUBSCRIPTION_LABEL)
    .maybeSingle();
  if (error) return { ok: false, error: "credential_storage_failed" };
  if (!data) return { ok: false, error: "not_connected" };

  const row = data as {
    id: string;
    models_available: string[] | null;
    is_active: boolean;
    validated_at: string | null;
  };
  if (!row.is_active || !row.validated_at) return { ok: false, error: "not_connected" };
  if (!Array.isArray(row.models_available) || !row.models_available.includes(entrada.modelId)) {
    return { ok: false, error: "model_not_allowed" };
  }
  return { ok: true };
}
