import { valorDaInstalacao } from "@/lib/instalacao/config";

export interface TelegramAppCredentials {
  apiId: number;
  apiHash: string;
}

/** Credenciais MTProto compartilhadas por todas as organizações da instalação. */
export async function getTelegramAppCredentials(): Promise<TelegramAppCredentials | null> {
  const [apiIdConfig, apiHashConfig] = await Promise.all([
    valorDaInstalacao("TELEGRAM_API_ID"),
    valorDaInstalacao("TELEGRAM_API_HASH"),
  ]);

  const apiIdRaw = apiIdConfig.valor?.trim() ?? "";
  const apiHash = apiHashConfig.valor?.trim() ?? "";
  const apiId = Number(apiIdRaw);

  if (
    !/^\d+$/.test(apiIdRaw) ||
    !Number.isSafeInteger(apiId) ||
    apiId <= 0 ||
    apiId > 2_147_483_647 ||
    !/^[a-f0-9]{32}$/i.test(apiHash)
  ) {
    return null;
  }

  return { apiId, apiHash };
}
