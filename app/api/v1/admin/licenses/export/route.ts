import { randomUUID } from "node:crypto";
import { NextResponse } from "next/server";
import { z } from "zod";
import { fail } from "@/lib/api/wrappers";
import { requirePlatformAdmin } from "@/lib/auth/requirePlatformAdmin";
import { getControlPlaneAdminService } from "@/control-plane/src/admin-service-provider";

const schema = z.object({
  status: z.enum(["DRAFT", "ACTIVE", "EXPIRED", "SUSPENDED", "REVOKED"]).optional(),
  plan: z.enum(["standard", "pro", "enterprise"]).optional(),
  search: z.string().trim().max(100).optional(),
  customer_id: z.string().uuid().optional(),
  expires_in_days: z.coerce.number().int().min(0).max(365).optional(),
  validity: z.enum(["VALID", "GRACE", "EXPIRED", "NOT_YET_VALID"]).optional(),
  installation_status: z.enum(["ACTIVE", "INACTIVE"]).optional(),
  clone_status: z
    .enum(["NORMAL", "SUSPECTED_CLONE", "CLONE_CONFIRMED", "TRANSFER_PENDING"])
    .optional(),
});
const csvCell = (value: unknown) => {
  const text = String(value ?? "").replace(/[\r\n]+/g, " ");
  const safe = /^[=+@\-]/.test(text) ? `'${text}` : text;
  return `"${safe.replace(/"/g, '""')}"`;
};

export async function GET(request: Request) {
  const requestId = randomUUID();
  try {
    await requirePlatformAdmin();
  } catch {
    return fail("forbidden", "Platform admin required.", 403, { requestId });
  }
  const parsed = schema.safeParse(Object.fromEntries(new URL(request.url).searchParams));
  if (!parsed.success)
    return fail("invalid_request", "Invalid export filters.", 400, { requestId });
  try {
    const service = getControlPlaneAdminService();
    const rows = [];
    for (let offset = 0; offset < 20_000; offset += 500) {
      const page = await service.listCommercialLicenses({ ...parsed.data, limit: 500, offset });
      rows.push(...page.items);
      if (rows.length >= page.total || page.items.length === 0) break;
    }
    const total = (await service.listCommercialLicenses({ ...parsed.data, limit: 1, offset: 0 }))
      .total;
    if (rows.length < total) {
      return fail("invalid_request", "Refine the filters to export at most 20,000 licenses.", 422, {
        requestId,
      });
    }
    const header = [
      "serial",
      "customer",
      "plan",
      "status",
      "valid_from",
      "expires_at",
      "active_installations",
    ];
    const lines = [
      header,
      ...rows.map((item) => [
        item.serial,
        item.customer_name,
        item.plan,
        item.status,
        item.valid_from,
        item.expires_at,
        item.active_installations_count,
      ]),
    ].map((line) => line.map(csvCell).join(","));
    return new NextResponse(`\uFEFF${lines.join("\r\n")}`, {
      headers: {
        "Content-Type": "text/csv; charset=utf-8",
        "Content-Disposition": 'attachment; filename="clientix-licenses.csv"',
        "Cache-Control": "no-store",
        "X-Request-Id": requestId,
      },
    });
  } catch {
    return fail("database_error", "License export is unavailable.", 500, { requestId });
  }
}
