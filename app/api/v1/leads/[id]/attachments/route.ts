import { randomUUID } from "node:crypto";
import type { NextRequest } from "next/server";
import { z } from "zod";

import { audit } from "@/lib/audit";
import { fail, ok } from "@/lib/api/wrappers";
import { requireRole } from "@/lib/auth/require-role";
import { requireSupportWrite } from "@/lib/impersonate/support";
import { camposDoFunil } from "@/lib/leads/campos-do-funil";
import {
  LEAD_ATTACHMENT_MAX_BYTES,
  LEAD_ATTACHMENT_MAX_FILES,
  leadAttachmentStoragePath,
  validateLeadAttachment,
} from "@/lib/leads/attachment-validation";
import { logger } from "@/lib/logger";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

const fieldKeySchema = z.string().min(1).max(40).regex(/^[a-z][a-z0-9_]*$/i);
const MAX_REQUEST_BYTES = LEAD_ATTACHMENT_MAX_BYTES * LEAD_ATTACHMENT_MAX_FILES + 1024 * 1024;

type AttachmentMetadata = {
  id: string;
  safe_filename: string;
  mime_type: string;
  size_bytes: number;
  created_at: string;
};

interface RouteContext {
  params: Promise<{ id: string }>;
}

async function leadFieldAccess(supabase: Awaited<ReturnType<typeof createClient>>, leadId: string, orgId: string, key: string) {
  const { data: lead, error: leadError } = await supabase
    .from("crm_leads")
    .select("id, pipeline_id")
    .eq("id", leadId)
    .eq("organization_id", orgId)
    .maybeSingle();
  if (leadError) return { error: "internal" as const };
  if (!lead) return { error: "not_found" as const };

  const { data: pipeline, error: pipelineError } = await supabase
    .from("crm_pipelines")
    .select("settings")
    .eq("id", lead.pipeline_id)
    .eq("organization_id", orgId)
    .maybeSingle();
  if (pipelineError) return { error: "internal" as const };
  const field = camposDoFunil((pipeline?.settings ?? null) as Record<string, unknown> | null)
    .find((candidate) => candidate.key === key && candidate.type === "file");
  return field ? { error: null, field } : { error: "invalid_field" as const };
}

function publicMetadata(row: AttachmentMetadata, leadId: string) {
  return {
    id: row.id,
    filename: row.safe_filename,
    mime_type: row.mime_type,
    size_bytes: Number(row.size_bytes),
    created_at: row.created_at,
    media_url: `/api/v1/leads/${encodeURIComponent(leadId)}/attachments/${encodeURIComponent(row.id)}/media`,
  };
}

/** `NextRequest.formData()` pode materializar `File` em outro realm que o global do runner. */
function isUploadedFile(value: FormDataEntryValue): value is File {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<File>;
  return (
    typeof candidate.name === "string" &&
    typeof candidate.type === "string" &&
    typeof candidate.size === "number" &&
    typeof candidate.arrayBuffer === "function"
  );
}

async function lerFormDataLimitado(req: NextRequest): Promise<{ form: FormData | null; grande: boolean }> {
  const leitor = req.body?.getReader();
  if (!leitor) return { form: null, grande: false };
  const partes: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await leitor.read();
      if (done) break;
      total += value.byteLength;
      if (total > MAX_REQUEST_BYTES) {
        await leitor.cancel().catch(() => undefined);
        return { form: null, grande: true };
      }
      partes.push(value);
    }
    const bytes = Buffer.concat(partes.map((parte) => Buffer.from(parte)), total);
    const request = new Request(req.url, {
      method: "POST",
      headers: req.headers,
      body: bytes as BodyInit,
    });
    return { form: await request.formData(), grande: false };
  } catch {
    return { form: null, grande: false };
  }
}

