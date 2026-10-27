import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import pg from "pg";

const port = Number(process.env.TEST_DB_PORT ?? 54329);
const pool = new pg.Pool({
  connectionString: `postgresql://postgres:postgres@127.0.0.1:${port}/postgres`,
  max: 4,
});

const ORG_A = "dddddddd-0000-4000-8000-000000000001";
const ORG_B = "dddddddd-0000-4000-8000-000000000011";
const CONTACT_A = "dddddddd-0000-4000-8000-000000000002";
const CONTACT_B = "dddddddd-0000-4000-8000-000000000012";
const SESSION_A = "dddddddd-0000-4000-8000-000000000003";
const SESSION_B = "dddddddd-0000-4000-8000-000000000013";
const CONV_A = "dddddddd-0000-4000-8000-000000000004";
const CONV_B = "dddddddd-0000-4000-8000-000000000014";
const ADMIN_A = "dddddddd-0000-4000-8000-000000000005";
const CASE_IDS = Array.from({ length: 10 }, (_, index) =>
  `dddddddd-0000-4000-8000-${String(index + 101).padStart(12, "0")}`,
);

async function seedTenant(org: string, contact: string, session: string, conversation: string) {
  const suffix = org.slice(-4);
  await pool.query(
    `insert into organizations (id, slug, legal_name, display_name, settings)
     values ($1, $2, 'Org de Lembretes', 'Org de Lembretes', '{"keep_me":"yes"}'::jsonb)
     on conflict (id) do nothing`,
    [org, `wait-reminders-${suffix}`],
  );
  await pool.query(
    `insert into contacts (id, organization_id, name, phone_number)
     values ($1, $2, 'Contato Sintético', $3) on conflict (id) do nothing`,
    [contact, org, `+55119999${suffix}`],
  );
  await pool.query(
    `insert into channel_sessions (id, organization_id, waha_session_name, status, webhook_secret_encrypted)
     values ($1, $2, $3, 'WORKING', '\\x00'::bytea) on conflict (id) do nothing`,
    [session, org, `wait-reminders-session-${suffix}`],
  );
  await pool.query(
    `insert into conversations (id, organization_id, contact_id, channel_session_id, status, is_group)
     values ($1, $2, $3, $4, 'ai_handling', false) on conflict (id) do nothing`,
    [conversation, org, contact, session],
  );
}

async function seedCase(id: string, org = ORG_A, conversation = CONV_A, followupAttempts = 0) {
  await pool.query(
    `insert into agent_cases (id, organization_id, conversation_id, status, title, summary, blocker, followup_attempts)
     values ($1, $2, $3, 'awaiting_human', 'Caso sintético', 'Resumo sintético', 'Bloqueio sintético', $4)`,
    [id, org, conversation, followupAttempts],
  );
}

async function config(org: string, value: { enabled: boolean; interval_hours: number; limit: number }) {
  await pool.query(
    `update organizations
        set settings = jsonb_set(coalesce(settings, '{}'::jsonb), '{case_wait_reminders}', $2::jsonb, true)
      where id = $1`,
    [org, JSON.stringify(value)],
  );
}

async function tornarVencido(id: string, horas: number, enviados = 0) {
  await pool.query(
    `update agent_cases
        set case_wait_started_at = clock_timestamp() - ($2 * interval '1 hour'),
            case_wait_reminders_sent = $3
      where id = $1`,
    [id, horas, enviados],
  );
}

async function claim(db: pg.Pool | pg.PoolClient = pool) {
  const { rows } = await db.query("select * from public.fn_claim_case_wait_reminders(200)");
  return rows[0] as { examinados: number; avisados: number; ja_avisados: number };
}

beforeAll(async () => {
  await seedTenant(ORG_A, CONTACT_A, SESSION_A, CONV_A);
  await seedTenant(ORG_B, CONTACT_B, SESSION_B, CONV_B);
  await pool.query(
    `insert into auth.users (id, email) values ($1, 'admin-wait-reminders@invariant.test') on conflict (id) do nothing`,
    [ADMIN_A],
  );
  await pool.query(
    `insert into user_organizations (user_id, organization_id, role, accepted_at)
     values ($1, $2, 'admin', now()) on conflict do nothing`,
    [ADMIN_A, ORG_A],
  );
});

beforeEach(async () => {
  // Este arquivo compartilha um banco entre os oito casos. Cada claim varre
  // todos os tenants; limpar só as fixtures sintéticas evita que um aviso
  // aberto de um teste vire candidato observado pelo seguinte.
  await pool.query(
    `delete from agent_inbox_items where kind='case_stale' and ref_id = any($1::uuid[])`,
    [CASE_IDS],
  );
  await pool.query(`delete from agent_cases where id = any($1::uuid[])`, [CASE_IDS]);
  await config(ORG_A, { enabled: true, interval_hours: 24, limit: 3 });
  await config(ORG_B, { enabled: true, interval_hours: 24, limit: 3 });
});

