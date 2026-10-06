import type { SupabaseClient } from "@supabase/supabase-js";
import { decryptWebhookSecret } from "@/lib/webhooks/secrets";

export interface TelegramCredentials {
  channelSessionId: string;
  botId: string;
  username: string | null;
  token: string;
}

export async function resolveTelegramCreds(
  db: SupabaseClient,
  opts: { organizationId: string; botId: string },
): Promise<TelegramCredentials | null> {
  const { data, error } = await db
    .from("channel_sessions")
    .select("id, telegram_bot_id, telegram_bot_username, telegram_bot_token_encrypted")
    .eq("organization_id", opts.organizationId)
    .eq("telegram_bot_id", opts.botId)
    .eq("provider", "telegram")
    .is("archived_at", null)
    .maybeSingle();

  if (error || !data || !data.telegram_bot_token_encrypted) {
    return null;
  }

  const rawEnc = data.telegram_bot_token_encrypted;
  const hex = typeof rawEnc === "string" ? rawEnc : Buffer.from(rawEnc as Uint8Array).toString("hex");
  const token = await decryptWebhookSecret(db, hex);

  if (!token) return null;

  return {
    channelSessionId: data.id,
    botId: data.telegram_bot_id,
    username: data.telegram_bot_username,
    token,
  };
}
