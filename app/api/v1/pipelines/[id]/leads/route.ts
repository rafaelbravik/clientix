import { randomUUID } from "node:crypto";
import { type NextRequest } from "next/server";
import { z } from "zod";

import { fail, ok } from "@/lib/api/wrappers";
import { requireRole } from "@/lib/auth/require-role";
import { traduzir } from "@/lib/i18n/dicionario";
import type { PipelineLeadListRow } from "@/lib/kanban/types";
import { createClient } from "@/lib/supabase/server";
import type { Lead } from "@/lib/types/leads";

export const dynamic = "force-dynamic";

interface RouteCtx {
  params: Promise<{ id: string }>;
}

const UUID = z.string().uuid();
const paginationSchema = z.object({
  page: z.coerce.number().int().min(1).max(1_000_000),
  per_page: z.coerce.number().int().min(1).optional(),
});
const PER_PAGE_DEFAULT = 50;
const PER_PAGE_MAX = 200;

/**
 * GET /api/v1/pipelines/[id]/leads
 *
 * Consulta independente do Kanban: o tenant e o funil são filtrados no banco,
 * a ordenação é determinística e o intervalo é aplicado antes de devolver a
 * página. O total é exato porque faz parte do contrato desta tela.
 */
export async function GET(req: NextRequest, ctx: RouteCtx): Promise<Response> {
  const requestId = randomUUID();
  const authz = await requireRole("viewer", { requestId, resource: "pipeline_leads_list" });
  if (!authz.ok) return authz.response;

  const t = (texto: string) => traduzir(texto, authz.user.idioma);
  const { id: pipelineId } = await ctx.params;
  if (!UUID.safeParse(pipelineId).success) {
    return fail("unprocessable_entity", t("Identificador de funil inválido."), 422, { requestId });
  }

  const parsed = paginationSchema.safeParse({
    page: req.nextUrl.searchParams.get("page") ?? "1",
    per_page: req.nextUrl.searchParams.get("per_page") ?? String(PER_PAGE_DEFAULT),
  });
  if (!parsed.success) {
    return fail("unprocessable_entity", t("Parâmetros de paginação inválidos."), 422, { requestId });
  }

  const perPage = Math.min(parsed.data.per_page ?? PER_PAGE_DEFAULT, PER_PAGE_MAX);
  const offset = (parsed.data.page - 1) * perPage;
  if (!Number.isSafeInteger(offset)) {
    return fail("unprocessable_entity", t("Página fora do intervalo permitido."), 422, { requestId });
  }

  try {
    const supabase = await createClient();
    const { data: pipeline, error: pipelineError } = await supabase
      .from("crm_pipelines")
      .select("id")
      .eq("organization_id", authz.org.orgId)
      .eq("id", pipelineId)
      .maybeSingle();

    if (pipelineError) {
      return fail("internal_error", t("Não foi possível carregar a lista do funil."), 500, { requestId });
    }
    // A mesma resposta para inexistente e cross-tenant evita enumeração.
    if (!pipeline) return fail("resource_not_found", t("Pipeline não encontrado."), 404, { requestId });

    const { data: leadsData, error: leadsError, count } = await supabase
      .from("crm_leads")
      .select("*", { count: "exact" })
      .eq("organization_id", authz.org.orgId)
      .eq("pipeline_id", pipelineId)
      .neq("status", "archived")
      .order("position_in_stage", { ascending: true })
      .order("id", { ascending: true })
      .range(offset, offset + perPage - 1);

    // PostgREST pode devolver PGRST103 quando o início do intervalo está além
    // da última linha. Confirma o total com os mesmos filtros de tenant/funil;
    // só converte em página vazia quando ela realmente começa após o total.
    // Outros intervalos inválidos continuam sendo erro, sem mascarar falhas.
    if (leadsError?.code === "PGRST103") {
      const { count: total, error: countError } = await supabase
        .from("crm_leads")
        .select("id", { count: "exact", head: true })
        .eq("organization_id", authz.org.orgId)
        .eq("pipeline_id", pipelineId)
        .neq("status", "archived");

      if (countError || total === null) {
        return fail("internal_error", t("Não foi possível carregar a lista do funil."), 500, { requestId });
      }
      if (offset >= total) {
        return ok([], {
          requestId,
          meta: { page: parsed.data.page, per_page: perPage, total, has_more: false },
        });
      }
    }

    if (leadsError || count === null) {
      return fail("internal_error", t("Não foi possível carregar a lista do funil."), 500, { requestId });
    }

    const leads = (leadsData ?? []) as Lead[];
    const stageIds = [...new Set(leads.map((lead) => lead.stage_id))];
    const stageNames = new Map<string, string>();
    if (stageIds.length > 0) {
      const { data: stages, error: stagesError } = await supabase
        .from("crm_stages")
        .select("id, name")
        .eq("organization_id", authz.org.orgId)
        .eq("pipeline_id", pipelineId)
        .in("id", stageIds);
      if (stagesError) {
        return fail("internal_error", t("Não foi possível carregar a lista do funil."), 500, { requestId });
      }
      for (const stage of (stages ?? []) as Array<{ id: string; name: string }>) {
        stageNames.set(stage.id, stage.name);
      }
    }

    const data: PipelineLeadListRow[] = leads.map((lead) => ({
      ...lead,
      stage_name: stageNames.get(lead.stage_id) ?? null,
    }));

    return ok(data, {
      requestId,
      meta: {
        page: parsed.data.page,
        per_page: perPage,
        total: count,
        has_more: offset + data.length < count,
      },
    });
  } catch {
    return fail("internal_error", t("Não foi possível carregar a lista do funil."), 500, { requestId });
  }
}
