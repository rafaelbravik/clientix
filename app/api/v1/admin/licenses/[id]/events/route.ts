import { randomUUID } from "node:crypto";
import type { NextRequest } from "next/server";
import { z } from "zod";
import { ok, fail } from "@/lib/api/wrappers";
import { requirePlatformAdmin } from "@/lib/auth/requirePlatformAdmin";
import { getControlPlaneAdminService } from "@/control-plane/src/admin-service-provider";

const querySchema = z.object({ limit: z.coerce.number().int().min(1).max(200).default(100) });
const idSchema = z.string().uuid();

export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const requestId = randomUUID();
  try {
    await requirePlatformAdmin();
  } catch {
    return fail("forbidden", "Platform admin required.", 403, { requestId });
  }
  const parsed = querySchema.safeParse({
    limit: request.nextUrl.searchParams.get("limit") ?? undefined,
  });
  if (!parsed.success) return fail("invalid_request", "Invalid event query.", 400, { requestId });
  try {
    const { id } = await params;
    const parsedId = idSchema.safeParse(id);
    if (!parsedId.success)
      return fail("invalid_request", "Invalid license identifier.", 400, { requestId });
    const result = await getControlPlaneAdminService().listLicenseEvents(
      parsedId.data,
      parsed.data.limit,
    );
    return ok(result, { requestId, headers: { "Cache-Control": "no-store" } });
  } catch {
    return fail("database_error", "License events could not be loaded.", 500, { requestId });
  }
}
