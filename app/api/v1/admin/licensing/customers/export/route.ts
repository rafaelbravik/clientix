import { randomUUID } from "node:crypto";
import { NextResponse } from "next/server";
import { z } from "zod";
import { fail } from "@/lib/api/wrappers";
import { requirePlatformAdmin } from "@/lib/auth/requirePlatformAdmin";
import { getControlPlaneAdminService } from "@/control-plane/src/admin-service-provider";

const schema = z.object({
  search: z.string().trim().max(100).optional(),
  status: z.enum(["ACTIVE", "DISABLED"]).optional(),
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
      const page = await service.listCommercialCustomers({ ...parsed.data, limit: 500, offset });
      rows.push(...page.items);
      if (rows.length >= page.total || page.items.length === 0) break;
    }
    const total = (await service.listCommercialCustomers({ ...parsed.data, limit: 1, offset: 0 }))
      .total;
    if (rows.length < total) {
      return fail(
        "invalid_request",
        "Refine the filters to export at most 20,000 customers.",
        422,
        { requestId },
      );
    }
    const header = ["name", "legal_name", "billing_email", "phone", "status", "created_at"];
    const lines = [
      header,
      ...rows.map((item) => [
        item.name,
        item.legal_name,
        item.billing_email,
        item.phone,
        item.status,
        item.created_at,
      ]),
    ].map((line) => line.map(csvCell).join(","));
    return new NextResponse(`\uFEFF${lines.join("\r\n")}`, {
      headers: {
        "Content-Type": "text/csv; charset=utf-8",
        "Content-Disposition": 'attachment; filename="clientix-customers.csv"',
        "Cache-Control": "no-store",
        "X-Request-Id": requestId,
      },
    });
  } catch {
    return fail("database_error", "Customer export is unavailable.", 500, { requestId });
  }
}
