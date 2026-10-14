import { randomUUID } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";

import { CHANNEL_PROVIDER_WEBCHAT } from "./capabilities";

/** Cria a sessão local sem pedir ou armazenar segredo de transporte externo. */
export async function createWebchatSession(
  admin: SupabaseClient,
  input: { organizationId: string; createdBy: string },
) {
  const publicId = randomUUID();
  const { data, error } = await admin
    .from("channel_sessions")
    .insert({
      organization_id: input.organizationId,
      provider: CHANNEL_PROVIDER_WEBCHAT,
      webchat_public_id: publicId,
      // A union do schema mantém o identificador de transporte nulo quando ele
      // não existe; a coluna específica está encapsulada neste módulo de canal.
      waha_session_name: null,
      webhook_secret_encrypted: null,
      display_name: "WebChat",
      status: "WORKING",
      created_by: input.createdBy,
    } as never)
    .select("id, webchat_public_id, status")
    .single();

  return {
    data: data as unknown as { id: string; webchat_public_id: string; status: string } | null,
    error,
  };
}
