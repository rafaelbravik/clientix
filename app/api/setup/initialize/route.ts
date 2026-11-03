import { randomUUID } from "node:crypto";
import { z } from "zod";
import { fail, ok } from "@/lib/api/wrappers";
import { env } from "@/lib/env";
import { bootstrapTokenMatches, isSameOrigin, setupRateLimitSubjectHash } from "@/lib/platform/bootstrap-security";
import { createAdminClient } from "@/lib/supabase/admin";
import { resetPasswordSchema } from "@/lib/auth/schemas";

export const dynamic = "force-dynamic";
const headers = { "Cache-Control": "no-store" };

const inputSchema = z
  .object({
    bootstrap_token: z.string().min(1).max(512),
    full_name: z.string().trim().min(2).max(120),
    email: z.string().trim().email().max(254),
    phone: z.string().trim().max(32).optional().transform((value) => value || undefined),
    password: resetPasswordSchema.shape.password.max(256),
    password_confirmation: z.string().min(1).max(256),
    platform_name: z.string().trim().min(1).max(80),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.password !== value.password_confirmation) {
      ctx.addIssue({ code: "custom", path: ["password_confirmation"], message: "As senhas não coincidem." });
    }
  });

function clientAddress(request: Request): string | null {
  const realIp = request.headers.get("x-real-ip")?.trim();
  if (realIp) return realIp;
  // Reverse proxies append the address they observed. Taking the last entry
  // prevents a caller-supplied first X-Forwarded-For value from rotating the
  // per-source bucket on each attempt.
  const forwarded = request.headers.get("x-forwarded-for")?.split(",").at(-1)?.trim();
  return forwarded || null;
}

async function readBoundedJson(request: Request): Promise<{ ok: true; value: unknown } | { ok: false }> {
  if (!request.body) return { ok: false };
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > 16_384) {
        await reader.cancel();
        return { ok: false };
      }
      chunks.push(value);
    }
    const bytes = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return { ok: true, value: JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as unknown };
  } catch {
    return { ok: false };
  } finally {
    reader.releaseLock();
  }
}

async function initialized(admin: ReturnType<typeof createAdminClient>): Promise<boolean | null> {
  const { data, error } = await admin.rpc("fn_platform_initialized");
  return error || typeof data !== "boolean" ? null : data;
}

async function releaseClaim(admin: ReturnType<typeof createAdminClient>, claimId: string): Promise<void> {
  await admin.rpc("fn_release_platform_setup", { p_claim_id: claimId });
}

async function compensateAuthUser(
  admin: ReturnType<typeof createAdminClient>,
  userId: string,
  claimId: string,
): Promise<boolean> {
  const { error } = await admin.auth.admin.deleteUser(userId);
  await releaseClaim(admin, claimId);
  return !error;
}

