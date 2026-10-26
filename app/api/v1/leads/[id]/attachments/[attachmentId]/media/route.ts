import { randomUUID } from "node:crypto";
import type { NextRequest } from "next/server";
import { z } from "zod";

import { requireRole } from "@/lib/auth/require-role";
import { isLeadAttachmentPathOwnedBy } from "@/lib/leads/attachment-validation";
import { logger } from "@/lib/logger";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

interface RouteContext {
  params: Promise<{ id: string; attachmentId: string }>;
}

const MIME_PERMITIDOS = new Set(["application/pdf", "image/png", "image/jpeg", "image/webp"]);

function disposition(filename: string, inline: boolean): string {
  const fallback = filename.replace(/[^A-Za-z0-9._-]/g, "_").replace(/^[.]+/, "") || "anexo";
  const encoded = encodeURIComponent(filename).replace(/[!'()*]/g, (char) =>
    `%${char.charCodeAt(0).toString(16).toUpperCase()}`,
  );
  return `${inline ? "inline" : "attachment"}; filename="${fallback}"; filename*=UTF-8''${encoded}`;
}

export async function GET(req: NextRequest, ctx: RouteContext): Promise<Response> {
  const requestId = randomUUID();
  const authz = await requireRole("viewer", { requestId, resource: "crm_leads" });
  if (!authz.ok) return authz.response;
  const { id: leadId, attachmentId } = await ctx.params;
  if (!z.string().uuid().safeParse(leadId).success || !z.string().uuid().safeParse(attachmentId).success) {
    return new Response(null, { status: 404, headers: { "Cache-Control": "private, no-store" } });
  }
  const supabase = await createClient();

  const { data: lead, error: leadError } = await supabase
    .from("crm_leads")
    .select("id")
    .eq("id", leadId)
    .eq("organization_id", authz.org.orgId)
    .maybeSingle();
  if (leadError || !lead) return new Response(null, { status: 404, headers: { "Cache-Control": "private, no-store" } });

  const { data: visible, error: visibleError } = await supabase
    .from("crm_lead_attachments")
    .select("id, safe_filename, mime_type")
    .eq("organization_id", authz.org.orgId)
    .eq("lead_id", leadId)
    .eq("id", attachmentId)
    .maybeSingle();
  if (visibleError || !visible) return new Response(null, { status: 404, headers: { "Cache-Control": "private, no-store" } });
  const meta = visible as unknown as { id: string; safe_filename: string; mime_type: string };

  // Service role lê apenas o path interno depois que a sessão provou acesso à
  // linha. Todos os filtros de posse são repetidos porque ele ignora RLS.
  const admin = createAdminClient();
  const { data: internal, error: internalError } = await admin
    .from("crm_lead_attachments")
    .select("storage_bucket, storage_path")
    .eq("organization_id", authz.org.orgId)
    .eq("lead_id", leadId)
    .eq("id", attachmentId)
    .maybeSingle();
  if (internalError || !internal) return new Response(null, { status: 404, headers: { "Cache-Control": "private, no-store" } });
  const storage = internal as unknown as { storage_bucket: string; storage_path: string };
  if (
    storage.storage_bucket !== "internal-media" ||
    !isLeadAttachmentPathOwnedBy(storage.storage_path, authz.org.orgId, leadId, attachmentId) ||
    !MIME_PERMITIDOS.has(meta.mime_type)
  ) {
    logger.error("[lead-attachments] metadata fora da fronteira esperada", { request_id: requestId });
    return new Response(null, { status: 404, headers: { "Cache-Control": "private, no-store" } });
  }

  const { data: blob, error: downloadError } = await admin.storage
    .from("internal-media")
    .download(storage.storage_path);
  if (downloadError || !blob) {
    logger.warn("[lead-attachments] objeto privado indisponível", { request_id: requestId });
    return new Response(null, { status: 404, headers: { "Cache-Control": "private, no-store" } });
  }

  const bytes = new Uint8Array(await blob.arrayBuffer());
  const wantsInline = new URL(req.url).searchParams.get("inline") === "1";
  const canInline = wantsInline && MIME_PERMITIDOS.has(meta.mime_type);
  const headers = new Headers({
    "Content-Type": meta.mime_type,
    "Content-Length": String(bytes.byteLength),
    "Content-Disposition": disposition(meta.safe_filename, canInline),
    "Cache-Control": "private, no-store",
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "SAMEORIGIN",
    "Referrer-Policy": "no-referrer",
  });
  if (canInline) headers.set("Content-Security-Policy", "default-src 'none'; sandbox; frame-ancestors 'self'");
  return new Response(bytes, { status: 200, headers });
}
