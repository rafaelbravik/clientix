/**
 * Bootstrap do 1º dono de uma instância self-host do Clientix.
 *
 * O app NÃO tem tela de cadastro — este script cria, de forma idempotente:
 *   1. o usuário dono (auth) com e-mail confirmado
 *   2. a organização (tenant)
 *   3. a associação do dono como `admin`
 *   4. o Platform Owner global, finalizando o first-run pela RPC atômica
 *
 * Depois disso o dono faz login e o onboarding do app cuida do resto
 * (WhatsApp, IA, time). A verificação em duas etapas é OPCIONAL e se liga em
 * Configurações › Segurança — ver `lib/auth/politica-mfa.ts`.
 *
 * Uso (o install.sh exporta as vars; localmente lê .env/.env.local):
 *   OWNER_EMAIL=dono@empresa.com OWNER_PASSWORD='senha-forte' \
 *   OWNER_ORG_NAME='Minha Empresa' npx tsx scripts/bootstrap-owner.ts
 */

import { randomUUID } from "node:crypto";
import { isIP } from "node:net";
import { createClient } from "@supabase/supabase-js";
import { Pool } from "pg";
import * as fs from "node:fs";
import * as path from "node:path";

import { escolherModeloNoCatalogo } from "@/lib/ai/agents/escolher-modelo";
import { resolveSystemInstallationId } from "@/lib/licensing/enforcement";
import { isValidInstallationId } from "@/lib/licensing/installation-id";

/** Lê env do processo; completa com .env / .env.local se rodando localmente. */
function loadEnv(): Record<string, string> {
  const out: Record<string, string> = { ...process.env } as Record<string, string>;
  for (const file of [".env", ".env.local"]) {
    const p = path.join(process.cwd(), file);
    if (!fs.existsSync(p)) continue;
    for (const line of fs.readFileSync(p, "utf8").split("\n")) {
      const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
      if (m && !out[m[1]!]) out[m[1]!] = m[2]!.replace(/^"(.*)"$/, "$1");
    }
  }
  return out;
}

const env = loadEnv();

const SUPABASE_URL = env.NEXT_PUBLIC_SUPABASE_URL;
const SERVICE_ROLE = env.SUPABASE_SERVICE_ROLE_KEY;
const OWNER_EMAIL = env.OWNER_EMAIL;
const OWNER_PASSWORD = env.OWNER_PASSWORD;
const ORG_NAME = env.OWNER_ORG_NAME || "Minha Empresa";
const FINALIZE_EXISTING_OWNER = process.argv.includes("--finalize-existing-owner");
/**
 * O idioma que quem instalou escolheu, gravado na ORGANIZAÇÃO.
 *
 * Na organização, e não só no usuário dono, porque é ela que responde por quem
 * ainda não existe: o segundo, o terceiro e o décimo convidado entram sem
 * preferência própria e caem no idioma da empresa
 * (`AuthUser.idioma`, resolvido em `lib/auth/server.ts`). Gravar apenas no dono
 * faria uma instalação inteira em espanhol entregar o sistema em português para
 * todo mundo que o dono convidasse.
 *
 * Fecha para o padrão diante de qualquer valor desconhecido: um `.env` com
 * `APP_LOCALE=en` não pode derrubar a instalação nem escrever lixo no banco.
 */
const IDIOMAS_SERVIDOS = ["pt-BR", "es"] as const;
const APP_LOCALE = (IDIOMAS_SERVIDOS as readonly string[]).includes((env.APP_LOCALE ?? "").trim())
  ? (env.APP_LOCALE as string).trim()
  : "pt-BR";

if (!SUPABASE_URL || !SERVICE_ROLE) {
  throw new Error("Faltam NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY.");
}
if (!FINALIZE_EXISTING_OWNER && (!OWNER_EMAIL || !OWNER_PASSWORD)) {
  throw new Error("Faltam OWNER_EMAIL / OWNER_PASSWORD.");
}
if (!FINALIZE_EXISTING_OWNER && OWNER_PASSWORD && OWNER_PASSWORD.length < 8) {
  throw new Error("A senha inicial precisa ter pelo menos 8 caracteres.");
}
if (FINALIZE_EXISTING_OWNER && env.DESKCOMM_ENV_MODE !== "local") {
  throw new Error("A finalização de um dono existente só pode ser usada no ambiente local.");
}

/** slug seguro (o tipo da coluna é restrito): minúsculo, hífens, sem acento. */
function slugify(s: string): string {
  return (
    s
      .normalize("NFD")
      .replace(/[̀-ͯ]/g, "")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 40) || "minha-empresa"
  );
}

