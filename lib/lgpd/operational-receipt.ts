import { createHash, createHmac } from "node:crypto";

import { audit } from "@/lib/audit";
import { env } from "@/lib/env";
import { logger } from "@/lib/logger";
import { createAdminClient } from "@/lib/supabase/admin";
import { mascararTitularDoPedido } from "@/lib/lgpd/mask";
import { normalizarIdioma } from "@/lib/i18n/idiomas";
import { tagDeIdioma } from "@/lib/i18n/datas";
import { valorDaInstalacao } from "@/lib/instalacao/config";

const BUCKET = "lgpd-exports";

export interface ReceiptContent {
  organization_name: string;
  organization_cnpj: string | null;
  dpo_email: string | null;
  timezone: string;
  locale: string;
  request_id: string;
  request_received_at: string;
  completed_at: string;
  request_scope: "contact" | "tenant";
  request_source: string;
  requester: ReturnType<typeof mascararTitularDoPedido>;
  execution_mode: "Execução automática pelo sistema" | "Execução automática após aprovação humana";
  execution_actor_user_id: string | null;
  execution_origin: "worker LGPD";
  result_counts: Array<{ category: string; count: number }>;
  media_queued: number;
}

export interface ReceiptIntegrity {
  algorithm: "HMAC-SHA-256" | "SHA-256";
  code_type: "autenticidade" | "integridade";
  code: string;
  content_sha256: string;
}

export type OperationalReceiptStatus = "ready" | "missing" | "error";

export function receiptObjectPath(organizationId: string, requestId: string): string {
  return `${organizationId}/receipts/${requestId}.pdf`;
}

export function receiptStatusFromResult(result: unknown): OperationalReceiptStatus {
  if (!result || typeof result !== "object" || Array.isArray(result)) return "missing";
  const receipt = (result as Record<string, unknown>)["receipt"];
  if (!receipt || typeof receipt !== "object" || Array.isArray(receipt)) return "missing";
  const status = (receipt as Record<string, unknown>)["status"];
  return status === "ready" ? "ready" : status === "error" ? "error" : "missing";
}

