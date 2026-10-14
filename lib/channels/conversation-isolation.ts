import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * Resolve the active conversation for one exact channel session.
 *
 * A tenant and contact are not enough to identify an inbox conversation: one
 * person may contact the same organization over WhatsApp, Instagram, or more
 * than one provider account. The session id is the provider-account boundary;
 * `channel` is kept as a second invariant so a malformed session cannot cross
 * the channel boundary either.
 */
export async function findActiveConversationForChannel(
  admin: SupabaseClient,
  identity: {
    organizationId: string;
    contactId: string;
    channel: string;
    channelSessionId: string;
  },
): Promise<{ id: string; status: string } | null> {
  const { data, error } = await admin
    .from("conversations")
    .select("id, status")
    .eq("organization_id", identity.organizationId)
    .eq("contact_id", identity.contactId)
    .eq("channel", identity.channel)
    .eq("channel_session_id", identity.channelSessionId)
    .is("archived_at", null)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (error) throw new Error(`channel conversation lookup failed: ${error.message}`);
  return data;
}
