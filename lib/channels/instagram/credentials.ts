import type { SupabaseClient } from "@supabase/supabase-js";
import { decryptWebhookSecret } from "@/lib/webhooks/secrets";

export interface InstagramCredentials {
  channelSessionId: string;
  accountId: string;
  username: string | null;
  token: string;
}

export async function resolveInstagramCreds(
  db: SupabaseClient,
  opts: { organizationId: string; accountId: string },
): Promise<InstagramCredentials | null> {
  const { data, error } = await db
    .from("channel_sessions")
    .select("id, instagram_account_id, instagram_username, instagram_token_encrypted")
    .eq("organization_id", opts.organizationId)
    .eq("instagram_account_id", opts.accountId)
    .eq("provider", "instagram")
    .is("archived_at", null)
    .maybeSingle();

  if (error || !data || !data.instagram_token_encrypted) {
    return null;
  }

  const rawEnc = data.instagram_token_encrypted;
  const hex = typeof rawEnc === "string" ? rawEnc : Buffer.from(rawEnc as Uint8Array).toString("hex");
  const token = await decryptWebhookSecret(db, hex);

  if (!token) return null;

  return {
    channelSessionId: data.id,
    accountId: data.instagram_account_id,
    username: data.instagram_username,
    token,
  };
}