const admin = createClient(SUPABASE_URL, SERVICE_ROLE, {
  auth: { autoRefreshToken: false, persistSession: false },
});

async function ensureOwnerUser(): Promise<string> {
  const { data: list, error: listError } = await admin.auth.admin.listUsers({ perPage: 200 });
  if (listError) throw new Error(`consultar usuários Auth: ${listError.message}`);
  const existing = list.users.find(
    (user) => user.email?.toLowerCase() === OWNER_EMAIL!.toLowerCase(),
  );
  if (existing) {
    const { error } = await admin.auth.admin.updateUserById(existing.id, {
      password: OWNER_PASSWORD,
    });
    if (error) throw new Error(`atualizar senha do dono: ${error.message}`);
    console.log(`[bootstrap] dono já existia, senha atualizada: ${existing.id}`);
    return existing.id;
  }
  const { data, error } = await admin.auth.admin.createUser({
    email: OWNER_EMAIL,
    password: OWNER_PASSWORD,
    email_confirm: true,
    // O dono também nasce com a preferência: ele é o único que entra antes de
    // existir organização resolvida na sessão, no primeiro login.
    user_metadata: { full_name: "Dono", locale: APP_LOCALE },
  });
  if (error || !data?.user) throw new Error(`criar dono: ${error?.message}`);
  console.log(`[bootstrap] dono criado: ${data.user.id}`);
  return data.user.id;
}

async function ensureOrg(ownerId: string): Promise<string> {
  const slug = slugify(ORG_NAME);
  const installationId = env.INSTALLATION_ID || (await resolveSystemInstallationId());
  if (!isValidInstallationId(installationId)) {
    throw new Error("INSTALLATION_ID inválido para o bootstrap da organização inicial.");
  }
  const { data, error } = await admin.rpc("fn_bootstrap_first_tenant", {
    p_installation_id: installationId,
    p_owner: ownerId,
    p_slug: slug,
    p_display_name: ORG_NAME,
    p_legal_name: ORG_NAME,
    p_locale: APP_LOCALE,
  });
  if (error || !data) throw new Error(`criar org: ${error?.message}`);
  const result = data as { id?: string; created?: boolean };
  if (!result.id) throw new Error("criar org: RPC retornou organização inválida");
  const orgId = result.id;
  if (result.created) {
    console.log(`[bootstrap] org criada: ${orgId}`);
    await aplicarProvedorEscolhido(orgId);
  } else {
    console.log(`[bootstrap] org já existia: ${orgId}`);
  }
  return orgId;
}

/**
 * O provedor que a pessoa ESCOLHEU no instalador passa a valer no banco.
 *
 * `fn_seed_org_llm_defaults` (trigger de insert em `organizations`) semeia
 * `settings.llm.provider = 'anthropic'`, fixo. Enquanto a Anthropic era a única
 * chave que o `install.sh` pedia, isso estava certo. Desde que o instalador
 * pergunta qual IA vai atender, a resposta era simplesmente ignorada pelo
 * banco: quem escolhia OpenRouter instalava, cadastrava a chave, e todo caminho
 * que passa pelo agent-engine resolvia `provider='anthropic'` — sem chave da
 * Anthropic, `LlmNotConfiguredError` em tudo, com a mensagem mandando cadastrar
 * justamente a chave que ele decidiu não usar.
 *
 * O par vai INTEIRO (`lib/ai/pontos/padrao-da-organizacao.ts`): o gatilho
 * semeia `provider` e `default_model` da Anthropic juntos, e trocar só o
 * provedor deixava `{openai, claude-sonnet-5}` — um id que a OpenAI não
 * conhece, pedido por todo ponto que cai no padrão da empresa. O modelo sai do
 * catálogo do provedor escolhido pela MESMA régua do onboarding
 * (`escolherModeloNoCatalogo`), então nada aqui é inventado.
 *
 * Catálogo vazio (a OpenRouter chega com zero linhas até o cron de catálogo
 * rodar) ou ilegível: grava só o `provider`, como antes. O par incoerente que
 * sobra é resolvido na LEITURA por `lib/ai/gateway-binding.ts`, que troca o
 * modelo pelo do catálogo assim que ele existir.
 */
