import { type NextRequest } from "next/server";
import { requirePlatformAdmin } from "@/lib/auth/requirePlatformAdmin";
import { createAdminClient } from "@/lib/supabase/admin";
import { ok, fail } from "@/lib/api/wrappers";
import { audit } from "@/lib/audit";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { requireSupportWrite } from "@/lib/impersonate/support";
import { falhaDaEscritaDePlatformAdmin, requirePlatformAdminEscrita } from "@/lib/auth/requirePlatformAdmin";

// ---------------------------------------------------------------------------
// GET /api/v1/admin/users/[id]
// ---------------------------------------------------------------------------

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const requestId = randomUUID();
  const { id } = await params;

  let adminCtx: Awaited<ReturnType<typeof requirePlatformAdmin>>;
  try {
    adminCtx = await requirePlatformAdmin();
  } catch {
    return fail("forbidden", "Platform admin required", 403, { requestId });
  }

  const admin = createAdminClient();

  // Load auth user via admin auth API
  const { data: authUserData, error: authError } =
    await admin.auth.admin.getUserById(id);

  if (authError || !authUserData?.user) {
    return fail("not_found", "User not found", 404, { requestId });
  }

  const authUser = authUserData.user;

  // Load memberships (user_organizations + organizations join)
  const { data: memberships, error: membershipError } = await admin
    .from("user_organizations")
    .select(
      `
      organization_id,
      role,
      accepted_at,
      revoked_at,
      organizations(display_name, slug)
    `,
    )
    .eq("user_id", id)
    .order("accepted_at", { ascending: false });

  if (membershipError) {
    return fail("internal_error", "Membership query failed", 500, {
      requestId,
      details: membershipError.message,
    });
  }

  type RawMembership = {
    organization_id: string;
    role: string;
    accepted_at: string | null;
    revoked_at: string | null;
    organizations: { display_name: string; slug: string } | null;
  };

  const formattedMemberships = ((memberships ?? []) as unknown as RawMembership[]).map(
    (m) => ({
      organization_id: m.organization_id,
      tenant_name: m.organizations?.display_name ?? null,
      tenant_slug: m.organizations?.slug ?? null,
      role: m.role,
      accepted_at: m.accepted_at,
      revoked_at: m.revoked_at,
    }),
  );

  // Load recent audit entries where actor_user_id = id (LIMIT 50)
  const { data: recentAudit, error: auditError } = await admin
    .from("api_audit_log")
    .select(
      "id, action, organization_id, resource_type, resource_id, created_at, metadata",
    )
    .eq("actor_user_id", id)
    .order("created_at", { ascending: false })
    .limit(50);

  if (auditError) {
    // Non-fatal: return empty array and continue
  }

  const userMeta = authUser.user_metadata as Record<string, unknown> | null;

  const userPayload = {
    id: authUser.id,
    email: authUser.email ?? null,
    full_name: (userMeta?.full_name as string | undefined) ?? null,
    phone: authUser.phone ?? null,
    last_sign_in_at: authUser.last_sign_in_at ?? null,
    created_at: authUser.created_at,
    email_confirmed_at: authUser.email_confirmed_at ?? null,
    factors: (authUser.factors ?? []).map((f) => ({
      id: f.id,
      type: f.factor_type,
      status: f.status,
    })),
  };

  void audit({
    action: "platform_admin.user_viewed",
    actorUserId: adminCtx.user.id,
    actingAsPlatformAdmin: true,
    bypassedRls: true,
    resourceType: "user",
    resourceId: id,
    requestId,
    metadata: {
      email_hash: authUser.email
        ? Buffer.from(authUser.email.toLowerCase()).toString("hex").slice(0, 12) +
          "..."
        : null,
    },
  });

  return ok(
    {
      user: userPayload,
      memberships: formattedMemberships,
      recent_audit: recentAudit ?? [],
    },
    { requestId },
  );
}

const membershipMutationSchema = z.object({
  organization_id: z.string().uuid(),
  action: z.enum(["change_role", "revoke", "reactivate"]),
  role: z.enum(["viewer", "agent", "manager", "admin"]).optional(),
}).strict().superRefine((value, ctx) => {
  if (value.action === "change_role" && !value.role) {
    ctx.addIssue({ code: "custom", path: ["role"], message: "Selecione o papel da empresa." });
  }
  if (value.action !== "change_role" && value.role !== undefined) {
    ctx.addIssue({ code: "custom", path: ["role"], message: "O papel não se aplica a esta ação." });
  }
});

/** Escrita global de vínculo sempre carrega org, alvo e ação explicitamente. */
export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const supportDenied = await requireSupportWrite();
  if (supportDenied) return supportDenied;

  const requestId = randomUUID();
  const { id: targetUserId } = await params;
  if (!z.string().uuid().safeParse(targetUserId).success) {
    return fail("validation_error", "Identificador de usuário inválido.", 400, { requestId });
  }

  let adminCtx: Awaited<ReturnType<typeof requirePlatformAdminEscrita>>;
  try {
    adminCtx = await requirePlatformAdminEscrita();
  } catch (err) {
    return falhaDaEscritaDePlatformAdmin(err, requestId);
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return fail("validation_error", "Payload inválido.", 400, { requestId });
  }
  const parsed = membershipMutationSchema.safeParse(body);
  if (!parsed.success) {
    return fail("validation_error", "Revise a alteração de acesso.", 422, {
      requestId,
      details: parsed.error.flatten(),
    });
  }

  const { data, error } = await createAdminClient().rpc("fn_platform_manage_org_member", {
    p_actor: adminCtx.user.id,
    p_organization_id: parsed.data.organization_id,
    p_target_user_id: targetUserId,
    p_action: parsed.data.action,
    p_role: parsed.data.role ?? null,
    p_request_id: requestId,
  });
  if (error) {
    if (error.code === "P0002") return fail("not_found", "Vínculo da empresa não encontrado.", 404, { requestId });
    if (error.code === "42501") return fail("forbidden", "Ação global não autorizada.", 403, { requestId });
    if (error.code === "23514") return fail("conflict", error.message, 409, { requestId });
    if (error.code === "22023") return fail("validation_error", "Ação ou papel inválido.", 422, { requestId });
    return fail("upstream_unavailable", "Não foi possível atualizar o acesso do usuário.", 503, { requestId });
  }
  return ok(data, { requestId });
}
