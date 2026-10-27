import { describe, expect, it, vi } from "vitest";

import {
  resolverCapacidadeMcpDeMidia,
  VALIDADE_DO_LINK_DE_MIDIA_S,
} from "./link-temporario";

const ORG = "11111111-1111-4111-8111-111111111111";
const CONV = "22222222-2222-4222-8222-222222222222";
const PATH = `${ORG}/${CONV}/33333333-3333-4333-8333-333333333333.jpg`;

const resolve = (message: Record<string, unknown>, opts: { agent?: boolean } = {}) =>
  resolverCapacidadeMcpDeMidia(message, {
    organizationId: ORG,
    conversationId: CONV,
    turnoDoAgente: opts.agent ?? false,
    assinar: vi.fn(async () => ({ signedUrl: "https://storage.invalid/signed/neutral" })),
  });

describe("capacidade temporária de mídia para MCP", () => {
  it("mídia pronta recebe URL assinada privada com TTL canônico", async () => {
    const assinar = vi.fn(async (_path: string, _ttl: number) => ({
      signedUrl: "https://storage.invalid/signed/neutral",
    }));
    const result = await resolverCapacidadeMcpDeMidia(
      { type: "image", media_storage_path: PATH },
      { organizationId: ORG, conversationId: CONV, turnoDoAgente: false, assinar },
    );

    expect(VALIDADE_DO_LINK_DE_MIDIA_S).toBe(3600);
    expect(assinar).toHaveBeenCalledWith(PATH, VALIDADE_DO_LINK_DE_MIDIA_S);
    expect(result).toEqual({
      media_status: "ready",
      media_signed_url: "https://storage.invalid/signed/neutral",
    });
  });

  it("turno do agente preserva metadados, mas nunca recebe link bearer", async () => {
    const assinar = vi.fn();
    const result = await resolverCapacidadeMcpDeMidia(
      { type: "image", media_storage_path: PATH },
      { organizationId: ORG, conversationId: CONV, turnoDoAgente: true, assinar },
    );

    expect(result).toEqual({ media_status: "ready", media_signed_url: null });
    expect(assinar).not.toHaveBeenCalled();
  });

  it("retention mantém expired distinguível de none", async () => {
    await expect(resolve({ type: "image", metadata: { media_status: "stored" } })).resolves.toEqual({
      media_status: "expired",
      media_signed_url: null,
    });
    await expect(resolve({ type: "text", body: "Olá" })).resolves.toEqual({
      media_status: "none",
      media_signed_url: null,
    });
  });

  it("mantém estados pending e unavailable do fluxo de histórico do Clientix", async () => {
    await expect(resolve({ type: "audio", metadata: { media_status: "pending" } })).resolves.toEqual({
      media_status: "pending",
      media_signed_url: null,
    });
    await expect(resolve({ type: "image", metadata: { media_status: "unavailable" } })).resolves.toEqual({
      media_status: "unavailable",
      media_signed_url: null,
    });
  });

  it.each([`other-org/${CONV}/x.png`, `${ORG}/other-conversation/x.png`, `${ORG}/${CONV}/../x.png`])(
    "não assina path fora da organização/conversa ou com traversal: %s",
    async (path) => {
      const assinar = vi.fn();
      const result = await resolverCapacidadeMcpDeMidia(
        { type: "image", media_storage_path: path },
        { organizationId: ORG, conversationId: CONV, turnoDoAgente: false, assinar },
      );

      expect(result).toEqual({ media_status: "unavailable", media_signed_url: null });
      expect(assinar).not.toHaveBeenCalled();
    },
  );

  it("mensagem com URL de provider mas sem persistência fica pending e não vaza a URL", async () => {
    await expect(resolve({
      type: "image",
      media_url: "https://provider.invalid/private-original",
      media_mime: "image/jpeg",
    })).resolves.toEqual({ media_status: "pending", media_signed_url: null });
  });

  it("falha temporária ao assinar continua pending e não devolve erro interno", async () => {
    const result = await resolverCapacidadeMcpDeMidia(
      { type: "document", media_storage_path: PATH },
      {
        organizationId: ORG,
        conversationId: CONV,
        turnoDoAgente: false,
        assinar: async () => ({ error: new Error("private storage detail") }),
      },
    );

    expect(result).toEqual({ media_status: "pending", media_signed_url: null });
    expect(JSON.stringify(result)).not.toContain("private storage detail");
  });
});
