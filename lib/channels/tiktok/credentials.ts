import type { SupabaseClient } from "@supabase/supabase-js";
import { decryptWebhookSecret } from "@/lib/webhooks/secrets";

export interface TikTokCredentials {
  channelSessionId: string;
  businessId: string;
  username: string | null;
  token: string;
}

export async function resolveTikTokCreds(
  db: SupabaseClient,
  opts: { organizationId: string; businessId: string },
): Promise<TikTokCredentials | null> {
  const { data, error } = await db
    .from("channel_sessions")
    .select("id, tiktok_business_id, tiktok_username, tiktok_token_encrypted")
    .eq("organization_id", opts.organizationId)
    .eq("tiktok_business_id", opts.businessId)
    .eq("provider", "tiktok")
    .is("archived_at", null)
    .maybeSingle();

  if (error || !data || !data.tiktok_token_encrypted) {
    return null;
  }

  const rawEnc = data.tiktok_token_encrypted;
  const hex = typeof rawEnc === "string" ? rawEnc : Buffer.from(rawEnc as Uint8Array).toString("hex");
  const token = await decryptWebhookSecret(db, hex);

  if (!token) return null;

  return {
    channelSessionId: data.id,
    businessId: data.tiktok_business_id,
    username: data.tiktok_username,
    token,
  };
}
