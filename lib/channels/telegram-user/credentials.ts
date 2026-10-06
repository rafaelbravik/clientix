import type { SupabaseClient } from "@supabase/supabase-js";
import { decryptWebhookSecret } from "@/lib/webhooks/secrets";

export interface TelegramUserCredentials {
  channelSessionId: string;
  userId: string;
  phone: string;
  apiId: number;
  apiHash: string;
  sessionString: string;
}

export async function resolveTelegramUserCreds(
  db: SupabaseClient,
  opts: { organizationId: string; userId: string },
): Promise<TelegramUserCredentials | null> {
  const { data, error } = await db
    .from("channel_sessions")
    .select(
      "id, telegram_user_id, telegram_phone, telegram_api_id, telegram_api_hash_encrypted, telegram_session_encrypted",
    )
    .eq("organization_id", opts.organizationId)
    .eq("telegram_user_id", opts.userId)
    .eq("provider", "telegram_user")
    .is("archived_at", null)
    .maybeSingle();

  if (
    error ||
    !data ||
    !data.telegram_session_encrypted ||
    !data.telegram_api_hash_encrypted ||
    !data.telegram_api_id
  ) {
    return null;
  }

  const rawSession = data.telegram_session_encrypted;
  const hexSession =
    typeof rawSession === "string"
      ? rawSession
      : Buffer.from(rawSession as Uint8Array).toString("hex");
  const sessionString = await decryptWebhookSecret(db, hexSession);

  const rawHash = data.telegram_api_hash_encrypted;
  const hexHash =
    typeof rawHash === "string"
      ? rawHash
      : Buffer.from(rawHash as Uint8Array).toString("hex");
  const apiHash = await decryptWebhookSecret(db, hexHash);

  if (!sessionString || !apiHash) return null;

  return {
    channelSessionId: data.id,
    userId: data.telegram_user_id,
    phone: data.telegram_phone ?? "",
    apiId: data.telegram_api_id,
    apiHash,
    sessionString,
  };
}
