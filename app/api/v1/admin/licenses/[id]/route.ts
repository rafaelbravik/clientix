import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { NextRequest } from "next/server";
import { ok, fail } from "@/lib/api/wrappers";
import { requirePlatformAdmin } from "@/lib/auth/requirePlatformAdmin";
import { getControlPlaneAdminService } from "@/control-plane/src/admin-service-provider";

const idSchema = z.string().uuid();

export async function GET(_request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const requestId = randomUUID();
  try {
    await requirePlatformAdmin();
  } catch {
    return fail("forbidden", "License Server administrator required.", 403, { requestId });
  }
  const id = idSchema.safeParse((await params).id);
  if (!id.success)
    return fail("invalid_request", "Invalid license identifier.", 400, { requestId });
  try {
    const result = await getControlPlaneAdminService().getLicenseDetail(id.data);
    if (!result) return fail("not_found", "License not found.", 404, { requestId });
    return ok(result, { requestId, headers: { "Cache-Control": "no-store" } });
  } catch {
    return fail("database_error", "License detail could not be loaded.", 500, { requestId });
  }
}
