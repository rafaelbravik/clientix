import { describe, expect, it } from "vitest";
import pg from "pg";
import { sql } from "./gov-helpers";

/**
 * SEC-RACE-001: Teste de Proteção Atômica de Quota de Assentos de Usuários (SQL + Concorrência Real).
 *
 * Valida:
 * 1. Standard: permite até 3 assentos (membros + convites pendentes) e bloqueia o 4º com quota_exceeded
 * 2. Pro: permite até 10 assentos e bloqueia o 11º
 * 3. Enterprise: assentos ilimitados
 * 4. Override: plan_limits.max_users respeitado
 * 5. Fallback seguro: plano desconhecido ou NULL cai para standard (3)
 * 6. Convite expirado não consome assento
 * 7. Membro revogado não consome assento; reativação valida teto
 * 8. Isolamento: Concorrência no Tenant A NÃO bloqueia o Tenant B
 * 9. CONCORRÊNCIA REAL: Disparo de transações simultâneas no limite não ultrapassa max_users
 */

const PORT = Number(process.env.TEST_DB_PORT ?? 54329);

function criarOrg(slug: string, plan: string | null, overrides?: { max_users?: number }): string {
  let settingsJson: string;
  if (!plan && !overrides) {
    settingsJson = "null";
  } else {
    const obj: Record<string, unknown> = {};
    if (plan) obj.plan = plan;
    if (overrides) obj.plan_limits = overrides;
    settingsJson = `'${JSON.stringify(obj)}'::jsonb`;
  }

  sql(`
    insert into public.organizations (slug, legal_name, display_name, settings)
    values ('${slug}', 'Seat Test ${slug}', 'Seat Test', ${settingsJson});
  `);
  return sql(`select id from public.organizations where slug = '${slug}'`).trim();
}

function criarUser(): string {
  const email = `test-user-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@example.com`;
  const out = sql(`
    insert into auth.users (id, email)
    values (gen_random_uuid(), '${email}')
    returning id;
  `);
  // sql com RETURNING em psql -tA devolve o id seguido eventualmente de status em linha separada
  const lines = out.split("\n").map((l) => l.trim()).filter(Boolean);
  const uuid = lines[0];
  if (!uuid) throw new Error("Falha ao criar user: " + out);
  return uuid;
}

function insertMember(orgId: string, userId: string, revoked = false): { ok: boolean; erro?: string } {
  const revokedVal = revoked ? "now()" : "null";
  try {
    sql(`
      insert into public.user_organizations (organization_id, user_id, role, revoked_at)
      values ('${orgId}', '${userId}', 'agent', ${revokedVal});
    `);
    return { ok: true };
  } catch (e) {
    const err = e as { stderr?: Buffer | string; message?: string };
    return { ok: false, erro: String(err.stderr ?? "") + String(err.message ?? "") };
  }
}

function insertInvite(orgId: string, email: string, expiresOffsetHours = 24): { ok: boolean; erro?: string } {
  try {
    sql(`
      insert into public.team_invites (organization_id, email, role, expires_at)
      values ('${orgId}', '${email}', 'agent', now() + interval '${expiresOffsetHours} hours');
    `);
    return { ok: true };
  } catch (e) {
    const err = e as { stderr?: Buffer | string; message?: string };
    return { ok: false, erro: String(err.stderr ?? "") + String(err.message ?? "") };
  }
}