async function aplicarProvedorEscolhido(orgId: string): Promise<void> {
  const escolhido = (process.env.AI_PROVIDER ?? "").trim().toLowerCase();
  if (escolhido === "" || escolhido === "anthropic") return;

  const { data: org } = await admin
    .from("organizations")
    .select("settings")
    .eq("id", orgId)
    .maybeSingle();
  const settings = ((org as { settings?: Record<string, unknown> } | null)?.settings ??
    {}) as Record<string, unknown>;
  const llm = ((settings["llm"] as Record<string, unknown> | undefined) ?? {}) as Record<
    string,
    unknown
  >;

  const escolha = await escolherModeloNoCatalogo(admin, escolhido);
  const modelo = escolha?.escolhido ? escolha.modelId : null;
  if (modelo === null) {
    console.warn(
      `[bootstrap] ${escolha === null ? "não consegui ler" : "ainda não há modelo no"} catálogo de "${escolhido}": ` +
        `gravo só o provedor, e o modelo padrão se escolhe em Agente de IA → Provedores.`,
    );
  }
  const novoLlm =
    modelo === null
      ? { ...llm, provider: escolhido }
      : { ...llm, provider: escolhido, default_model: modelo };

  const { error } = await admin
    .from("organizations")
    .update({ settings: { ...settings, llm: novoLlm } } as never)
    .eq("id", orgId);
  if (error) {
    // Não derruba a instalação: a org existe e o operador consegue trocar o
    // provedor pela tela. Mas o aviso precisa aparecer, senão ele descobre
    // pelo agente mudo.
    console.warn(
      `[bootstrap] não consegui gravar o provedor "${escolhido}" na organização: ${error.message}. ` +
        `Ajuste em Agente de IA → Provedores depois de entrar.`,
    );
    return;
  }
  console.log(
    `[bootstrap] provedor de IA da organização: ${escolhido}${modelo === null ? "" : ` (modelo ${modelo})`}`,
  );
}

async function ensureMembership(userId: string, orgId: string): Promise<void> {
  const { data: existing } = await admin
    .from("user_organizations")
    .select("user_id")
    .eq("user_id", userId)
    .eq("organization_id", orgId)
    .maybeSingle();
  if (existing) {
    await admin
      .from("user_organizations")
      .update({ role: "admin", revoked_at: null } as never)
      .eq("user_id", userId)
      .eq("organization_id", orgId);
    console.log("[bootstrap] associação admin garantida");
    return;
  }
  const { error } = await admin.from("user_organizations").insert({
    user_id: userId,
    organization_id: orgId,
    role: "admin",
    accepted_at: new Date().toISOString(),
  } as never);
  if (error) throw new Error(`associação: ${error.message}`);
  console.log("[bootstrap] dono associado como admin");
}

async function ensurePlatformInitialization(ownerId: string): Promise<void> {
  const claimId = randomUUID();
  const { data: reserved, error: claimError } = await admin.rpc("fn_reserve_platform_setup", {
    p_claim_id: claimId,
  });
  if (claimError) throw new Error(`reservar inicialização da plataforma: ${claimError.message}`);
  if (reserved !== true) {
    throw new Error(
      "A plataforma já foi inicializada ou outra sessão reservou o first-run; nenhum dono foi criado.",
    );
  }

  let finalized: boolean | null = null;
  try {
    const { data, error } = await admin.rpc("fn_finalize_platform_setup", {
      p_claim_id: claimId,
      p_user_id: ownerId,
      p_platform_name: ORG_NAME,
      p_request_id: `bootstrap-${randomUUID()}`,
    });
    if (error) throw new Error(error.message);
    finalized = data;
  } catch (cause) {
    const { error: releaseError } = await admin.rpc("fn_release_platform_setup", {
      p_claim_id: claimId,
    });
    if (releaseError) {
      console.warn(
        `[bootstrap] não foi possível liberar a reserva pendente: ${releaseError.message}`,
      );
    }
    throw new Error(
      `finalizar inicialização da plataforma: ${cause instanceof Error ? cause.message : "erro desconhecido"}`,
    );
  }
  if (finalized !== true) {
    throw new Error(
      "O banco recusou a finalização do first-run; a plataforma não foi confirmada como pertencente ao novo usuário.",
    );
  }

  const { data: initialized, error: statusError } = await admin.rpc("fn_platform_initialized");
  if (statusError || initialized !== true) {
    throw new Error(
      `a plataforma continua sem inicialização confirmada: ${statusError?.message ?? "estado inválido"}`,
    );
  }
  console.log("[bootstrap] inicialização da plataforma confirmada");
}

