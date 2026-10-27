import { requireSupportWrite } from "@/lib/impersonate/support";
/**
 * PATCH  /api/v1/ai/knowledge/sources/[id]  — update knowledge source
 * DELETE /api/v1/ai/knowledge/sources/[id]  — soft-delete (status='archived')
 *
 * Auth: cookie session. Role >= manager required.
 * organization_id is ALWAYS resolved from the authenticated session — never from body/path.
 */

import { randomUUID } from "node:crypto";
import { type NextRequest } from "next/server";
import { z } from "zod";
import { ok, fail } from "@/lib/api/wrappers";
import { audit } from "@/lib/audit";
import { requireRole } from "@/lib/auth/require-role";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";
import { canonizarTipoDeFonte } from "@/lib/ai/rag/tipos-de-fonte";

export const dynamic = "force-dynamic";

// ---------------------------------------------------------------------------
// Zod schema for PATCH
// ---------------------------------------------------------------------------

const faqItemSchema = z.object({
  question: z.string().min(1),
  answer: z.string().min(1),
  tags: z.array(z.string()).optional().default([]),
  locale: z.string().optional().default("pt-BR"),
});

const patchSourceSchema = z.object({
  name: z.string().min(2).max(120).optional(),
  items: z.array(faqItemSchema).optional(),
  source_metadata: z.record(z.string(), z.unknown()).optional(),
});

// ---------------------------------------------------------------------------
// Shared: resolve auth + role gate
// ---------------------------------------------------------------------------

async function resolveContext(requestId: string) {
  const authz = await requireRole("manager", { requestId, resource: "ai_knowledge" });
  if (!authz.ok) return { error: authz.response };
  return { authUser: authz.user, activeOrg: authz.org };
}

// ---------------------------------------------------------------------------
// GET — o material e o conteúdo que dá para editar
// ---------------------------------------------------------------------------
//
// Existe para o diálogo de edição não ter de adivinhar o que já está lá. Sem
// ele, "Editar conteúdo" abriria um campo vazio e salvar apagaria a FAQ inteira
// — o pior desfecho possível para um botão chamado "editar".

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const requestId = randomUUID();
  const { id: sourceId } = await params;

  const ctx = await resolveContext(requestId);
  if (ctx.error) return ctx.error;
  const { activeOrg } = ctx as Exclude<typeof ctx, { error: Response }>;

  const supabase = await createClient();
  const { data: fonte, error } = await supabase
    .from("ai_knowledge_sources")
    .select(
      "id, agent_id, organization_id, source_type, name, status, last_index_status, " +
        "last_index_error, last_indexed_at, chunks_count, is_active, source_metadata, " +
        "active_kb_version_id, created_at, updated_at",
    )
    .eq("id", sourceId)
    .eq("organization_id", activeOrg.orgId)
    .maybeSingle();

  if (error) {
    console.error("[ai-knowledge-sources] GET falhou:", error.message);
    return fail("internal_error", "Erro ao ler o material.", 500, { requestId });
  }
  if (!fonte) {
    return fail("not_found", "Material não encontrado.", 404, { requestId });
  }

  const { data: itens } = await supabase
    .from("ai_faq_items")
    .select("question, answer, tags, locale, position")
    .eq("organization_id", activeOrg.orgId)
    .eq("knowledge_source_id", sourceId)
    .order("position", { ascending: true });

  return ok({ ...(fonte as unknown as Record<string, unknown>), items: itens ?? [] }, { requestId });
}

// ---------------------------------------------------------------------------
// PATCH
// ---------------------------------------------------------------------------