export async function GET(req: NextRequest, ctx: RouteContext): Promise<Response> {
  const requestId = randomUUID();
  const authz = await requireRole("viewer", { requestId, resource: "crm_leads" });
  if (!authz.ok) return authz.response;
  const { id: leadId } = await ctx.params;
  if (!z.string().uuid().safeParse(leadId).success) {
    return fail("invalid_request", "Identificador do negócio inválido.", 400, { requestId });
  }
  const key = new URL(req.url).searchParams.get("custom_field_key");
  const parsedKey = fieldKeySchema.safeParse(key);
  if (!parsedKey.success) return fail("invalid_request", "Campo de arquivo inválido.", 400, { requestId });

  const supabase = await createClient();
  const acesso = await leadFieldAccess(supabase, leadId, authz.org.orgId, parsedKey.data);
  if (acesso.error === "not_found") return fail("not_found", "Negócio não encontrado.", 404, { requestId });
  if (acesso.error === "invalid_field") return fail("not_found", "Campo de arquivo não encontrado.", 404, { requestId });
  if (acesso.error) return fail("internal_error", "Não foi possível consultar os anexos.", 500, { requestId });

  const { data, error } = await supabase
    .from("crm_lead_attachments")
    .select("id, safe_filename, mime_type, size_bytes, created_at")
    .eq("organization_id", authz.org.orgId)
    .eq("lead_id", leadId)
    .eq("custom_field_key", parsedKey.data)
    .order("created_at", { ascending: true });
  if (error) return fail("internal_error", "Não foi possível consultar os anexos.", 500, { requestId });

  const attachments = ((data ?? []) as unknown as AttachmentMetadata[]).map((row) => publicMetadata(row, leadId));
  return ok({ attachments }, { requestId });
}