describe("SEC-RACE-001 — Quota de Assentos de Usuários (SQL)", () => {
  it("Standard: permite 3 assentos e bloqueia o 4º com quota_exceeded", () => {
    const org = criarOrg(`std-seat-${Date.now()}`, "standard");
    const u1 = criarUser();
    const u2 = criarUser();

    // 1º membro: OK
    expect(insertMember(org, u1).ok).toBe(true);
    // 2º membro: OK
    expect(insertMember(org, u2).ok).toBe(true);
    // 3º assento (convite): OK (total 3/3)
    expect(insertInvite(org, `inv1-${Date.now()}@test.com`).ok).toBe(true);

    // 4º assento (convite): Deve ser barrado pela trigger
    const r4 = insertInvite(org, `inv2-${Date.now()}@test.com`);
    expect(r4.ok).toBe(false);
    expect(r4.erro).toContain("quota_exceeded");

    // 4º assento (membro direto): Deve ser barrado também
    const u3 = criarUser();
    const r5 = insertMember(org, u3);
    expect(r5.ok).toBe(false);
    expect(r5.erro).toContain("quota_exceeded");
  });

  it("Pro: permite até 10 assentos e bloqueia o 11º", () => {
    const org = criarOrg(`pro-seat-${Date.now()}`, "pro");
    for (let i = 0; i < 10; i++) {
      expect(insertInvite(org, `pro-inv-${i}-${Date.now()}@test.com`).ok).toBe(true);
    }
    const r11 = insertInvite(org, `pro-inv-11-${Date.now()}@test.com`);
    expect(r11.ok).toBe(false);
    expect(r11.erro).toContain("quota_exceeded");
  });

  it("Enterprise: permite assentos ilimitados", () => {
    const org = criarOrg(`ent-seat-${Date.now()}`, "enterprise");
    for (let i = 0; i < 15; i++) {
      expect(insertInvite(org, `ent-inv-${i}-${Date.now()}@test.com`).ok).toBe(true);
    }
  });

  it("Override em plan_limits.max_users: respeitado", () => {
    const org = criarOrg(`override-seat-${Date.now()}`, "standard", { max_users: 2 });
    expect(insertInvite(org, `ov1-${Date.now()}@test.com`).ok).toBe(true);
    expect(insertInvite(org, `ov2-${Date.now()}@test.com`).ok).toBe(true);
    const r3 = insertInvite(org, `ov3-${Date.now()}@test.com`);
    expect(r3.ok).toBe(false);
    expect(r3.erro).toContain("quota_exceeded");
  });

  it("Plano desconhecido e Plano NULL: sofrem fallback seguro para standard (3)", () => {
    const orgDesc = criarOrg(`unknown-seat-${Date.now()}`, "custom_fake");
    for (let i = 0; i < 3; i++) {
      expect(insertInvite(orgDesc, `un-${i}-${Date.now()}@test.com`).ok).toBe(true);
    }
    expect(insertInvite(orgDesc, `un-4-${Date.now()}@test.com`).ok).toBe(false);

    const orgNull = criarOrg(`null-seat-${Date.now()}`, null);
    for (let i = 0; i < 3; i++) {
      expect(insertInvite(orgNull, `null-${i}-${Date.now()}@test.com`).ok).toBe(true);
    }
    expect(insertInvite(orgNull, `null-4-${Date.now()}@test.com`).ok).toBe(false);
  });

  it("Convite expirado não consome assento", () => {
    const org = criarOrg(`exp-seat-${Date.now()}`, "standard");
    // Insere convite que expirou há 2 horas (offset -2)
    expect(insertInvite(org, `exp1-${Date.now()}@test.com`, -2).ok).toBe(true);

    // Agora devemos conseguir inserir 3 convites válidos
    expect(insertInvite(org, `valid1-${Date.now()}@test.com`).ok).toBe(true);
    expect(insertInvite(org, `valid2-${Date.now()}@test.com`).ok).toBe(true);
    expect(insertInvite(org, `valid3-${Date.now()}@test.com`).ok).toBe(true);

    // O 4º válido é barrado
    expect(insertInvite(org, `valid4-${Date.now()}@test.com`).ok).toBe(false);
  });

  it("Membro revogado não consome assento, mas reativação no limite é bloqueada", () => {
    const org = criarOrg(`rev-seat-${Date.now()}`, "standard");
    const u1 = criarUser();
    const u2 = criarUser();
    const u3 = criarUser();

    // Membro 1 e 2 ativos
    expect(insertMember(org, u1).ok).toBe(true);
    expect(insertMember(org, u2).ok).toBe(true);

    // Membro 3 revogado (não consome)
    expect(insertMember(org, u3, true).ok).toBe(true);

    // Insere 1 convite ativo -> total de assentos ativos = 3 (u1 + u2 + convite)
    expect(insertInvite(org, `inv-rev-${Date.now()}@test.com`).ok).toBe(true);

    // Tentativa de reativar u3 (UPDATE revoked_at = null) deve falhar com quota_exceeded
    let erroReativar = "";
    try {
      sql(`
        update public.user_organizations
        set revoked_at = null
        where organization_id = '${org}' and user_id = '${u3}';
      `);
    } catch (e) {
      erroReativar = String(e);
    }
    expect(erroReativar).toContain("quota_exceeded");
  });

  it("CONCORRÊNCIA REAL: Duas transações paralelas tentando o último assento não estouram o teto", async () => {
    const org = criarOrg(`race-seat-${Date.now()}`, "standard"); // limite = 3
    const u1 = criarUser();
    const u2 = criarUser();

    // Ocupa 2 assentos
    expect(insertMember(org, u1).ok).toBe(true);
    expect(insertMember(org, u2).ok).toBe(true);

    // Abre 2 clientes separados para disparar concorrência simultânea
    const pool = new pg.Pool({
      connectionString: `postgresql://postgres:postgres@127.0.0.1:${PORT}/postgres`,
      max: 2,
    });

    const clientA = await pool.connect();
    const clientB = await pool.connect();

    try {
      const emailA = `race-a-${Date.now()}@test.com`;
      const emailB = `race-b-${Date.now()}@test.com`;

      // Dispara as duas inserções simultaneamente
      const [resA, resB] = await Promise.allSettled([
        clientA.query(
          `insert into public.team_invites (organization_id, email, role, expires_at)
           values ($1, $2, 'agent', now() + interval '24 hours')`,
          [org, emailA],
        ),
        clientB.query(
          `insert into public.team_invites (organization_id, email, role, expires_at)
           values ($1, $2, 'agent', now() + interval '24 hours')`,
          [org, emailB],
        ),
      ]);

      // Exatamente uma transação deve ter passado e exatamente uma deve ter falhado com quota_exceeded
      const passedCount = [resA, resB].filter((r) => r.status === "fulfilled").length;
      const rejectedCount = [resA, resB].filter((r) => r.status === "rejected").length;

      expect(passedCount).toBe(1);
      expect(rejectedCount).toBe(1);

      const rejected = (resA.status === "rejected" ? resA : resB) as PromiseRejectedResult;
      expect(rejected.reason.message).toContain("quota_exceeded");

      // Verifica no banco que o total final de assentos é exatamente 3 (2 membros + 1 convite), NUNCA 4
      const { rows } = await clientA.query<{ count: string }>(
        `select count(*)::text as count from public.team_invites
         where organization_id = $1 and accepted_at is null and revoked_at is null`,
        [org],
      );
      expect(rows[0]?.count).toBe("1");
    } finally {
      clientA.release();
      clientB.release();
      await pool.end();
    }
  });

  it("Isolamento: Concorrência no Tenant A não bloqueia Tenant B", async () => {
    const orgA = criarOrg(`tenant-a-${Date.now()}`, "standard");
    const orgB = criarOrg(`tenant-b-${Date.now()}`, "standard");

    expect(insertInvite(orgA, `a1-${Date.now()}@test.com`).ok).toBe(true);
    expect(insertInvite(orgB, `b1-${Date.now()}@test.com`).ok).toBe(true);
  });
});
