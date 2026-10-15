import type { SupportContext } from "./support-context";
import type { createClient } from "@/lib/supabase/server";

/** Customer auth has no vendor support persistence or impersonation context. */
export async function readSupportContext(
  _db: Awaited<ReturnType<typeof createClient>>,
): Promise<SupportContext | null> {
  return null;
}