function object(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function countEntries(value: unknown): Array<{ category: string; count: number }> {
  const allowed = new Set([
    "contacts",
    "conversations",
    "messages",
    "crm_leads",
    "crm_lead_activities",
    "orders",
    "appointments",
    "agent_cases",
    "campaigns",
    "notes",
    "proposals",
  ]);
  return Object.entries(object(value))
    .filter(([category, count]) =>
      allowed.has(category) && typeof count === "number" && Number.isFinite(count) && count >= 0,
    )
    .map(([category, count]) => ({ category, count: Math.trunc(count as number) }))
    .sort((a, b) => a.category.localeCompare(b.category));
}

function safeText(value: string | null | undefined, fallback: string, maxLength: number): string {
  const normalized = value?.replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim();
  return normalized ? normalized.slice(0, maxLength) : fallback;
}

function sourceLabel(source: string): string {
  switch (source) {
    case "manual": return "Solicitação manual";
    case "admin_panel": return "Painel administrativo";
    case "support": return "Suporte";
    case "api": return "Integração por API";
    case "nuvemshop": return "Integração Nuvemshop";
    default: return "Origem não identificada";
  }
}

export function buildReceiptContent(input: {
  organization: { legal_name: string | null; cnpj: string | null; dpo_email: string | null; timezone: string | null; locale: string | null };
  request: {
    id: string;
    received_at: string;
    completed_at: string | null;
    scope: "contact" | "tenant";
    source: string;
    request_payload: Record<string, unknown> | null;
    result: Record<string, unknown> | null;
      execution_actor_user_id?: string | null;
  };
}): ReceiptContent {
  const result = object(input.request.result);
  const completedAt = input.request.completed_at ?? new Date().toISOString();
  const aggregate = object(result["aggregate_counts"]);
  const rawMediaQueued = result["media_queued"] ?? aggregate["media_queued"];
  const resultCounts = countEntries(result["cascaded_to"] ?? aggregate);
  const timezone = input.organization.timezone?.trim() || "UTC";
  const locale = tagDeIdioma(normalizarIdioma(input.organization.locale));
  const executionActorUserId = input.request.execution_actor_user_id ?? null;

  return {
    organization_name: safeText(input.organization.legal_name, "Não informado pelo controlador", 240),
    organization_cnpj: input.organization.cnpj
      ? safeText(input.organization.cnpj.replace(/[^\d./-]/g, ""), "", 24) || null
      : null,
    dpo_email: safeText(input.organization.dpo_email, "", 254) || null,
    timezone,
    locale,
    request_id: input.request.id,
    request_received_at: input.request.received_at,
    completed_at: completedAt,
    request_scope: input.request.scope,
    request_source: sourceLabel(input.request.source),
    requester: mascararTitularDoPedido(input.request.request_payload),
    execution_mode: executionActorUserId
      ? "Execução automática após aprovação humana"
      : "Execução automática pelo sistema",
    execution_actor_user_id: executionActorUserId,
    execution_origin: "worker LGPD",
    result_counts: resultCounts,
    media_queued: typeof rawMediaQueued === "number" && Number.isFinite(rawMediaQueued)
      ? Math.max(0, Math.trunc(rawMediaQueued))
      : 0,
  };
}

function canonicalJson(content: ReceiptContent): string {
  // Objeto e ordenação fixos: o código não depende de ordem incidental do banco.
  return JSON.stringify({
    organization_name: content.organization_name,
    organization_cnpj: content.organization_cnpj,
    dpo_email: content.dpo_email,
    timezone: content.timezone,
    locale: content.locale,
    request_id: content.request_id,
    request_received_at: content.request_received_at,
    completed_at: content.completed_at,
    request_scope: content.request_scope,
    request_source: content.request_source,
    requester: {
      documento_mascarado: content.requester.documento_mascarado,
      telefone_mascarado: content.requester.telefone_mascarado,
      email_mascarado: content.requester.email_mascarado,
      identificacao_nao_reimpressa: content.requester.identificacao_nao_reimpressa,
    },
    execution_mode: content.execution_mode,
    execution_actor_user_id: content.execution_actor_user_id,
    execution_origin: content.execution_origin,
    result_counts: content.result_counts,
    media_queued: content.media_queued,
  });
}

export function calculateReceiptIntegrity(
  content: ReceiptContent,
  configuredKey: string = env.LGPD_RECEIPT_HMAC_KEY,
): ReceiptIntegrity {
  const canonical = canonicalJson(content);
  const contentSha256 = createHash("sha256").update(canonical, "utf8").digest("hex");
  const key = configuredKey.trim();
  if (key && Buffer.byteLength(key, "utf8") >= 32) {
    const mac = createHmac("sha256", key).update(canonical, "utf8").digest("hex");
    return {
      algorithm: "HMAC-SHA-256",
      code_type: "autenticidade",
      code: mac.slice(0, 16).toUpperCase(),
      content_sha256: contentSha256,
    };
  }
  return {
    algorithm: "SHA-256",
    code_type: "integridade",
    code: contentSha256.slice(0, 16).toUpperCase(),
    content_sha256: contentSha256,
  };
}

function safeFailureCode(stage: string): string {
  switch (stage) {
    case "organization_read": return "controller_unavailable";
    case "pdf_render": return "receipt_render_failed";
    case "storage_upload": return "receipt_storage_failed";
    case "metadata_write": return "receipt_metadata_failed";
    default: return "receipt_generation_failed";
  }
}

export async function issueOperationalReceipt(input: {
  organizationId: string;
  request: {
    id: string;
    status: string;
    request_type: string;
    source: string;
    received_at: string;
    completed_at: string | null;
    scope: "contact" | "tenant";
    request_payload: Record<string, unknown> | null;
    result: Record<string, unknown> | null;
      execution_actor_user_id?: string | null;
  };
}): Promise<{ status: "ready" | "error"; error_code?: string }> {
  const current = input.request.result ?? {};
  if (input.request.status !== "completed") {
    return { status: "error", error_code: "request_not_completed" };
  }
  if (receiptStatusFromResult(current) === "ready") return { status: "ready" };

  let admin: ReturnType<typeof createAdminClient> | null = null;
  let stage = "organization_read";
  try {
    admin = createAdminClient();
    const { data: organization, error: organizationError } = await admin
      .from("organizations")
      .select("legal_name, cnpj, dpo_email, timezone, locale")
      .eq("id", input.organizationId)
      .maybeSingle();
    if (organizationError || !organization) throw new Error("organization_unavailable");

    let installDpoEmail: string | null = null;
    if (!organization.dpo_email?.trim()) {
      try {
        installDpoEmail = (await valorDaInstalacao("LGPD_DPO_EMAIL")).valor?.trim() || null;
      } catch {
        // O endereço de contato é opcional: a falha do fallback de instalação
        // não impede a emissão do recibo nem expõe dados da organização.
      }
    }

    const content = buildReceiptContent({
      organization: { ...organization, dpo_email: organization.dpo_email?.trim() || installDpoEmail },
      request: input.request,
    });
    const integrity = calculateReceiptIntegrity(content);

    stage = "pdf_render";
    const { renderOperationalReceiptPdf } = await import("@/lib/lgpd/receipt-renderer");
    const pdf = await renderOperationalReceiptPdf(content, integrity);
    const pdfSha256 = createHash("sha256").update(pdf).digest("hex");

    stage = "storage_upload";
    const { error: uploadError } = await admin.storage
      .from(BUCKET)
      .upload(receiptObjectPath(input.organizationId, input.request.id), pdf, {
        contentType: "application/pdf",
        cacheControl: "0",
        upsert: true,
      });
    if (uploadError) throw new Error("receipt_storage_failed");

    const metadata = {
      status: "ready",
      receipt_id: input.request.id,
      issued_at: input.request.completed_at ?? new Date().toISOString(),
      algorithm: integrity.algorithm,
      code_type: integrity.code_type,
      code: integrity.code,
      content_sha256: integrity.content_sha256,
      pdf_sha256: pdfSha256,
    };

    stage = "metadata_write";
    const { data: saved, error: saveError } = await admin
      .from("lgpd_requests")
      .update({ result: { ...current, receipt: metadata } })
      .eq("organization_id", input.organizationId)
      .eq("id", input.request.id)
      .eq("status", "completed")
      .select("id")
      .maybeSingle();
    if (saveError || !saved) throw new Error("receipt_metadata_failed");

    await audit({
      action: "lgpd.receipt_issued",
      organizationId: input.organizationId,
      resourceType: "lgpd_request",
      resourceId: input.request.id,
      metadata: {
        request_id: input.request.id,
        algorithm: integrity.algorithm,
        digest: pdfSha256,
        receipt_id: input.request.id,
        origin: "worker LGPD",
        result: "ready",
      },
      bypassedRls: true,
    });

    return { status: "ready" };
  } catch (error) {
    const errorCode = safeFailureCode(stage);
    const errorHash = createHash("sha256")
      .update(error instanceof Error ? error.message : String(error))
      .digest("hex");
    let stateUpdateFailed = true;
    if (admin) {
      try {
        const { error: stateError } = await admin
          .from("lgpd_requests")
          .update({
            result: { ...current, receipt: { status: "error", error_code: errorCode } },
          })
          .eq("organization_id", input.organizationId)
          .eq("id", input.request.id)
          .eq("status", "completed");
        stateUpdateFailed = Boolean(stateError);
      } catch {
        stateUpdateFailed = true;
      }
    }
    logger.warn("[lgpd-redact-worker] receipt issuance failed", {
      organization_id: input.organizationId,
      request_id: input.request.id.slice(0, 8),
      error_code: errorCode,
      error_hash: errorHash,
      state_update_failed: stateUpdateFailed,
    });
    return { status: "error", error_code: errorCode };
  }
}
