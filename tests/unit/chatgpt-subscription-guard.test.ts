import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

import { IDS_COM_CHAVE, IDS_DE_PROVEDOR, PROVEDORES } from "@/lib/ai/pontos/provedores";

function fonte(path: string): string {
  return readFileSync(resolve(process.cwd(), path), "utf8");
}

describe("guardas do login ChatGPT por assinatura", () => {
  it("mantém openai como API key e não registra openai-assinatura no catálogo de agentes/credenciais genéricas", () => {
    expect(IDS_DE_PROVEDOR).toContain("openai");
    expect(IDS_COM_CHAVE).toContain("openai");
    expect(PROVEDORES.some((provider) => provider.id === "openai")).toBe(true);
    expect(IDS_DE_PROVEDOR as readonly string[]).not.toContain("openai-assinatura");
    expect(IDS_COM_CHAVE as readonly string[]).not.toContain("openai-assinatura");
    expect(PROVEDORES.some((provider) => (provider.id as string) === "openai-assinatura")).toBe(false);
  });

  it("o POST genérico recusa assinatura e o GET genérico não expõe a linha SIWC", () => {
    const api = fonte("app/api/v1/ai/credentials/route.ts");
    expect(api).toContain("rawBody.provider === CHATGPT_SUBSCRIPTION_PROVIDER");
    expect(api).toContain('.not("provider", "eq", CHATGPT_SUBSCRIPTION_PROVIDER)');
    expect(api).toContain("z.enum(IDS_COM_CHAVE)");
  });

  it("PATCH, DELETE e revalidação genéricos escondem a credencial SIWC", () => {
    const crud = fonte("app/api/v1/ai/credentials/[id]/route.ts");
    const revalidate = fonte("app/api/v1/ai/credentials/[id]/revalidate/route.ts");
    expect(crud.match(/cred\.provider === CHATGPT_SUBSCRIPTION_PROVIDER/g)).toHaveLength(2);
    expect(revalidate).toContain("row.provider === CHATGPT_SUBSCRIPTION_PROVIDER");
  });

  it("página, lista de provedores e credenciais genéricas mantêm o recorte da assinatura", () => {
    const page = fonte("app/app/ai/credentials/page.tsx");
    const providers = fonte("app/api/v1/ai/providers/route.ts");
    const runtime = fonte("lib/ai/credentials.ts");
    expect(page).toContain('(credential.provider as string) !== CHATGPT_SUBSCRIPTION_PROVIDER');
    expect(page).toContain("{subscriptionEnabled && subscriptionStatus ? (");
    expect(providers).toContain('.not("provider", "eq", CHATGPT_SUBSCRIPTION_PROVIDER)');
    expect(runtime).toContain("IDS_DE_PROVEDOR");
  });

  it("painel SIWC não oferece campo de API key nem caminho de cadastro genérico", () => {
    const panel = fonte("app/app/ai/credentials/_components/ChatGPTSubscriptionPanel.tsx");
    expect(panel).toContain("startChatGPTSubscriptionLogin");
    expect(panel).toContain("completeChatGPTSubscriptionLogin");
    expect(panel).toContain("disconnectChatGPTSubscription");
    expect(panel).not.toContain("api_key");
    expect(panel).not.toContain("AddCredentialDialog");
  });

  it("server-side resolve org da sessão, aplica admin/MFA e feature flag sem aceitar organization_id", () => {
    const actions = fonte("app/actions/settings/chatgptSubscription.ts");
    expect(actions).toContain("loadAuthUser()");
    expect(actions).toContain("resolveActiveOrg(authUser)");
    expect(actions).toContain("ROLE_RANK[activeOrg.role] < ROLE_RANK.admin");
    expect(actions).toContain("mfaEmDivida()");
    expect(actions).toContain("moduloLigado(createAdminClient(), CHATGPT_SUBSCRIPTION_MODULE)");
    expect(actions).not.toMatch(/organization_id\s*:\s*z\./);
  });

  it("audita operações sem credenciais e conserva o feature flag global administrável", () => {
    const actions = fonte("lib/audit/actions.ts");
    const modules = fonte("lib/instalacao/modulos.ts");
    expect(actions).toContain('"ai.subscription.connected"');
    expect(actions).toContain('"ai.subscription.disconnected"');
    expect(actions).toContain('"ai.subscription.reconnected"');
    expect(modules).toContain('login_codex: "MODULO_LOGIN_CODEX"');
    expect(modules).toContain('"login_codex"');
  });
});
