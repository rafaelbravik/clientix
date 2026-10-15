import { chromium } from "@playwright/test";
const PASSWORD = process.env.E2E_LOGIN_PASSWORD;
const EMAIL = process.argv[2] || "e2e-agent@deskcomm.test";
if (!PASSWORD) throw new Error("defina E2E_LOGIN_PASSWORD no ambiente para o diagnóstico local");
(async () => {
  const browser = await chromium.launch({ headless: true });
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  page.on("response", (r) => {
    if (r.url().includes("login") || r.url().includes("auth") || r.status() >= 400) {
      console.log("[resp]", r.status(), r.request().method(), r.url());
    }
  });
  await page.goto("http://localhost:3000/login", { waitUntil: "domcontentloaded" });
  await page.locator("#email").focus();
  await page.waitForTimeout(300);
  await page.locator("#email").pressSequentially(EMAIL, { delay: 30 });
  await page.locator("#password").focus();
  await page.waitForTimeout(200);
  await page.locator("#password").pressSequentially(PASSWORD, { delay: 30 });
  console.log("LOGIN_FIELDS_FILLED:", Boolean(await page.locator("#email").inputValue()));
  await page.getByRole("button", { name: "Entrar", exact: true }).click();
  await page.waitForTimeout(6000);
  console.log("FINAL URL:", page.url());
  console.log("COOKIES:", (await ctx.cookies()).map((c) => c.name).join(","));
  const body = await page.locator("body").innerText();
  console.log("BODY SNIPPET:", body.slice(0, 600));
  await browser.close();
})();