export async function POST(req: NextRequest, ctx: RouteContext): Promise<Response> {
  const supportDenied = await requireSupportWrite();
  if (supportDenied) return supportDenied;

  const requestId = randomUUID();
  const authz = await requireRole("agent", { requestId, resource: "crm_leads" });
  if (!authz.ok) return authz.response;
  const { id: leadId } = await ctx.params;
  if (!z.string().uuid().safeParse(leadId).success) {
    return fail("invalid_request", "Identificador do negócio inválido.", 400, { requestId });
  }
  const declaredLength = Number(req.headers.get("content-length") ?? 0);
  if (declaredLength > MAX_REQUEST_BYTES) {
    await req.body?.cancel().catch(() => undefined);
    return fail("payload_too_large", "O envio excede o limite total permitido.", 413, { requestId });
  }

  const { form, grande } = await lerFormDataLimitado(req);
  if (grande) return fail("payload_too_large", "O envio excede o limite total permitido.", 413, { requestId });
  const parsedKey = fieldKeySchema.safeParse(form?.get("custom_field_key"));
  const rawFiles = form?.getAll("files") ?? [];
  const files = rawFiles.filter((entry): entry is File => isUploadedFile(entry) && entry.size > 0);
  if (!parsedKey.success || files.length === 0 || files.length !== rawFiles.length) {
    return fail("invalid_request", "Informe um campo file e ao menos um arquivo válido.", 400, { requestId });
  }
  if (files.length > LEAD_ATTACHMENT_MAX_FILES || files.some((file) => file.size > LEAD_ATTACHMENT_MAX_BYTES)) {
    return fail("payload_too_large", "Cada arquivo pode ter até 5 MB; o campo aceita até 10 arquivos.", 413, { requestId });
  }

  const supabase = await createClient();
  const acesso = await leadFieldAccess(supabase, leadId, authz.org.orgId, parsedKey.data);
  if (acesso.error === "not_found") return fail("not_found", "Negócio não encontrado.", 404, { requestId });
  if (acesso.error === "invalid_field") return fail("invalid_request", "O campo escolhido não aceita arquivos.", 422, { requestId });
  if (acesso.error) return fail("internal_error", "Não foi possível validar o negócio.", 500, { requestId });
  if (!acesso.field.multiple && files.length > 1) {
    return fail("validation_failed", "Este campo aceita apenas um arquivo.", 422, { requestId });
  }

  const { data: existing, error: existingError } = await supabase
    .from("crm_lead_attachments")
    .select("id")
    .eq("organization_id", authz.org.orgId)
    .eq("lead_id", leadId)
    .eq("custom_field_key", parsedKey.data);
  if (existingError) return fail("internal_error", "Não foi possível consultar os anexos existentes.", 500, { requestId });
  const count = (existing as unknown[] | null)?.length ?? 0;
  if ((!acesso.field.multiple && count > 0) || count + files.length > LEAD_ATTACHMENT_MAX_FILES) {
    return fail("validation_failed", "O limite deste campo foi atingido.", 422, { requestId });
  }

  const validated = [] as Array<{
    id: string;
    path: string;
    mimeType: string;
    filename: string;
    bytes: Uint8Array;
  }>;
  for (const file of files) {
    const bytes = new Uint8Array(await file.arrayBuffer());
    const result = validateLeadAttachment({ name: file.name, type: file.type, size: file.size, bytes });
    if (!result.ok) {
      const status = result.code === "payload_too_large" ? 413 : result.code === "unsupported_media_type" ? 415 : 422;
      return fail(result.code, "O arquivo precisa ser PDF, PNG, JPEG ou WebP válido e ter até 5 MB.", status, { requestId });
    }
    const id = randomUUID();
    validated.push({
      id,
      path: leadAttachmentStoragePath(authz.org.orgId, leadId, id, result.extension),
      mimeType: result.mimeType,
      filename: result.filename,
      bytes: result.bytes,
    });
  }

  const admin = createAdminClient();
  const storedPaths: string[] = [];
  const insertedIds: string[] = [];
  const rows: AttachmentMetadata[] = [];
  const cleanup = async () => {
    if (insertedIds.length > 0) {
      await admin
        .from("crm_lead_attachments")
        .delete()
        .eq("organization_id", authz.org.orgId)
        .eq("lead_id", leadId)
        .in("id", insertedIds);
    }
    if (storedPaths.length > 0) {
      const { error } = await admin.storage.from("internal-media").remove(storedPaths);
      if (error) {
        logger.error("[lead-attachments] rollback de upload falhou", { request_id: requestId, count: storedPaths.length });
        await admin.from("storage_redaction_queue").upsert(
          storedPaths.map((objectPath) => ({ organization_id: authz.org.orgId, bucket: "internal-media", object_path: objectPath })),
          { onConflict: "bucket,object_path", ignoreDuplicates: true },
        );
      }
    }
  };

  for (const item of validated) {
    const { error: uploadError } = await admin.storage
      .from("internal-media")
      .upload(item.path, Buffer.from(item.bytes), { contentType: item.mimeType, upsert: false });
    if (uploadError) {
      await cleanup();
      logger.error("[lead-attachments] upload privado falhou", { request_id: requestId, detail: uploadError.message });
      return fail("internal_error", "Não foi possível guardar o arquivo.", 500, { requestId });
    }
    storedPaths.push(item.path);

    const { data, error: insertError } = await admin
      .from("crm_lead_attachments")
      .insert({
        id: item.id,
        organization_id: authz.org.orgId,
        lead_id: leadId,
        custom_field_key: parsedKey.data,
        storage_bucket: "internal-media",
        storage_path: item.path,
        original_filename: item.filename,
        safe_filename: item.filename,
        mime_type: item.mimeType,
        size_bytes: item.bytes.length,
        created_by: authz.user.id,
      })
      .select("id, safe_filename, mime_type, size_bytes, created_at")
      .maybeSingle();
    if (insertError || !data) {
      await cleanup();
      logger.error("[lead-attachments] metadata do arquivo não foi gravada", {
        request_id: requestId,
        code: insertError?.code ?? "empty_result",
        detail: insertError?.message ?? "empty_result",
      });
      return fail("internal_error", "Não foi possível registrar o anexo.", 500, { requestId });
    }
    insertedIds.push(item.id);
    rows.push(data as unknown as AttachmentMetadata);
  }

  for (const row of rows) {
    void audit({
      action: "lead.attachment_uploaded",
      actorUserId: authz.user.id,
      organizationId: authz.org.orgId,
      resourceType: "crm_lead_attachments",
      resourceId: row.id,
      requestId,
      metadata: {
        lead_id: leadId,
        custom_field_key: parsedKey.data,
        mime_type: row.mime_type,
        size_bytes: Number(row.size_bytes),
      },
    });
  }

  return ok({ attachments: rows.map((row) => publicMetadata(row, leadId)) }, { requestId, status: 201 });
}
