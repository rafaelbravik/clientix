import { randomUUID } from "node:crypto";
import { type NextRequest, NextResponse } from "next/server";
import { z } from "zod";

import { fail, ok } from "@/lib/api/wrappers";
import { audit } from "@/lib/audit";
import { requireRole } from "@/lib/auth/require-role";
import { requireSupportWrite } from "@/lib/impersonate/support";
import { createAdminClient } from "@/lib/supabase/admin";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const ruleSchema = z.object({
  id: z.string().uuid().optional(),
  channel_session_id: z.string().uuid(),
  name: z.string().trim().min(2).max(100),
  active: z.boolean().default(true),
  post_id: z.string().trim().max(100).nullable().optional(),
  keyword_mode: z.enum(["any", "contains", "exact"]).default("any"),
  keywords: z.array(z.string().trim()).default([]),
  reply_comment: z.string().trim().max(1000).nullable().optional(),
  dm_message: z.string().trim().min(1).max(2000),
  agent_id: z.string().uuid().nullable().optional(),
});

export async function GET(req: NextRequest): Promise<NextResponse> {
  const requestId = randomUUID();
  const authz = await requireRole("agent", { requestId, resource: "instagram_comment_rules" });
  if (!authz.ok) return authz.response;

  const admin = createAdminClient();
  const { data: rules, error } = await admin
    .from("instagram_comment_rules")
    .select("*")
    .eq("organization_id", authz.org.orgId)
    .order("created_at", { ascending: false });

  if (error) {
    return fail("internal_error", "Erro ao listar regras de comentário.", 500, { requestId });
  }

  return ok({ rules: rules || [] }, { requestId });
}

export async function POST(req: NextRequest): Promise<NextResponse> {
  const supportDenied = await requireSupportWrite();
  if (supportDenied) return supportDenied;

  const requestId = randomUUID();
  const authz = await requireRole("admin", { requestId, resource: "instagram_comment_rules" });
  if (!authz.ok) return authz.response;

  const json = await req.json().catch(() => ({}));
  const parsed = ruleSchema.safeParse(json);
  if (!parsed.success) {
    return fail("validation_failed", "Dados da regra de comentário inválidos.", 422, {
      requestId,
      details: parsed.error.flatten(),
    });
  }

  const {
    id,
    channel_session_id,
    name,
    active,
    post_id,
    keyword_mode,
    keywords,
    reply_comment,
    dm_message,
    agent_id,
  } = parsed.data;

  const admin = createAdminClient();

  // Valida se a sessão pertence à organização
  const { data: session } = await admin
    .from("channel_sessions")
    .select("id")
    .eq("id", channel_session_id)
    .eq("organization_id", authz.org.orgId)
    .is("archived_at", null)
    .maybeSingle();

  if (!session) {
    return fail("not_found", "Sessão do Instagram não encontrada para esta organização.", 404, {
      requestId,
    });
  }

  if (id) {
    // Atualização
    const { data: updated, error } = await admin
      .from("instagram_comment_rules")
      .update({
        name,
        active,
        post_id: post_id || null,
        keyword_mode,
        keywords,
        reply_comment: reply_comment || null,
        dm_message,
        agent_id: agent_id || null,
        updated_at: new Date().toISOString(),
      })
      .eq("id", id)
      .eq("organization_id", authz.org.orgId)
      .select("*")
      .single();

    if (error || !updated) {
      return fail("internal_error", "Falha ao atualizar regra de comentário.", 500, { requestId });
    }

    await audit({
      organizationId: authz.org.orgId,
      actorUserId: authz.user.id,
      action: "automation.rule_updated",
      resourceType: "automation_rule",
      resourceId: updated.id,
      requestId,
    });

    return ok({ rule: updated }, { requestId });
  }

  // Criação
  const { data: created, error } = await admin
    .from("instagram_comment_rules")
    .insert({
      organization_id: authz.org.orgId,
      channel_session_id,
      name,
      active,
      post_id: post_id || null,
      keyword_mode,
      keywords,
      reply_comment: reply_comment || null,
      dm_message,
      agent_id: agent_id || null,
    })
    .select("*")
    .single();

  if (error || !created) {
    return fail("internal_error", "Falha ao criar regra de comentário.", 500, { requestId });
  }

  await audit({
    organizationId: authz.org.orgId,
    actorUserId: authz.user.id,
    action: "automation.rule_created",
    resourceType: "automation_rule",
    resourceId: created.id,
    requestId,
  });

  return ok({ rule: created }, { requestId });
}

export async function DELETE(req: NextRequest): Promise<NextResponse> {
  const supportDenied = await requireSupportWrite();
  if (supportDenied) return supportDenied;

  const requestId = randomUUID();
  const authz = await requireRole("admin", { requestId, resource: "instagram_comment_rules" });
  if (!authz.ok) return authz.response;

  const { searchParams } = new URL(req.url);
  const ruleId = searchParams.get("id");

  if (!ruleId) {
    return fail("validation_failed", "ID da regra não fornecido.", 422, { requestId });
  }

  const admin = createAdminClient();
  const { error } = await admin
    .from("instagram_comment_rules")
    .delete()
    .eq("id", ruleId)
    .eq("organization_id", authz.org.orgId);

  if (error) {
    return fail("internal_error", "Falha ao remover regra.", 500, { requestId });
  }

  await audit({
    organizationId: authz.org.orgId,
    actorUserId: authz.user.id,
    action: "automation.rule_deleted",
    resourceType: "automation_rule",
    resourceId: ruleId,
    requestId,
  });

  return ok({ deleted: true }, { requestId });
}
