import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";
import { readSupportContext } from "./support";

interface SupportAuditEntry {
  actorUserId?: string | null;
  actorApiTokenId?: string | null;
  actorAuthSessionId?: string | null;
  organizationId?: string | null;
}

export async function obterMetadadosDeAcompanhamento(
  entry: SupportAuditEntry,
): Promise<Record<string, unknown>> {
  if (entry.actorUserId && entry.actorAuthSessionId && entry.organizationId && !entry.actorApiTokenId) {
    // Callback SameSite=Strict não traz cookie. O state já autenticou ator/sessão;
    // a cerca do callback já revalidou a autorização antes do efeito.
    const { data: session } = await createAdminClient()
      .from("platform_support_sessions")
      .select("id, access_mode, auth_session_id, ended_at")
      .eq("actor_user_id", entry.actorUserId)
      .eq("auth_session_id", entry.actorAuthSessionId)
      .eq("organization_id", entry.organizationId)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (!session || session.ended_at) return {};
    return {
      support_session_id: session.id,
      support_access_mode: session.access_mode,
      support_auth_session_id: session.auth_session_id,
    };
  }

  if (entry.actorUserId && !entry.actorApiTokenId) {
    const db = await createClient();
    const { data: { user } } = await db.auth.getUser();
    if (user?.id !== entry.actorUserId) return {};
    const support = await readSupportContext(db);
    if (!support || support.organization_id !== entry.organizationId) return {};
    return {
      support_session_id: support.id,
      support_access_mode: support.access_mode,
      support_auth_session_id: support.auth_session_id,
    };
  }

  return {};
}
