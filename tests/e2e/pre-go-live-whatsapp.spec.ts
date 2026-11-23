import { randomUUID } from "node:crypto";
import { test, expect } from "./helpers/test";
import { createClient } from "@supabase/supabase-js";
import { metadataInicialDoCanal } from "../../lib/ai/elegibilidade/pre-go-live";
import { nomeDaSessaoCabeNoWaha } from "../../lib/channels/nome-da-sessao";
import { insertOrganizationFixture } from "./helpers/organization-fixture";

const url = process.env.NEXT_PUBLIC_SUPABASE_URL!;
if (!["localhost", "127.0.0.1"].includes(new URL(url).hostname)) {
  throw new Error("Somente Supabase local");
}
const admin = createClient(url, process.env.SUPABASE_SERVICE_ROLE_KEY!, {
  auth: { persistSession: false },
});
let userId = "";
let orgId = "";

// Banco e auth reais, sem interceptar a API da feature. Não envia WhatsApp real.
test.use({ locale: "pt-BR" });
test.afterAll(async () => {
  if (orgId) await admin.from("organizations").delete().eq("id", orgId);
  if (userId) await admin.auth.admin.deleteUser(userId);
});

test("admin configura testes, remove número, confirma abertura e volta a restringir", async ({ page }, testInfo) => {
  test.setTimeout(120_000);
  const suffix = randomUUID().slice(0, 8);
  const email = `prego-${suffix}@example.test`;
  const password = `E2e-${randomUUID()}!`;
  const orgName = `pre-go-live-${suffix}`;
  const { data: criado, error: erroUsuario } = await admin.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
  });
  if (erroUsuario || !criado.user) throw erroUsuario ?? new Error("sem usuário de teste");
  userId = criado.user.id;
  orgId = await insertOrganizationFixture({
    slug: orgName,
    display_name: orgName,
    legal_name: orgName,
    status: "active",
    created_by: userId,
    // Esta spec cobre a configuração do canal após onboarding, não o wizard.
    onboarded_at: new Date().toISOString(),
  });
  const { error: erroVinculo } = await admin.from("user_organizations").insert({
    organization_id: orgId,
    user_id: userId,
    role: "admin",
    accepted_at: new Date().toISOString(),
  });
  if (erroVinculo) throw erroVinculo;
  // Este spec monta o nome à mão (#686) e nunca chama o gerador: o que ele
  // monta tem de caber no que o WAHA aceita, senão a prova de tela continua
  // passando ao lado do mesmo defeito que o invariante passava.
  const sessao = `prego_${suffix}`;
  expect(nomeDaSessaoCabeNoWaha(sessao)).toBe(true);
  const { data: channel, error } = await admin.from("channel_sessions").insert({
    organization_id: orgId, display_name: "Canal de validação", waha_session_name: sessao,
    webhook_secret_encrypted: "\\x00", metadata: metadataInicialDoCanal(), status: "STOPPED",
  }).select("id").single();
  expect(error).toBeNull();
  const channelId = channel!.id;

  await page.goto("/login");
  await page.locator("#email").fill(email);
  await page.locator("#password").fill(password);
  await page.getByRole("button", { name: "Entrar", exact: true }).click();
  await page.waitForURL(/\/app/);
  await page.goto("/app/connections");
  await expect(
    page.getByRole("tabpanel", { name: "Números por QR" }).getByText("Canal de validação"),
  ).toBeVisible();
  await expect(page.getByText("IA em modo de teste", { exact: true })).toBeVisible();
  const openPanel = () => page.getByRole("button", { name: "Configurar acesso da IA" }).click();
  const input = page.getByLabel("Números autorizados para teste");
  const phone = "+5511999998888";
  const read = async () => (await admin.from("channel_sessions").select("metadata").eq("organization_id", orgId).eq("id", channelId).single()).data!.metadata;
  await openPanel();
  await expect(input).toHaveValue("");
  await input.fill("telefone inválido");
  await page.getByRole("button", { name: "Salvar lista de teste" }).click();
  await expect(page.getByRole("dialog", { name: "Acesso da IA no WhatsApp" }).getByRole("alert")).toContainText("Use um telefone com DDI");
  expect((await read()).ai_test_phone_numbers).toEqual([]);
  await input.fill(`${phone}\n+55 (11) 99999-8888\n+14155552671`);
  await page.getByRole("button", { name: "Salvar lista de teste" }).click();
  await expect(input).not.toBeVisible();
  expect((await read()).ai_test_phone_numbers).toEqual([phone, "+14155552671"]);
  await page.reload();
  await openPanel();
  await expect(input).toHaveValue(`${phone}\n+14155552671`);
  await input.fill(phone);
  await page.getByRole("button", { name: "Salvar lista de teste" }).click();
  await expect(input).not.toBeVisible();
  expect((await read()).ai_test_phone_numbers).toEqual([phone]);
  await openPanel();
  await page.getByRole("button", { name: "Liberar atendimento ao público" }).click();
  await page.getByRole("button", { name: "Continuar em teste" }).click();
  expect((await read()).ai_gate).toBe("allowlist");
  await page.getByRole("button", { name: "Liberar atendimento ao público" }).click();
  await page.getByRole("button", { name: "Confirmar liberação" }).click();
  await expect(input).not.toBeVisible();
  expect((await read()).ai_gate).toBe("open");
  expect((await read()).ai_test_phone_numbers).toEqual([phone]);
  await page.reload();
  await expect(page.getByText("IA aberta ao público", { exact: true })).toBeVisible();
  await openPanel();
  await expect(input).toHaveValue(phone);
  await page.getByRole("button", { name: "Ativar modo de teste" }).click();
  await expect(input).not.toBeVisible();
  expect((await read()).ai_gate).toBe("allowlist");
  await page.setViewportSize({ width: 390, height: 844 });
  await openPanel();
  await expect(input).toHaveValue(phone);
  const sheet = page.getByRole("dialog", { name: "Acesso da IA no WhatsApp" });
  expect(await sheet.evaluate(el => el.scrollWidth <= el.clientWidth)).toBe(true);
  await expect(page.getByText("Acesso da IA atualizado.", { exact: true })).not.toBeVisible({ timeout: 10_000 });
  await page.screenshot({ path: testInfo.outputPath("pre-go-live-mobile.png"), fullPage: true });
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.screenshot({ path: testInfo.outputPath("pre-go-live-desktop.png"), fullPage: true });
  await input.fill("");
  await page.getByRole("button", { name: "Salvar lista de teste" }).click();
  await expect(input).not.toBeVisible();
  expect((await read()).ai_test_phone_numbers).toEqual([]);
});
