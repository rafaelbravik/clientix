/**
 * GET /api/v1/ai/providers/:provider/models
 *
 * Lê do catálogo curado `ai_models` (tabela GLOBAL, RLS read-all).
 * Retorna modelos não-deprecated ordenados por default-first depois preço.
 */
import { randomUUID } from "node:crypto";
import { type NextRequest } from "next/server";

import { ok, fail } from "@/lib/api/wrappers";
import { loadAuthUser } from "@/lib/auth/server";
import { orgAtivaDaApi } from "@/lib/auth/require-role";
import { createClient } from "@/lib/supabase/server";
import { ehProvedorSuportado } from "@/lib/ai/pontos/provedores";
import { CHATGPT_SUBSCRIPTION_PROVIDER } from "@/lib/ai/credenciais/chatgpt-siwc";
import { listarModelosDaAssinatura } from "@/lib/ai/catalogo/modelos-da-assinatura";

export const dynamic = "force-dynamic";

// A lista única (`lib/ai/pontos/provedores.ts`) — não uma quarta cópia. Esta
// rota alimenta o seletor de modelos; com a lista velha, pedir os modelos da
// OpenRouter devolvia "provedor desconhecido" para um provedor que a tela ao
// lado oferecia.

const MODEL_COLUMNS =
  "id, provider, model_id, display_name, description, context_window, input_price_per_million_cents, output_price_per_million_cents, supports_tools, is_default_for_provider, deprecated_at, released_at";

export async function GET(
  _req: NextRequest,
  ctx: { params: Promise<{ provider: string }> },
): Promise<Response> {
  const requestId = randomUUID();
  const { provider } = await ctx.params;
  const assinatura = provider === CHATGPT_SUBSCRIPTION_PROVIDER;

  if (!assinatura && !ehProvedorSuportado(provider)) {
    return fail("not_found", "Provider desconhecido.", 404, { requestId });
  }

  const authUser = await loadAuthUser();
  if (!authUser) return fail("unauthenticated", "Auth required.", 401, { requestId });
  const ativa = await orgAtivaDaApi(authUser, requestId);
  if (!ativa.ok) return ativa.response;
  const activeOrg = ativa.org;
  if (!activeOrg) {
    return fail("forbidden_tenant", "Sem organização ativa.", 403, { requestId });
  }

  if (assinatura) {
    const catalogo = await listarModelosDaAssinatura({ organizationId: activeOrg.orgId });
    if (!catalogo.ok) {
      const status =
        catalogo.error === "feature_disabled" ? 403
        : catalogo.error === "not_connected" ? 409
        : catalogo.error === "models_timeout" ? 504
        : catalogo.error === "models_refresh_failed" ? 500
        : catalogo.error === "credential_storage_failed" ? 500
        : catalogo.error === "credential_unreadable" ? 500
        : 502;
      const messages: Record<typeof catalogo.error, string> = {
        feature_disabled: "Este recurso está desativado nesta instalação.",
        not_connected: "Conecte a assinatura do ChatGPT em IA › Credenciais.",
        credential_unreadable: "Não foi possível ler a conexão salva. Revise IA › Credenciais.",
        credential_storage_failed: "Não foi possível atualizar a conexão salva. Revise IA › Credenciais.",
        token_refresh_failed: "Não foi possível renovar a conexão da conta. Tente reconectar em IA › Credenciais.",
        models_http_error: "A conta respondeu com erro ao consultar o catálogo de modelos.",
        models_timeout: "A consulta do catálogo de modelos excedeu o tempo limite.",
        models_network_error: "Não foi possível alcançar o catálogo de modelos.",
        models_invalid_payload: "A resposta do catálogo de modelos veio em formato inesperado.",
        models_refresh_failed: "Não foi possível atualizar o catálogo salvo da conta.",
      };
      return fail(catalogo.error, messages[catalogo.error], status, {
        requestId,
        ...(catalogo.httpStatus ? { details: { upstream_status: catalogo.httpStatus } } : {}),
      });
    }
    return ok(
      {
        models: catalogo.models.map((model) => ({
          provider: CHATGPT_SUBSCRIPTION_PROVIDER,
          model_id: model.model_id,
          display_name: model.display_name,
          context_window: null,
          is_default_for_provider: false,
        })),
        catalog_status: catalogo.catalog_status,
      },
      { requestId },
    );
  }

  const supabase = await createClient();
  const { data, error } = await supabase
    .from("ai_models")
    .select(MODEL_COLUMNS)
    .eq("provider", provider)
    .is("deprecated_at", null)
    .order("is_default_for_provider", { ascending: false })
    .order("input_price_per_million_cents", { ascending: true });

  if (error) {
    return fail("internal_error", "Erro ao listar modelos.", 500, { requestId });
  }

  // UM MODELO DE BUSCA NÃO É UM ATENDENTE.
  //
  // O catálogo é o mesmo que alimenta os pontos de índice/busca do RAG, então
  // ele traz `text-embedding-3-small` — modelo que só converte texto em
  // vetor. Era oferecido no seletor "Modelo" do agente (IA › Agentes › Modelo),
  // e quem o escolhia ficava com um atendente mudo: embedding não conversa.
  //
  // `supports_tools` é a MESMA régua que `escolherModeloDoProvedor`
  // (`lib/ai/agents/escolher-modelo.ts`) já usa para escolher o modelo do
  // atendente e que `validarBinding` aplica no painel: sem ferramenta o modelo
  // devolve texto plausível e nada chega ao funil. Filtrar aqui é filtrar em
  // todos os seletôres — esta rota é a única fonte do `ModelPicker`.
  //
  // O filtro é em memória de propósito: são no máximo centenas de linhas, e
  // assim o teste da rota enxerga a regra (um `eq` no banco o esconderia do
  // dublê, que devolve a lista inteira).
  const models = (data ?? []).filter((m) => m.supports_tools === true);

  return ok({ models }, { requestId });
}