function isLocalAddress(host: string): boolean {
  if (host === "localhost" || host === "127.0.0.1" || host === "::1") return true;
  if (isIP(host) === 4) {
    const [a, b] = host.split(".").map(Number);
    return (
      a === 10 ||
      (a === 172 && b! >= 16 && b! <= 31) ||
      (a === 192 && b === 168) ||
      (a === 169 && b === 254)
    );
  }
  return isIP(host) === 6 && (/^(fc|fd)/i.test(host) || /^fe[89ab]/i.test(host));
}

async function finalizeExistingOwner(): Promise<void> {
  if (!OWNER_EMAIL) throw new Error("Informe OWNER_EMAIL para localizar o dono existente.");
  const localPortsPath = path.join(process.cwd(), ".clientix-local", "supabase-ports");
  if (!fs.existsSync(localPortsPath)) {
    throw new Error("A configuração local do Supabase não foi encontrada.");
  }
  const apiPort = fs.readFileSync(localPortsPath, "utf8").match(/^API=(\d+)$/m)?.[1];
  const target = new URL(SUPABASE_URL!);
  const host = target.hostname.replace(/^\[|\]$/g, "");
  if (target.protocol !== "http:" || !apiPort || target.port !== apiPort || !isLocalAddress(host)) {
    throw new Error(
      "A finalização recusou um destino que não corresponde ao Supabase desta máquina.",
    );
  }

  const databaseUrl = env.SUPABASE_DB_ADMIN_URL;
  const databasePort = fs.readFileSync(localPortsPath, "utf8").match(/^DB=(\d+)$/m)?.[1];
  if (!databaseUrl || !databasePort) {
    throw new Error("A URL administrativa ou a porta do Postgres local não está configurada.");
  }
  const dbTarget = new URL(databaseUrl);
  const dbHost = dbTarget.hostname.replace(/^\[|\]$/g, "");
  if (
    !["postgres:", "postgresql:"].includes(dbTarget.protocol) ||
    dbTarget.port !== databasePort ||
    dbTarget.pathname !== "/postgres" ||
    !(isLocalAddress(dbHost) || dbHost === "host.docker.internal")
  ) {
    throw new Error(
      "A recuperação recusou um banco que não corresponde ao Postgres local desta máquina.",
    );
  }
  // O arquivo .env.local usa host.docker.internal para os containers. Este
  // processo roda no host, então aponta para o loopback da porta já validada.
  if (dbHost === "host.docker.internal") dbTarget.hostname = "127.0.0.1";

  const pool = new Pool({ connectionString: dbTarget.toString(), max: 1 });
  let connection: Awaited<ReturnType<typeof pool.connect>> | null = null;
  try {
    connection = await pool.connect();
    await connection.query("BEGIN");
    const settings = await connection.query<{
      initialized_at: Date | string | null;
      initialized_by: string | null;
    }>(
      "SELECT initialized_at, initialized_by FROM public.platform_settings WHERE id = 1 FOR UPDATE",
    );
    const platformSettings = settings.rows[0];
    if (!platformSettings?.initialized_at || platformSettings.initialized_by !== null) {
      throw new Error("A instalação não é um first-run legado selado pela migration 9062.");
    }

    const users = await connection.query<{ id: string }>(
      "SELECT id FROM auth.users WHERE lower(email) = lower($1) ORDER BY id LIMIT 2 FOR UPDATE",
      [OWNER_EMAIL],
    );
    if (users.rows.length !== 1) {
      throw new Error("O e-mail informado não corresponde a um único usuário Auth local.");
    }
    const ownerId = users.rows[0]!.id;

    const grants = await connection.query<{
      user_id: string;
      platform_role: string;
      reason: string;
      scope: string;
      mfa_required: boolean;
      granted_by: string;
    }>(
      "SELECT user_id, platform_role, reason, scope, mfa_required, granted_by FROM public.platform_admins WHERE revoked_at IS NULL FOR UPDATE",
    );
    const existingOwner = grants.rows.find(
      (grant) => grant.user_id === ownerId && grant.platform_role === "owner",
    );
    if (existingOwner && grants.rows.length === 1) {
      await connection.query("COMMIT");
      console.log("[bootstrap] esta conta já é o único Platform Owner ativo; nada foi alterado");
      return;
    }

    const legacyGrant = grants.rows.length === 1 ? grants.rows[0] : null;
    if (
      !legacyGrant ||
      legacyGrant.user_id !== ownerId ||
      legacyGrant.platform_role !== "admin" ||
      legacyGrant.reason !== "Bootstrap inicial do self-host (dono da instância)" ||
      legacyGrant.scope !== "full" ||
      legacyGrant.mfa_required !== false ||
      legacyGrant.granted_by !== ownerId
    ) {
      throw new Error(
        "Não encontrei exatamente o grant legado do bootstrap; nenhum papel foi alterado.",
      );
    }

    const promoted = await connection.query(
      "UPDATE public.platform_admins SET platform_role = 'owner', reason = 'Bootstrap inicial do self-host (dono corrigido)' WHERE user_id = $1 AND platform_role = 'admin' AND revoked_at IS NULL",
      [ownerId],
    );
    if (promoted.rowCount !== 1) {
      throw new Error("O grant legado mudou durante a recuperação; nenhum papel foi alterado.");
    }
    const ownerRecorded = await connection.query(
      "UPDATE public.platform_settings SET initialized_by = $1 WHERE id = 1 AND initialized_at IS NOT NULL AND initialized_by IS NULL",
      [ownerId],
    );
    if (ownerRecorded.rowCount !== 1) {
      throw new Error("O proprietário legado não pôde ser associado à inicialização preservada.");
    }
    await connection.query(
      `INSERT INTO public.api_audit_log (
         actor_user_id, acting_as_platform_admin, action, resource_type,
         resource_id, request_id, bypassed_rls, metadata
       ) VALUES ($1, true, 'platform_owner.recovered', 'platform_owner', $1, $2, true,
         '{"origin":"bootstrap_repair","previous_platform_role":"admin"}'::jsonb)`,
      [ownerId, `bootstrap-repair-${randomUUID()}`],
    );
    await connection.query("COMMIT");
    console.log("[bootstrap] dono local legado promovido a Platform Owner com auditoria atômica");
  } catch (error) {
    if (connection) await connection.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    connection?.release();
    await pool.end();
  }
}