export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const supportDenied = await requireSupportWrite();
  if (supportDenied) return supportDenied;

  const requestId = randomUUID();
  const { id: sourceId } = await params;

  const ctx = await resolveContext(requestId);
  if (ctx.error) return ctx.error;
  const { authUser, activeOrg } = ctx as Exclude<typeof ctx, { error: Response }>;

  // Parse + validate body.
  let rawBody: unknown;
  try {
    rawBody = await req.json();
  } catch {
    return fail("invalid_request", "Body JSON inválido.", 400, { requestId });
  }

  const parsed = patchSourceSchema.safeParse(rawBody);
  if (!parsed.success) {
    return fail("validation_failed", "Campos inválidos.", 422, {
      requestId,
      details: parsed.error.flatten(),
    });
  }

  const input = parsed.data;

  // Verify the source exists and belongs to the org (user-scoped client for RLS check).
  const supabase = await createClient();
  const { data: existing, error: fetchErr } = await supabase
    .from("ai_knowledge_sources")
    .select("id, source_type")
    .eq("id", sourceId)
    .eq("organization_id", activeOrg.orgId)
    .maybeSingle();

  if (fetchErr) {
    console.error("[ai-knowledge-sources] PATCH fetch failed:", fetchErr.message);
    return fail("internal_error", "Erro ao verificar fonte.", 500, { requestId });
  }
  if (!existing) {
    return fail("not_found", "Fonte de conhecimento não encontrada.", 404, { requestId });
  }

  const tipo = canonizarTipoDeFonte(existing.source_type as string);

  // A lista de pergunta/resposta só tem contrato de persistência em uma fonte
  // FAQ. Não confirme 200 deixando os itens recebidos sem efeito.
  if (input.items !== undefined && tipo !== "faq") {
    return fail(
      "unprocessable_entity",
      "Itens de perguntas e respostas só podem ser alterados em uma fonte FAQ.",
      422,
      { requestId },
    );
  }

  const admin = createAdminClient();
  const { data: result, error: updateErr } = await admin.rpc(
    "fn_update_ai_knowledge_source_atomic" as never,
    {
      p_source_id: sourceId,
      p_organization_id: activeOrg.orgId,
      p_patch: input,
    } as never,
  );

  if (updateErr) {
    if (updateErr.code === "P0002") {
      return fail("not_found", "Fonte de conhecimento não encontrada.", 404, { requestId });
    }
    if (updateErr.code === "22023") {
      return fail("unprocessable_entity", "O conjunto de itens da fonte é inválido.", 422, { requestId });
    }
    if (updateErr.code === "23505") {
      return fail("knowledge_source_name_in_use", "Já existe um material com este nome.", 409, { requestId });
    }
    console.error("[ai-knowledge-sources] PATCH atomic update failed:", updateErr.code ?? "unknown");
    return fail("internal_error", "Erro ao atualizar fonte.", 500, { requestId });
  }

  const changedFields = [
    ...(input.name !== undefined ? ["name"] : []),
    ...(input.source_metadata !== undefined ? ["source_metadata"] : []),
    ...(input.items !== undefined ? ["items"] : []),
  ];
  void audit({
    action: "ai.knowledge_source_updated",
    actorUserId: authUser.id,
    organizationId: activeOrg.orgId,
    resourceType: "ai_knowledge_source",
    resourceId: sourceId,
    requestId,
    metadata: {
      changed_fields: changedFields,
      ...(input.items !== undefined ? { faq_items_count: input.items.length } : {}),
    },
  });

  const itemsCount = (result as { items_count?: number } | null)?.items_count;
  return ok(
    { id: sourceId, ...(itemsCount !== undefined ? { items_count: itemsCount } : {}) },
    { requestId },
  );
}

// ---------------------------------------------------------------------------
// DELETE — soft-delete (status='archived')
// ---------------------------------------------------------------------------

export async function DELETE(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const supportDenied = await requireSupportWrite();
  if (supportDenied) return supportDenied;

  const requestId = randomUUID();
  const { id: sourceId } = await params;

  const ctx = await resolveContext(requestId);
  if (ctx.error) return ctx.error;
  const { activeOrg } = ctx as Exclude<typeof ctx, { error: Response }>;

  // Verify ownership with user-scoped client.
  const supabase = await createClient();
  const { data: existing, error: fetchErr } = await supabase
    .from("ai_knowledge_sources")
    .select("id")
    .eq("id", sourceId)
    .eq("organization_id", activeOrg.orgId)
    .maybeSingle();

  if (fetchErr) {
    console.error("[ai-knowledge-sources] DELETE fetch failed:", fetchErr.message);
    return fail("internal_error", "Erro ao verificar fonte.", 500, { requestId });
  }
  if (!existing) {
    return fail("not_found", "Fonte de conhecimento não encontrada.", 404, { requestId });
  }

  const admin = createAdminClient();
  // `is_active` JUNTO, e não só `status`.
  //
  // Nenhuma linha do repo jamais escreveu `is_active = false`. Enquanto existia
  // o índice único `(agent_id, source_type) WHERE is_active`, isso deixava o
  // "slot" ocupado por um material arquivado PARA SEMPRE: recriar devolvia 409 e
  // não havia caminho nenhum de volta. O índice saiu na 0181 e a incoerência
  // dos dois campos sairia junto — a constraint
  // `ai_knowledge_sources_arquivada_nao_e_ativa` agora recusa arquivar pela metade.
  const { error: archiveErr } = await admin
    .from("ai_knowledge_sources")
    .update({ status: "archived", is_active: false })
    .eq("id", sourceId)
    .eq("organization_id", activeOrg.orgId);

  if (archiveErr) {
    console.error("[ai-knowledge-sources] arquivar falhou:", archiveErr.message);
    return fail("internal_error", "Erro ao arquivar o material.", 500, { requestId });
  }

  return ok({ id: sourceId, status: "archived" }, { requestId });
}
