/**
 * Cria/atualiza um usuário Supabase já confirmado e o anexa à E2E Test Org como admin.
 * Run: npx tsx scripts/create-test-user.ts <email> [password]
 */
import { createClient } from "@supabase/supabase-js";
import {
  anunciarDestino,
  credenciaisSupabaseDeTeste,
} from "../scripts/lib/env-de-teste";
import {
  criarOrganizacaoFixtureE2E,
  exigirSupabaseLocalParaFixture,
} from "./lib/organizations-e2e";

const env = credenciaisSupabaseDeTeste();
anunciarDestino("create-test-user", env);

exigirSupabaseLocalParaFixture(env, "create-test-user");

const EMAIL = process.argv[2];
const PASSWORD = process.env.LOCAL_TEST_USER_PASSWORD;
if (!EMAIL || !PASSWORD) {
  throw new Error("informe o e-mail como argumento e LOCAL_TEST_USER_PASSWORD no ambiente");
}
const ORG_SLUG = "e2e-test-org";

const admin = createClient(env.url, env.serviceRole, {
  auth: { autoRefreshToken: false, persistSession: false },
});

async function main() {
  let { data: org } = await admin
    .from("organizations")
    .select("id")
    .eq("slug", ORG_SLUG)
    .maybeSingle<{ id: string }>();
  if (!org) {
    org = {
      id: await criarOrganizacaoFixtureE2E(
        env,
        {
          slug: ORG_SLUG,
          displayName: "E2E Test Org",
          legalName: "E2E Test Org",
          onboardedAt: new Date().toISOString(),
        },
        "create-test-user",
      ),
    };
    console.log("[org] criada:", org.id);
  } else {
    console.log("[org] existente:", org.id);
  }

  const { data: list } = await admin.auth.admin.listUsers({ perPage: 200 });
  let user = list.users.find((u) => u.email === EMAIL);
  if (user) {
    await admin.auth.admin.updateUserById(user.id, { password: PASSWORD, email_confirm: true });
    console.log("[user] existente — senha resetada:", user.id);
  } else {
    const r = await admin.auth.admin.createUser({
      email: EMAIL,
      password: PASSWORD,
      email_confirm: true,
      user_metadata: { full_name: "Teste" },
    });
    if (r.error || !r.data?.user) throw r.error ?? new Error("user create");
    user = r.data.user;
    console.log("[user] criado:", user.id);
  }

  const { data: m } = await admin
    .from("user_organizations")
    .select("user_id")
    .eq("user_id", user.id)
    .eq("organization_id", org.id)
    .maybeSingle();
  if (m) {
    await admin
      .from("user_organizations")
      .update({ role: "admin", revoked_at: null } as never)
      .eq("user_id", user.id)
      .eq("organization_id", org.id);
    console.log("[membership] atualizada → admin");
  } else {
    const r = await admin.from("user_organizations").insert({
      user_id: user.id,
      organization_id: org.id,
      role: "admin",
      accepted_at: new Date().toISOString(),
    } as never);
    if (r.error) throw r.error;
    console.log("[membership] inserida → admin");
  }

  console.log("\n✅ Pronto");
  console.log(`   email:    ${EMAIL}`);
  console.log(`   user_id:  ${user.id}`);
  console.log(`   org_id:   ${org.id}`);
}

main().catch((err) => {
  console.error("❌ Falhou:", err);
  process.exit(1);
});