export async function POST(request: Request) {
  const requestId = randomUUID();
  if (!isSameOrigin(request.headers.get("origin"), new URL(request.url).origin)) {
    return fail("forbidden", "Origem da solicitação não permitida.", 403, { requestId, headers });
  }
  if (request.headers.get("sec-fetch-site") === "cross-site") {
    return fail("forbidden", "Origem da solicitação não permitida.", 403, { requestId, headers });
  }
  if (request.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase() !== "application/json") {
    return fail("validation_error", "Envie os dados de configuração em JSON.", 415, { requestId, headers });
  }
  const contentLengthHeader = request.headers.get("content-length");
  const contentLength = contentLengthHeader ? Number(contentLengthHeader) : null;
  if (contentLength !== null && (!Number.isSafeInteger(contentLength) || contentLength < 0 || contentLength > 16_384)) {
    return fail("validation_error", "Os dados de configuração excedem o limite permitido.", 413, { requestId, headers });
  }

  const admin = createAdminClient();
  const state = await initialized(admin);
  if (state === null) {
    return fail("upstream_unavailable", "Não foi possível validar o estado da instalação.", 503, { requestId, headers });
  }
  if (state) {
    return fail("conflict", "A configuração inicial já foi concluída.", 409, { requestId, headers });
  }

  const configuredToken = env.CLIENTIX_BOOTSTRAP_TOKEN;
  if (!configuredToken || configuredToken.length < 32) {
    return fail("upstream_unavailable", "A configuração inicial não está disponível neste servidor.", 503, { requestId, headers });
  }

  const { data: rateAllowed, error: rateError } = await admin.rpc("fn_consume_platform_setup_rate_limit", {
    p_source_hash: setupRateLimitSubjectHash(clientAddress(request)),
  });
  if (rateError || typeof rateAllowed !== "boolean") {
    return fail("upstream_unavailable", "A proteção de tentativas não está disponível.", 503, { requestId, headers });
  }
  if (!rateAllowed) {
    return fail("rate_limited", "Muitas tentativas. Aguarde antes de continuar.", 429, {
      requestId,
      headers: { ...headers, "Retry-After": "900" },
    });
  }

  const boundedBody = await readBoundedJson(request);
  if (!boundedBody.ok) {
    const tooLarge = contentLength !== null && contentLength > 16_384;
    if (tooLarge) {
      return fail("validation_error", "Os dados de configuração excedem o limite permitido.", 413, { requestId, headers });
    }
    return fail("validation_error", "Os dados de configuração são inválidos.", 400, { requestId, headers });
  }
  const parsed = inputSchema.safeParse(boundedBody.value);
  if (!parsed.success) {
    return fail("validation_error", "Revise os campos da configuração.", 400, {
      requestId,
      headers,
      details: parsed.error.flatten(),
    });
  }

  const input = parsed.data;
  if (!bootstrapTokenMatches(input.bootstrap_token, configuredToken)) {
    return fail("forbidden", "Token de configuração inválido.", 403, { requestId, headers });
  }

  const claimId = randomUUID();
  const { data: reserved, error: reserveError } = await admin.rpc("fn_reserve_platform_setup", {
    p_claim_id: claimId,
  });
  if (reserveError || typeof reserved !== "boolean") {
    return fail("upstream_unavailable", "Não foi possível reservar a configuração inicial.", 503, { requestId, headers });
  }
  if (!reserved) {
    const currentState = await initialized(admin);
    return currentState
      ? fail("conflict", "A configuração inicial já foi concluída.", 409, { requestId, headers })
      : fail("conflict", "Já existe uma configuração em andamento. Aguarde e tente novamente.", 409, { requestId, headers });
  }

  const email = input.email.toLowerCase();
  const { data: created, error: authError } = await admin.auth.admin.createUser({
    email,
    password: input.password,
    email_confirm: true,
    user_metadata: {
      full_name: input.full_name,
      locale: "pt-BR",
      ...(input.phone ? { phone: input.phone } : {}),
    },
  });

  if (authError || !created.user) {
    await releaseClaim(admin, claimId);
    return fail("validation_error", "Não foi possível criar a conta com esses dados. Verifique o e-mail e tente novamente.", 400, {
      requestId,
      headers,
    });
  }

  const { data: finalized, error: finalizeError } = await admin.rpc("fn_finalize_platform_setup", {
    p_claim_id: claimId,
    p_user_id: created.user.id,
    p_platform_name: input.platform_name,
    p_request_id: requestId,
  });

  if (!finalizeError && finalized === true) {
    return ok({ initialized: true }, { status: 201, requestId, headers });
  }

  // A request can lose its response after Postgres committed. Confirm the owner
  // row before compensation so a committed owner is never deleted from Auth.
  const { data: ownerRow, error: ownerLookupError } = await admin
    .from("platform_admins")
    .select("user_id, platform_role, revoked_at")
    .eq("user_id", created.user.id)
    .eq("platform_role", "owner")
    .is("revoked_at", null)
    .maybeSingle();
  const currentState = await initialized(admin);
  if (!ownerLookupError && ownerRow && currentState === true) {
    return ok({ initialized: true }, { status: 201, requestId, headers });
  }
  if (ownerLookupError || currentState === null) {
    return fail("upstream_unavailable", "Não foi possível confirmar o resultado da configuração. Tente novamente mais tarde.", 503, {
      requestId,
      headers,
    });
  }

  const compensated = await compensateAuthUser(admin, created.user.id, claimId);
  if (!compensated) {
    return fail("upstream_unavailable", "A configuração não pôde ser concluída. O operador deve verificar o estado da instalação.", 503, {
      requestId,
      headers,
    });
  }
  return currentState
    ? fail("conflict", "A configuração inicial já foi concluída.", 409, { requestId, headers })
    : fail("upstream_unavailable", "Não foi possível concluir a configuração inicial. Tente novamente.", 503, { requestId, headers });
}
