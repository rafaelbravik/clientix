import { randomUUID } from "node:crypto";
import type { NextRequest } from "next/server";
import { z } from "zod";

import { fail } from "@/lib/api/wrappers";
import { requireRole } from "@/lib/auth/require-role";
import { receiptObjectPath, receiptStatusFromResult } from "@/lib/lgpd/operational-receipt";
import { createAdminClient } from "@/lib/supabase/admin";

export const dynamic = "force-dynamic";

const paramsSchema = z.object({ id: z.string().uuid() });

/** Baixa recibo somente após revalidar sessão, organização, status e objeto privado. */
export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const requestId = randomUUID();
  const parsed = paramsSchema.safeParse(await params);
  if (!parsed.success) {
    return fail("validation_failed", "Identificador de solicitação inválido.", 422, { requestId });
  }

  const authz = await requireRole("admin", {
    requestId,
    resource: "lgpd_requests",
    allowPlatformAdmin: "leitura",
    permiteOrgSuspensa: true,
  });
  if (!authz.ok) return authz.response;

  const organizationId = authz.org.orgId;
  const admin = createAdminClient();
  const { data: request, error } = await admin
    .from("lgpd_requests")
    .select("id, organization_id, request_type, status, result")
    .eq("organization_id", organizationId)
    .eq("id", parsed.data.id)
    .maybeSingle();

  if (error) return fail("internal_error", "Não foi possível consultar o recibo.", 500, { requestId });
  if (!request) return fail("not_found", "Recibo não encontrado.", 404, { requestId });
  if (
    request.status !== "completed" ||
    (request.request_type !== "redact" && request.request_type !== "store_redact")
  ) {
    return fail("not_found", "Recibo não encontrado.", 404, { requestId });
  }

  const receiptStatus = receiptStatusFromResult(request.result);
  if (receiptStatus !== "ready") {
    return fail(
      receiptStatus === "error" ? "upstream_unavailable" : "not_found",
      receiptStatus === "error" ? "O recibo não está disponível no momento." : "Recibo ainda não disponível.",
      receiptStatus === "error" ? 503 : 404,
      { requestId },
    );
  }

  // O caminho é derivado de IDs já filtrados pelo tenant; nenhum path do banco
  // nem URL portadora é devolvido ao cliente.
  const { data: file, error: downloadError } = await admin.storage
    .from("lgpd-exports")
    .download(receiptObjectPath(organizationId, request.id));
  if (downloadError || !file) {
    return fail("not_found", "Recibo não encontrado.", 404, { requestId });
  }

  const bytes = await file.arrayBuffer();
  return new Response(bytes, {
    status: 200,
    headers: {
      "Content-Type": "application/pdf",
      "Content-Disposition": `attachment; filename="recibo-operacional-${request.id.slice(0, 8)}.pdf"`,
      "Content-Length": String(bytes.byteLength),
      "Cache-Control": "private, no-store, max-age=0",
      "X-Content-Type-Options": "nosniff",
      "X-Request-Id": requestId,
    },
  });
}
