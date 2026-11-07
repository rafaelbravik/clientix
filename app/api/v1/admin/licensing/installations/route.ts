import { z } from "zod";
import { randomUUID } from "node:crypto";
import { ok, fail } from "@/lib/api/wrappers";
import { requirePlatformAdmin } from "@/lib/auth/requirePlatformAdmin";
import { getControlPlaneAdminService } from "@/control-plane/src/admin-service-provider";

const querySchema = z.object({
  license_id: z.string().uuid().optional(),
  status: z
    .enum(["ACTIVE", "SUSPENDED", "REVOKED", "DEACTIVATED", "TRANSFERRED", "DISABLED"])
    .optional(),
  clone_status: z
    .enum(["NORMAL", "SUSPECTED_CLONE", "CLONE_CONFIRMED", "TRANSFER_PENDING"])
    .optional(),
  plan: z.enum(["standard", "pro", "enterprise"]).optional(),
  sort: z.enum(["customer", "status", "last_validation", "created_at"]).default("created_at"),
  direction: z.enum(["asc", "desc"]).default("desc"),
  search: z.string().trim().max(100).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
  offset: z.coerce.number().int().min(0).max(100_000).default(0),
});

export async function GET(request: Request) {
  const requestId = randomUUID();
  try {
    await requirePlatformAdmin();
  } catch {
    return fail("forbidden", "Platform admin required.", 403, { requestId });
  }
  const parsed = querySchema.safeParse(Object.fromEntries(new URL(request.url).searchParams));
  if (!parsed.success)
    return fail("invalid_request", "Invalid installation query.", 400, { requestId });
  try {
    const result = await getControlPlaneAdminService().listCommercialInstallations(parsed.data);
    return ok(result.items, {
      requestId,
      meta: {
        total: result.total,
        limit: result.limit,
        offset: result.offset,
        has_more: result.offset + result.items.length < result.total,
      },
      headers: { "Cache-Control": "no-store" },
    });
  } catch {
    return fail("database_error", "Installations could not be loaded.", 500, { requestId });
  }
}