afterAll(async () => pool.end());

describe("0522 · lembretes por espera humana", () => {
  it("abre um novo relógio em cada entrada em awaiting_human e preserva a métrica histórica", async () => {
    const id = "dddddddd-0000-4000-8000-000000000101";
    await seedCase(id, ORG_A, CONV_A, 7);
    const first = await pool.query(
      `select case_wait_started_at, case_wait_reminders_sent, followup_attempts from agent_cases where id=$1`,
      [id],
    );
    expect(first.rows[0].case_wait_started_at).toBeInstanceOf(Date);
    expect(first.rows[0]).toMatchObject({ case_wait_reminders_sent: 0, followup_attempts: 7 });

    await tornarVencido(id, 42, 2);
    const priorClock = (await pool.query(`select case_wait_started_at from agent_cases where id=$1`, [id])).rows[0]
      .case_wait_started_at as Date;
    await pool.query(`update agent_cases set status='awaiting_lead' where id=$1`, [id]);
    expect((await pool.query(`select case_wait_started_at, case_wait_reminders_sent from agent_cases where id=$1`, [id])).rows[0])
      .toMatchObject({ case_wait_started_at: null, case_wait_reminders_sent: 0 });

    await pool.query(`update agent_cases set status='awaiting_human' where id=$1`, [id]);
    const fresh = (await pool.query(
      `select case_wait_started_at, case_wait_reminders_sent, followup_attempts from agent_cases where id=$1`,
      [id],
    )).rows[0];
    expect(fresh.case_wait_started_at.getTime()).toBeGreaterThan(priorClock.getTime());
    expect(fresh).toMatchObject({ case_wait_reminders_sent: 0, followup_attempts: 7 });
  });

  it("usa o padrão de 24h, abre um único aviso e avança o contador por espera", async () => {
    const id = "dddddddd-0000-4000-8000-000000000102";
    await config(ORG_A, { enabled: true, interval_hours: 24, limit: 3 });
    await seedCase(id);
    await tornarVencido(id, 25);

    expect(await claim()).toEqual({ examinados: 1, avisados: 1, ja_avisados: 0 });
    const caseRow = (await pool.query(
      `select case_wait_reminders_sent, followup_attempts from agent_cases where id=$1`,
      [id],
    )).rows[0];
    expect(caseRow).toEqual({ case_wait_reminders_sent: 1, followup_attempts: 1 });
    const notice = await pool.query(
      `select organization_id, kind, ref_kind, ref_id, severity, title
         from agent_inbox_items where ref_id=$1 and kind='case_stale' and status='open'`,
      [id],
    );
    expect(notice.rows).toHaveLength(1);
    expect(notice.rows[0]).toMatchObject({
      organization_id: ORG_A,
      kind: "case_stale",
      ref_kind: "agent_case",
      ref_id: id,
      severity: "warn",
    });

    expect(await claim()).toEqual({ examinados: 0, avisados: 0, ja_avisados: 0 });
  });

  it("não abre outro aviso enquanto o aviso atual segue aberto", async () => {
    const id = "dddddddd-0000-4000-8000-000000000103";
    await seedCase(id);
    await tornarVencido(id, 50, 1);
    await pool.query(
      `insert into agent_inbox_items (organization_id, kind, severity, title, ref_kind, ref_id)
       values ($1, 'case_stale', 'warn', 'Aviso aberto', 'agent_case', $2)`,
      [ORG_A, id],
    );
    expect(await claim()).toEqual({ examinados: 1, avisados: 0, ja_avisados: 1 });
    expect((await pool.query(`select case_wait_reminders_sent, followup_attempts from agent_cases where id=$1`, [id])).rows[0])
      .toEqual({ case_wait_reminders_sent: 1, followup_attempts: 0 });
  });

  it("respeita intervalo, limite e pausa por organização", async () => {
    const noIntervalo = "dddddddd-0000-4000-8000-000000000104";
    const noLimite = "dddddddd-0000-4000-8000-000000000105";
    const desativado = "dddddddd-0000-4000-8000-000000000106";

    await config(ORG_A, { enabled: true, interval_hours: 12, limit: 2 });
    await seedCase(noIntervalo);
    await tornarVencido(noIntervalo, 11);
    expect(await claim()).toEqual({ examinados: 0, avisados: 0, ja_avisados: 0 });
    await tornarVencido(noIntervalo, 13);
    expect(await claim()).toEqual({ examinados: 1, avisados: 1, ja_avisados: 0 });

    await seedCase(noLimite);
    await tornarVencido(noLimite, 40, 2);
    expect(await claim()).toEqual({ examinados: 0, avisados: 0, ja_avisados: 0 });

    await config(ORG_A, { enabled: false, interval_hours: 12, limit: 2 });
    await seedCase(desativado);
    await tornarVencido(desativado, 40);
    expect(await claim()).toEqual({ examinados: 0, avisados: 0, ja_avisados: 0 });
  });

  it("aplica a configuração de cada organização somente aos seus casos", async () => {
    const pausado = "dddddddd-0000-4000-8000-000000000109";
    const habilitado = "dddddddd-0000-4000-8000-000000000110";
    await config(ORG_A, { enabled: false, interval_hours: 1, limit: 3 });
    await config(ORG_B, { enabled: true, interval_hours: 1, limit: 3 });
    await seedCase(pausado, ORG_A, CONV_A);
    await seedCase(habilitado, ORG_B, CONV_B);
    await tornarVencido(pausado, 2);
    await tornarVencido(habilitado, 2);

    expect(await claim()).toEqual({ examinados: 1, avisados: 1, ja_avisados: 0 });
    const { rows } = await pool.query(
      `select organization_id, ref_id from agent_inbox_items
        where kind='case_stale' and ref_id = any($1::uuid[])`,
      [[pausado, habilitado]],
    );
    expect(rows).toEqual([{ organization_id: ORG_B, ref_id: habilitado }]);
  });

  it("faz claim concorrente com exatamente um vencedor", async () => {
    const id = "dddddddd-0000-4000-8000-000000000107";
    await config(ORG_A, { enabled: true, interval_hours: 1, limit: 3 });
    await seedCase(id);
    await tornarVencido(id, 2);

    const workerA = await pool.connect();
    const workerB = await pool.connect();
    try {
      await workerA.query("begin");
      const claimA = await claim(workerA);
      const claimB = await claim(workerB);
      await workerA.query("commit");

      expect(claimA).toEqual({ examinados: 1, avisados: 1, ja_avisados: 0 });
      expect(claimB).toEqual({ examinados: 0, avisados: 0, ja_avisados: 0 });
      expect((await pool.query(
        `select count(*)::int as count from agent_inbox_items where organization_id=$1 and ref_id=$2 and kind='case_stale'`,
        [ORG_A, id],
      )).rows[0].count).toBe(1);
    } finally {
      await workerA.query("rollback").catch(() => undefined);
      workerA.release();
      workerB.release();
    }
  });

  it("atualiza settings com autorização do banco e preserva chaves irmãs", async () => {
    const result = await pool.query(
      `select public.fn_definir_case_wait_reminder_config($1, $2, false, 8, 4) as affected`,
      [ORG_A, ADMIN_A],
    );
    expect(result.rows[0].affected).toBe(1);
    const settings = (await pool.query(`select settings from organizations where id=$1`, [ORG_A])).rows[0].settings;
    expect(settings).toMatchObject({
      keep_me: "yes",
      case_wait_reminders: { enabled: false, interval_hours: 8, limit: 4 },
    });

    await expect(pool.query(
      `select public.fn_definir_case_wait_reminder_config($1, $2, true, 24, 3)`,
      [ORG_B, ADMIN_A],
    )).rejects.toMatchObject({ code: "42501" });
    await expect(pool.query(
      `select public.fn_definir_case_wait_reminder_config($1, $2, true, 169, 3)`,
      [ORG_A, ADMIN_A],
    )).rejects.toMatchObject({ code: "22023" });
    await expect(pool.query(
      `select public.fn_definir_case_wait_reminder_config($1, $2, true, null, 3)`,
      [ORG_A, ADMIN_A],
    )).rejects.toMatchObject({ code: "22023" });
  });

  it("reserva RPCs de claim e configuração ao service_role", async () => {
    const { rows } = await pool.query(`
      select
        has_function_privilege('anon', 'public.fn_claim_case_wait_reminders(integer)', 'EXECUTE') as anon_claim,
        has_function_privilege('authenticated', 'public.fn_claim_case_wait_reminders(integer)', 'EXECUTE') as auth_claim,
        has_function_privilege('service_role', 'public.fn_claim_case_wait_reminders(integer)', 'EXECUTE') as service_claim,
        has_function_privilege('authenticated', 'public.fn_definir_case_wait_reminder_config(uuid,uuid,boolean,integer,integer)', 'EXECUTE') as auth_config,
        has_function_privilege('service_role', 'public.fn_definir_case_wait_reminder_config(uuid,uuid,boolean,integer,integer)', 'EXECUTE') as service_config
    `);
    expect(rows[0]).toEqual({ anon_claim: false, auth_claim: false, service_claim: true, auth_config: false, service_config: true });
  });

  it("só service_role executa o claim legítimo", async () => {
    const id = "dddddddd-0000-4000-8000-000000000108";
    await config(ORG_A, { enabled: true, interval_hours: 1, limit: 3 });
    await seedCase(id);
    await tornarVencido(id, 2);
    const client = await pool.connect();
    try {
      await client.query("set role service_role");
      expect(await claim(client)).toEqual({ examinados: 1, avisados: 1, ja_avisados: 0 });
    } finally {
      await client.query("reset role");
      client.release();
    }
  });
});
