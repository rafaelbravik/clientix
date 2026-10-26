import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { NextRequest } from "next/server";

import { audit } from "@/lib/audit";
import { fail, ok } from "@/lib/api/wrappers";
import { mfaEmDivida } from "@/lib/auth/server";
import { requireRole } from "@/lib/auth/require-role";
import { CHANNEL_SESSION_REF_COLUMNS, resolveSessionRef, type ChannelSessionRef } from "@/lib/channels";
import { requireSupportWrite } from "@/lib/impersonate/support";
import { calcularPreviaHistorico } from "@/lib/channels/historico/previa";
import { getHistoryProvider } from "@/lib/channels/historico/provider";
import { createAdminClient } from "@/lib/supabase/admin";

export const dynamic = "force-dynamic";

const paramsSchema = z.object({ id: z.string().uuid() });
const rangeDaysSchema = z.union([z.literal(30), z.literal(90), z.literal(180), z.literal(365)]);
const bodySchema = z.object({ range_days: rangeDaysSchema, preview_confirmed: z.literal(true) });

type SessionRow = {
  id: string;
  organization_id: string;
  status: string;
  archived_at: string | null;
} & ChannelSessionRef;

interface ImportRow {
  id: string;
  status: string;
  range_days: number;
  range_start: string;
  imported_count: number;
  skipped_count: number;
  failed_count: number;
  last_error_code: string | null;
  started_at: string | null;
  finished_at: string | null;
  updated_at: string;
}

function publicJob(row: ImportRow | null) {
  if (!row) return null;
  return {
    id: row.id,
    status: row.status,
    range_days: row.range_days,
    range_start: row.range_start,
    imported_count: row.imported_count,
    skipped_count: row.skipped_count,
    failed_count: row.failed_count,
    last_error_code: row.last_error_code,
    started_at: row.started_at,
    finished_at: row.finished_at,
    updated_at: row.updated_at,
  };
}

async function sessionForOrg(id: string, organizationId: string) {
  const admin = createAdminClient();
  const { data, error } = await admin.from("channel_sessions")
    .select(`id, organization_id, status, archived_at, ${CHANNEL_SESSION_REF_COLUMNS}`)
    .eq("id", id).eq("organization_id", organizationId).maybeSingle();
  if (error || !data) return { session: null, error: true as const };
  return { session: data as SessionRow, error: false as const };
}

async function stateForSession(session: SessionRow, organizationId: string) {
  const provider = getHistoryProvider(session.provider);
  if (!provider || session.archived_at) {
    return { supported: false, reason: "session_incompatible" };
  }
  if (session.status !== "WORKING") return { supported: false, reason: "session_not_working" };
  try {
    const sessionRef = resolveSessionRef(session);
    const snapshot = await provider.getVerifiedSession(sessionRef);
    if (!snapshot || snapshot.status !== "WORKING") return { supported: false, reason: "session_not_working" };
    if (!provider.isHistoryStoreEnabled(snapshot)) return { supported: false, reason: "store_not_enabled" };
    const admin = createAdminClient();
    const { data: block, error } = await admin.rpc("fn_whatsapp_history_check_suppression" as never, {
      p_org: organizationId,
      p_identities: [],
    } as never);
    if (error) return { supported: false, reason: "privacy_guard_unavailable" };
    if (block !== "allowed") return { supported: false, reason: "privacy_guard_blocked" };
    return { supported: true, reason: null };
  } catch {
    return { supported: false, reason: "history_transport_unavailable" };
  }
}