async function assertBootstrapState(): Promise<boolean> {
  const { data: initialized, error: statusError } = await admin.rpc("fn_platform_initialized");
  if (statusError) throw new Error(`consultar estado de first-run: ${statusError.message}`);
  if (initialized !== true && initialized !== false) {
    throw new Error("O banco não retornou um estado de first-run válido.");
  }

  const { data: activeGrants, error: grantsError } = await admin
    .from("platform_admins")
    .select("user_id, platform_role, reason")
    .is("revoked_at", null);
  if (grantsError) throw new Error(`consultar grants globais: ${grantsError.message}`);
  const grants = activeGrants ?? [];

  if (!initialized) {
    if (grants.length > 0) {
      throw new Error(
        "O first-run ainda consta incompleto, mas já existe Platform Admin ativo; nenhum usuário ou senha foi alterado.",
      );
    }
    return false;
  }

  const { data: users, error: usersError } = await admin.auth.admin.listUsers({ perPage: 200 });
  if (usersError) throw new Error(`consultar o dono existente: ${usersError.message}`);
  const existingUser = users.users.find(
    (user) => user.email?.toLowerCase() === OWNER_EMAIL!.toLowerCase(),
  );
  const grant = existingUser ? grants.find((item) => item.user_id === existingUser.id) : undefined;
  if (grant?.platform_role === "owner") return true;

  if (
    existingUser &&
    grants.length === 1 &&
    grant?.platform_role === "admin" &&
    grant.reason === "Bootstrap inicial do self-host (dono da instância)"
  ) {
    throw new Error(
      "Esta instalação local foi criada pelo bootstrap antigo e ainda não tem Platform Owner. Rode novamente com --finalize-existing-owner para reparar somente esse grant local legado.",
    );
  }
  throw new Error(
    "A plataforma já foi inicializada, mas o e-mail informado não corresponde a um Platform Owner ativo; nenhum usuário ou senha foi alterado.",
  );
}

async function main(): Promise<void> {
  if (FINALIZE_EXISTING_OWNER) {
    await finalizeExistingOwner();
    return;
  }

  const alreadyInitialized = await assertBootstrapState();
  const ownerId = await ensureOwnerUser();
  if (alreadyInitialized) {
    console.log(
      "[bootstrap] esta instalação já tem Platform Owner; a senha foi atualizada e nenhum tenant foi alterado",
    );
    return;
  }

  const orgId = await ensureOrg(ownerId);
  await ensureMembership(ownerId, orgId);
  await ensurePlatformInitialization(ownerId);
  console.log(
    `\n✅ Bootstrap completo.\n  dono: ${OWNER_EMAIL}\n  org:  ${orgId}\n  Faça login em ${env.NEXT_PUBLIC_APP_URL || "https://<seu-dominio>"} e conclua o onboarding.`,
  );
}

main().catch((err) => {
  console.error("❌ Bootstrap falhou:", err);
  process.exit(1);
});
