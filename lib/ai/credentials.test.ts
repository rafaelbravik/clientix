import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  aesKey: Buffer.alloc(32, 11).toString("base64"),
  row: null as Record<string, unknown> | null,
  decryptKey: vi.fn(() => "synthetic-openai-api-key"),
}));

vi.mock("@/lib/env", () => ({ env: { AI_CRED_AES_KEY: mocks.aesKey } }));
vi.mock("@/lib/crypto/aes_gcm", () => ({
  decryptKey: mocks.decryptKey,
  byteaToBuffer: (value: unknown) => Buffer.from(String(value)),
}));
vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => ({
    from: () => {
      const builder = {
        select: () => builder,
        eq: () => builder,
        maybeSingle: async () => ({ data: mocks.row, error: null }),
      };
      return builder;
    },
  }),
}));

import { CredentialUnavailableError, loadCredential } from "./credentials";

describe("generic API-key runtime does not consume SIWC envelopes", () => {
  beforeEach(() => {
    mocks.decryptKey.mockClear();
    mocks.row = {
      id: "credential-a",
      organization_id: "org-a",
      provider: "openai",
      label: "OpenAI API",
      api_key_encrypted: "ciphertext-fixture",
      api_key_iv: "iv-fixture",
      api_key_tag: "tag-fixture",
      is_active: true,
      validated_at: "2026-10-30T00:00:00.000Z",
    };
  });

  it("mantém a credencial OpenAI por API key no caminho existente", async () => {
    const loaded = await loadCredential("credential-a", "org-a");
    expect(loaded).toMatchObject({ provider: "openai", apiKey: "synthetic-openai-api-key" });
    expect(mocks.decryptKey).toHaveBeenCalledTimes(1);
  });

  it("recusa provider por assinatura antes de tentar decifrá-lo como API key", async () => {
    mocks.row = { ...mocks.row, provider: "openai-assinatura" };
    await expect(loadCredential("credential-a", "org-a")).rejects.toMatchObject({
      name: "CredentialUnavailableError",
      reason: "not_found",
    } satisfies Partial<CredentialUnavailableError>);
    expect(mocks.decryptKey).not.toHaveBeenCalled();
  });
});
