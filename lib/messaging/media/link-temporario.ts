import { isMediaPathOwnedBy } from "./upload-validation";

/** Uma hora, compartilhada entre a rota autenticada e as respostas MCP. */
export const VALIDADE_DO_LINK_DE_MIDIA_S = 60 * 60;

export type McpMediaStatus = "ready" | "pending" | "expired" | "none" | "unavailable";

export interface McpMediaMessage {
  type?: string | null;
  media_url?: string | null;
  media_mime?: string | null;
  media_size_bytes?: number | null;
  media_storage_path?: string | null;
  metadata?: Record<string, unknown> | null;
}

export interface McpMediaCapability {
  media_status: McpMediaStatus;
  media_signed_url: string | null;
}

function pareceMídia(mensagem: McpMediaMessage): boolean {
  return Boolean(
    mensagem.media_url ||
      mensagem.media_mime ||
      mensagem.media_size_bytes ||
      ["image", "video", "audio", "document", "sticker"].includes(mensagem.type ?? ""),
  );
}

function classificarSemPath(mensagem: McpMediaMessage): McpMediaStatus {
  const estado = mensagem.metadata?.media_status;
  if (estado === "unavailable" || estado === "failed") return "unavailable";
  if (estado === "expired") return "expired";
  // A retenção remove o objeto e zera o path, mas preserva esta marca.
  if (estado === "stored") return "expired";
  if (estado === "pending") return "pending";
  return pareceMídia(mensagem) ? "pending" : "none";
}

/**
 * Resolve apenas capacidade temporária para uma mensagem já autorizada.
 * `assinar` só é invocado depois da checagem de path org/conversa e nunca em
 * um turno do agente; falha transitória mantém `pending`, sem expor erro bruto.
 */
export async function resolverCapacidadeMcpDeMidia(
  mensagem: McpMediaMessage,
  input: {
    organizationId: string;
    conversationId: string;
    turnoDoAgente: boolean;
    assinar: (path: string, validadeSegundos: number) => Promise<{
      signedUrl?: string | null;
      error?: unknown;
    }>;
  },
): Promise<McpMediaCapability> {
  const path = mensagem.media_storage_path;
  if (!path) return { media_status: classificarSemPath(mensagem), media_signed_url: null };
  if (!isMediaPathOwnedBy(path, input.organizationId, input.conversationId)) {
    return { media_status: "unavailable", media_signed_url: null };
  }
  if (input.turnoDoAgente) return { media_status: "ready", media_signed_url: null };

  try {
    const result = await input.assinar(path, VALIDADE_DO_LINK_DE_MIDIA_S);
    if (result.error || !result.signedUrl) {
      return { media_status: "pending", media_signed_url: null };
    }
    return { media_status: "ready", media_signed_url: result.signedUrl };
  } catch {
    return { media_status: "pending", media_signed_url: null };
  }
}