export async function GET(req: NextRequest, context: { params: Promise<{ id: string }> }): Promise<Response> {
  const requestId = randomUUID();
  const parsed = paramsSchema.safeParse(await context.params);
  if (!parsed.success) return fail("validation_failed", "Identificador de conexão inválido.", 422, { requestId });
  const authz = await requireRole("manager", { requestId, resource: "channel_sessions" });
  if (!authz.ok) return authz.response;
  const { session, error: lookupError } = await sessionForOrg(parsed.data.id, authz.org.orgId);
  if (lookupError || !session) return fail("not_found", "Conexão não encontrada.", 404, { requestId });
  const state = await stateForSession(session, authz.org.orgId);
  const { data: row, error } = await createAdminClient().from("whatsapp_history_imports" as never)
    .select("id,status,range_days,range_start,imported_count,skipped_count,failed_count,last_error_code,started_at,finished_at,updated_at" as never)
    .eq("organization_id" as never, authz.org.orgId)
    .eq("channel_session_id" as never, session.id)
    .order("updated_at" as never, { ascending: false })
    .limit(1 as never)
    .maybeSingle();
  if (error) return fail("internal_error", "Não foi possível consultar a importação.", 500, { requestId });
  const previewParam = new URL(req.url).searchParams.get("preview_days");
  if (previewParam !== null) {
    const previewDays = rangeDaysSchema.safeParse(Number(previewParam));
    if (!previewDays.success) return fail("validation_failed", "Escolha um período de 30, 90, 180 ou 365 dias.", 422, { requestId });
    const job = row as ImportRow | null;
    if (job?.status === "pending" || job?.status === "running") {
      return fail("conflict", "Já existe uma importação em andamento para esta conexão.", 409, { requestId });
    }
    if (!state.supported) {
      return ok({ history_supported: false, reason_code: state.reason, import: publicJob(job), preview: null }, { requestId });
    }
    const provider = getHistoryProvider(session.provider);
    if (!provider) return fail("unavailable", "Esta conexão não está pronta para pré-visualizar o histórico.", 409, { requestId });
    try {
      const preview = await calcularPreviaHistorico(provider, resolveSessionRef(session), previewDays.data);
      void audit({
        action: "channel.history_import_previewed",
        actorUserId: authz.user.id,
        organizationId: authz.org.orgId,
        resourceType: "channel_session",
        resourceId: session.id,
        requestId,
        metadata: { range_days: previewDays.data, conversations: preview.conversations, messages: preview.messages, partial: preview.partial },
      });
      return ok({ history_supported: true, reason_code: null, import: publicJob(job), preview }, { requestId });
    } catch {
      return fail("unavailable", "O canal não conseguiu calcular a prévia do histórico.", 503, { requestId });
    }
  }
  return ok({
    history_supported: state.supported,
    reason_code: state.reason,
    import: publicJob((row as unknown as ImportRow | null) ?? null),
  }, { requestId });
}

export async function POST(req: NextRequest, context: { params: Promise<{ id: string }> }): Promise<Response> {
  const supportDenied = await requireSupportWrite();
  if (supportDenied) return supportDenied;
  const requestId = randomUUID();
  const parsedParams = paramsSchema.safeParse(await context.params);
  if (!parsedParams.success) return fail("validation_failed", "Identificador de conexão inválido.", 422, { requestId });
  const authz = await requireRole("manager", { requestId, resource: "channel_sessions" });
  if (!authz.ok) return authz.response;
  if (await mfaEmDivida()) return fail("mfa_required", "Confirme a verificação em duas etapas.", 403, { requestId });
  let raw: unknown;
  try { raw = await req.json(); } catch { return fail("invalid_request", "Body JSON inválido.", 400, { requestId }); }
  const body = bodySchema.safeParse(raw);
  if (!body.success) return fail("validation_failed", "Escolha um período de 30, 90, 180 ou 365 dias.", 422, { requestId });

  const { session, error: lookupError } = await sessionForOrg(parsedParams.data.id, authz.org.orgId);
  if (lookupError || !session) return fail("not_found", "Conexão não encontrada.", 404, { requestId });
  const state = await stateForSession(session, authz.org.orgId);
  if (!state.supported) return fail("unavailable", "Esta conexão não está pronta para importar o histórico.", 409, { requestId, details: { reason_code: state.reason } });

  const admin = createAdminClient();
  const jobs = admin.from("whatsapp_history_imports" as never);
  const { data: active, error: activeError } = await jobs.select("id,status,range_days,range_start,imported_count,skipped_count,failed_count,last_error_code,started_at,finished_at,updated_at" as never)
    .eq("organization_id" as never, authz.org.orgId)
    .eq("channel_session_id" as never, session.id)
    .in("status" as never, ["pending", "running"])
    .maybeSingle();
  if (activeError) return fail("internal_error", "Não foi possível iniciar a importação.", 500, { requestId });
  if (active) return ok({ import: publicJob(active as unknown as ImportRow), replay: true }, { requestId });

  const rangeStart = new Date(Date.now() - body.data.range_days * 24 * 60 * 60_000).toISOString();
  const { data: created, error: createError } = await jobs.insert({
    organization_id: authz.org.orgId,
    channel_session_id: session.id,
    status: "pending",
    range_days: body.data.range_days,
    range_start: rangeStart,
    cursor: { chat_offset: 0 },
    created_by: authz.user.id,
  } as never).select("id,status,range_days,range_start,imported_count,skipped_count,failed_count,last_error_code,started_at,finished_at,updated_at" as never).single();
  if (createError) {
    if (createError.code === "23505") return fail("conflict", "Já existe uma importação em andamento.", 409, { requestId });
    return fail("internal_error", "Não foi possível iniciar a importação.", 500, { requestId });
  }
  const job = created as unknown as ImportRow;
  void audit({
    action: "channel.history_import_started",
    actorUserId: authz.user.id,
    organizationId: authz.org.orgId,
    resourceType: "whatsapp_history_import",
    resourceId: job.id,
    requestId,
    metadata: { channel_session_id: session.id, range_days: body.data.range_days },
  });
  return ok({ import: publicJob(job), replay: false }, { requestId, status: 201 });
}
