import { randomUUID } from "node:crypto";
import type { NextRequest } from "next/server";
import { z } from "zod";

import { audit } from "@/lib/audit";
import { fail, ok } from "@/lib/api/wrappers";
import { requireRole } from "@/lib/auth/require-role";
import { requireSupportWrite } from "@/lib/impersonate/support";
import { createClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

interface RouteContext {
  params: Promise<{ id: string; attachmentId: string }>;
}

export async function DELETE(_req: NextRequest, ctx: RouteContext): Promise<Response> {
  const supportDenied = await requireSupportWrite();
  if (supportDenied) return supportDenied;

  const requestId = randomUUID();
  const authz = await requireRole("agent", { requestId, resource: "crm_leads" });
  if (!authz.ok) return authz.response;
  const { id: leadId, attachmentId } = await ctx.params;
  if (!z.string().uuid().safeParse(leadId).success || !z.string().uuid().safeParse(attachmentId).success) {
    return fail("invalid_request", "Identificador do anexo inválido.", 400, { requestId });
  }
  const supabase = await createClient();
  const { data: attachment, error: readError } = await supabase
    .from("crm_lead_attachments")
    .select("id, custom_field_key, mime_type, size_bytes")
    .eq("organization_id", authz.org.orgId)
    .eq("lead_id", leadId)
    .eq("id", attachmentId)
    .maybeSingle();
  if (readError) return fail("internal_error", "Não foi possível localizar o anexo.", 500, { requestId });
  if (!attachment) return fail("not_found", "Anexo não encontrado.", 404, { requestId });

  const { data: deleted, error } = await supabase.rpc("fn_delete_crm_lead_attachment" as never, {
    p_organization_id: authz.org.orgId,
    p_lead_id: leadId,
    p_attachment_id: attachmentId,
  } as never);
  if (error) {
    if (error.code === "42501") return fail("forbidden", "Você não pode remover este anexo.", 403, { requestId });
    if (error.code === "23514" && error.message.includes("required_file_attachment_missing")) {
      return fail("validation_failed", "Este anexo é obrigatório na etapa atual. Mova o negócio para outra etapa antes de removê-lo.", 422, { requestId });
    }
    return fail("internal_error", "Não foi possível remover o anexo.", 500, { requestId });
  }
  if (deleted !== true) return fail("not_found", "Anexo não encontrado.", 404, { requestId });

  void audit({
    action: "lead.attachment_deleted",
    actorUserId: authz.user.id,
    organizationId: authz.org.orgId,
    resourceType: "crm_lead_attachments",
    resourceId: attachmentId,
    requestId,
    metadata: {
      lead_id: leadId,
      custom_field_key: (attachment as { custom_field_key?: string }).custom_field_key,
      mime_type: (attachment as { mime_type?: string }).mime_type,
      size_bytes: Number((attachment as { size_bytes?: number }).size_bytes ?? 0),
    },
  });
  return ok({ deleted: true }, { requestId });
}
