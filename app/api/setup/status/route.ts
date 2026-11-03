import { randomUUID } from "node:crypto";
import { fail, ok } from "@/lib/api/wrappers";
import { createAdminClient } from "@/lib/supabase/admin";

export const dynamic = "force-dynamic";
const headers = { "Cache-Control": "no-store" };

/** Exposes only the installation's initialized bit; it never returns identity data. */
export async function GET() {
  const requestId = randomUUID();
  const { data, error } = await createAdminClient().rpc("fn_platform_initialized");
  if (error || typeof data !== "boolean") {
    return fail("upstream_unavailable", "Não foi possível consultar o estado da instalação.", 503, {
      requestId,
      headers,
    });
  }
  return ok({ initialized: data }, { requestId, headers });
}
