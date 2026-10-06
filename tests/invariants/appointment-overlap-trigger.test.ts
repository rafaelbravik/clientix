import { describe, expect, it } from "vitest";
import pg from "pg";
import { sql } from "./gov-helpers";

/**
 * CAL-001: Teste de Proteção Atômica Contra Sobreposição Parcial na Agenda (Postgres Real).
 *
 * Valida:
 * 1. Eventos adjacentes (14:00-14:30 e 14:30-15:00) são PERMITIDOS [starts_at, ends_at).
 * 2. Sobreposição parcial (14:00-14:30 e 14:15-14:45) é BLOQUEADA com agenda_horario_indisponivel (23P01).
 * 3. Mesma janela exata (14:00-14:30 e 14:00-14:30) é BLOQUEADA.
 * 4. Mesma janela para OWNERS DIFERENTES no mesmo tenant é PERMITIDA.
 * 5. Mesma janela para TENANTS DIFERENTES é PERMITIDA (multi-tenant isolado).
 * 6. Evento cancelado ('cancelled') ou falta ('no_show') LIBERA o horário; novo agendamento passa.
 * 7. Remarcação (UPDATE starts_at/ends_at) para slot livre é PERMITIDA.
 * 8. Remarcação (UPDATE) para slot ocupado por outro evento é BLOQUEADA.
 * 9. Período inválido (ends_at <= starts_at) é BLOQUEADO.
 * 10. CONCORRÊNCIA REAL: Duas transações simultâneas tentando reservar janelas sobrepostas para o mesmo dono resultam em 1 COMMIT e 1 ERRO.
 */

const PORT = Number(process.env.TEST_DB_PORT ?? 54329);

function criarOrg(slug: string): string {
  sql(`
    insert into public.organizations (slug, legal_name, display_name)
    values ('${slug}', 'Calendar Test ${slug}', 'Calendar Test');
  `);
  return sql(`select id from public.organizations where slug = '${slug}'`).trim();
}

function criarUser(): string {
  const email = `cal-user-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@example.com`;
  const out = sql(`
    insert into auth.users (id, email)
    values (gen_random_uuid(), '${email}')
    returning id;
  `);
  const lines = out.split("\n").map((l) => l.trim()).filter(Boolean);
  return lines[0]!;
}

function insertAppointment(params: {
  orgId: string;
  ownerId: string | null;
  startsAt: string;
  endsAt: string;
  status?: string;
  title?: string;
}): { ok: boolean; id?: string; erro?: string } {
  const statusVal = params.status ?? "confirmed";
  const ownerVal = params.ownerId ? `'${params.ownerId}'` : "null";
  const titleVal = params.title ?? "Consulta";
  const cancelledAtVal = statusVal === "cancelled" ? "now()" : "null";
  try {
    const out = sql(`
      insert into public.calendar_appointments (
        organization_id, owner_user_id, starts_at, ends_at, status, title, cancelled_at
      ) values (
        '${params.orgId}', ${ownerVal}, '${params.startsAt}'::timestamptz, '${params.endsAt}'::timestamptz, '${statusVal}', '${titleVal}', ${cancelledAtVal}
      ) returning id;
    `);
    const lines = out.split("\n").map((l) => l.trim()).filter(Boolean);
    return { ok: true, id: lines[0] };
  } catch (e) {
    const err = e as { stderr?: Buffer | string; message?: string };
    return { ok: false, erro: String(err.stderr ?? "") + String(err.message ?? "") };
  }
}

