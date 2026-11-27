import type { SupabaseClient } from "@supabase/supabase-js";
import { decryptWebhookSecret } from "@/lib/webhooks/secrets";
import { getTelegramAppCredentials } from "./app-credentials";

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

  if (error || !data || !data.telegram_session_encrypted) {
    return null;
  }

  const rawSession = data.telegram_session_encrypted;
  const hexSession =
    typeof rawSession === "string"
      ? rawSession
      : Buffer.from(rawSession as Uint8Array).toString("hex");
  const sessionString = await decryptWebhookSecret(db, hexSession);

  // As credenciais do Dono passam a valer para todos os tenants. A leitura
  // legada mantém sessões antigas operacionais até o Dono configurar o app;
  // novas conexões não gravam credenciais por organização.
  const appCredentials = await getTelegramAppCredentials();
  let apiId = appCredentials?.apiId ?? null;
  let apiHash = appCredentials?.apiHash ?? null;

  if ((!apiId || !apiHash) && data.telegram_api_id && data.telegram_api_hash_encrypted) {
    const rawHash = data.telegram_api_hash_encrypted;
    const hexHash =
      typeof rawHash === "string"
        ? rawHash
        : Buffer.from(rawHash as Uint8Array).toString("hex");
    apiId = data.telegram_api_id;
    apiHash = await decryptWebhookSecret(db, hexHash);
  }

  if (!sessionString || !apiId || !apiHash) return null;

  return {
    channelSessionId: data.id,
    userId: data.telegram_user_id,
    phone: data.telegram_phone ?? "",
    apiId,
    apiHash,
    sessionString,
  };
}