describe("CAL-001 — Proteção Atômica de Sobreposição na Agenda (SQL)", () => {
  it("Eventos adjacentes (14:00-14:30 e 14:30-15:00) são PERMITIDOS", () => {
    const org = criarOrg(`cal-adj-${Date.now()}`);
    const dono = criarUser();

    const r1 = insertAppointment({
      orgId: org,
      ownerId: dono,
      startsAt: "2026-10-10T14:00:00Z",
      endsAt: "2026-10-10T14:30:00Z",
    });
    expect(r1.ok).toBe(true);

    const r2 = insertAppointment({
      orgId: org,
      ownerId: dono,
      startsAt: "2026-10-10T14:30:00Z",
      endsAt: "2026-10-10T15:00:00Z",
    });
    expect(r2.ok).toBe(true);
  });

  it("Sobreposição parcial (14:00-14:30 e 14:15-14:45) é BLOQUEADA", () => {
    const org = criarOrg(`cal-overlap-${Date.now()}`);
    const dono = criarUser();

    const r1 = insertAppointment({
      orgId: org,
      ownerId: dono,
      startsAt: "2026-10-10T14:00:00Z",
      endsAt: "2026-10-10T14:30:00Z",
    });
    expect(r1.ok).toBe(true);

    const r2 = insertAppointment({
      orgId: org,
      ownerId: dono,
      startsAt: "2026-10-10T14:15:00Z",
      endsAt: "2026-10-10T14:45:00Z",
    });
    expect(r2.ok).toBe(false);
    expect(r2.erro).toContain("agenda_horario_indisponivel");
  });

  it("Mesma janela exata para o mesmo dono é BLOQUEADA", () => {
    const org = criarOrg(`cal-exact-${Date.now()}`);
    const dono = criarUser();

    const r1 = insertAppointment({
      orgId: org,
      ownerId: dono,
      startsAt: "2026-10-10T14:00:00Z",
      endsAt: "2026-10-10T14:30:00Z",
    });
    expect(r1.ok).toBe(true);

    const r2 = insertAppointment({
      orgId: org,
      ownerId: dono,
      startsAt: "2026-10-10T14:00:00Z",
      endsAt: "2026-10-10T14:30:00Z",
    });
    expect(r2.ok).toBe(false);
    expect(r2.erro).toContain("agenda_horario_indisponivel");
  });

  it("Mesmo horário para atendentes diferentes na mesma organização é PERMITIDO", () => {
    const org = criarOrg(`cal-owners-${Date.now()}`);
    const dono1 = criarUser();
    const dono2 = criarUser();

    const r1 = insertAppointment({
      orgId: org,
      ownerId: dono1,
      startsAt: "2026-10-10T14:00:00Z",
      endsAt: "2026-10-10T14:30:00Z",
    });
    expect(r1.ok).toBe(true);

    const r2 = insertAppointment({
      orgId: org,
      ownerId: dono2,
      startsAt: "2026-10-10T14:00:00Z",
      endsAt: "2026-10-10T14:30:00Z",
    });
    expect(r2.ok).toBe(true);
  });

  it("Multi-Tenant: Mesmo horário para o mesmo momento em organizações diferentes é PERMITIDO", () => {
    const orgA = criarOrg(`cal-org-a-${Date.now()}`);
    const orgB = criarOrg(`cal-org-b-${Date.now()}`);
    const donoA = criarUser();
    const donoB = criarUser();

    const r1 = insertAppointment({
      orgId: orgA,
      ownerId: donoA,
      startsAt: "2026-10-10T14:00:00Z",
      endsAt: "2026-10-10T14:30:00Z",
    });
    expect(r1.ok).toBe(true);

    const r2 = insertAppointment({
      orgId: orgB,
      ownerId: donoB,
      startsAt: "2026-10-10T14:00:00Z",
      endsAt: "2026-10-10T14:30:00Z",
    });
    expect(r2.ok).toBe(true);
  });

  it("Evento cancelado não bloqueia novo agendamento no mesmo horário", () => {
    const org = criarOrg(`cal-cancelled-${Date.now()}`);
    const dono = criarUser();

    // Insere agendamento cancelado
    const r1 = insertAppointment({
      orgId: org,
      ownerId: dono,
      startsAt: "2026-10-10T14:00:00Z",
      endsAt: "2026-10-10T14:30:00Z",
      status: "cancelled",
    });
    expect(r1.ok).toBe(true);

    // Novo agendamento confirmado no mesmo horário: DEVE PASSAR
    const r2 = insertAppointment({
      orgId: org,
      ownerId: dono,
      startsAt: "2026-10-10T14:00:00Z",
      endsAt: "2026-10-10T14:30:00Z",
      status: "confirmed",
    });
    expect(r2.ok).toBe(true);
  });

  it("Remarcação (UPDATE) para slot livre passa; para slot ocupado bloqueia", () => {
    const org = criarOrg(`cal-resched-${Date.now()}`);
    const dono = criarUser();

    // Evento A: 14:00-14:30
    const a = insertAppointment({
      orgId: org,
      ownerId: dono,
      startsAt: "2026-10-10T14:00:00Z",
      endsAt: "2026-10-10T14:30:00Z",
    });
    expect(a.ok).toBe(true);

    // Evento B: 15:00-15:30
    const b = insertAppointment({
      orgId: org,
      ownerId: dono,
      startsAt: "2026-10-10T15:00:00Z",
      endsAt: "2026-10-10T15:30:00Z",
    });
    expect(b.ok).toBe(true);

    // Tenta remarcar B para 14:15-14:45 (colide com A) -> DEVE BLOQUEAR
    let erroColisao = "";
    try {
      sql(`
        update public.calendar_appointments
        set starts_at = '2026-10-10T14:15:00Z'::timestamptz,
            ends_at   = '2026-10-10T14:45:00Z'::timestamptz
        where id = '${b.id}';
      `);
    } catch (e) {
      erroColisao = String(e);
    }
    expect(erroColisao).toContain("agenda_horario_indisponivel");

    // Remarca B para 16:00-16:30 (livre) -> DEVE PASSAR
    let erroLivre = "";
    try {
      sql(`
        update public.calendar_appointments
        set starts_at = '2026-10-10T16:00:00Z'::timestamptz,
            ends_at   = '2026-10-10T16:30:00Z'::timestamptz
        where id = '${b.id}';
      `);
    } catch (e) {
      erroLivre = String(e);
    }
    expect(erroLivre).toBe("");
  });

  it("Período inválido (ends_at <= starts_at) é BLOQUEADO", () => {
    const org = criarOrg(`cal-invalid-range-${Date.now()}`);
    const dono = criarUser();

    const r = insertAppointment({
      orgId: org,
      ownerId: dono,
      startsAt: "2026-10-10T14:30:00Z",
      endsAt: "2026-10-10T14:00:00Z",
    });
    expect(r.ok).toBe(false);
  });

  it("CONCORRÊNCIA REAL: Duas transações paralelas sobrepostas no mesmo dono resultam em 1 COMMIT e 1 ERRO", async () => {
    const org = criarOrg(`cal-race-${Date.now()}`);
    const dono = criarUser();

    const pool = new pg.Pool({
      connectionString: `postgresql://postgres:postgres@127.0.0.1:${PORT}/postgres`,
      max: 2,
    });

    const clientA = await pool.connect();
    const clientB = await pool.connect();

    try {
      // Dispara 14:00-14:30 e 14:15-14:45 em paralelo
      const [resA, resB] = await Promise.allSettled([
        clientA.query(
          `insert into public.calendar_appointments (
             organization_id, owner_user_id, starts_at, ends_at, status, title
           ) values (
             $1, $2, '2026-10-10T14:00:00Z'::timestamptz, '2026-10-10T14:30:00Z'::timestamptz, 'confirmed', 'A'
           )`,
          [org, dono],
        ),
        clientB.query(
          `insert into public.calendar_appointments (
             organization_id, owner_user_id, starts_at, ends_at, status, title
           ) values (
             $1, $2, '2026-10-10T14:15:00Z'::timestamptz, '2026-10-10T14:45:00Z'::timestamptz, 'confirmed', 'B'
           )`,
          [org, dono],
        ),
      ]);

      const passedCount = [resA, resB].filter((r) => r.status === "fulfilled").length;
      const rejectedCount = [resA, resB].filter((r) => r.status === "rejected").length;

      expect(passedCount).toBe(1);
      expect(rejectedCount).toBe(1);

      const rejected = (resA.status === "rejected" ? resA : resB) as PromiseRejectedResult;
      expect(rejected.reason.message).toContain("agenda_horario_indisponivel");

      // Confere que no banco há EXATAMENTE 1 compromisso gravado
      const { rows } = await clientA.query<{ count: string }>(
        `select count(*)::text as count from public.calendar_appointments
         where organization_id = $1 and owner_user_id = $2 and status in ('pending', 'confirmed')`,
        [org, dono],
      );
      expect(rows[0]?.count).toBe("1");
    } finally {
      clientA.release();
      clientB.release();
      await pool.end();
    }
  });
});
