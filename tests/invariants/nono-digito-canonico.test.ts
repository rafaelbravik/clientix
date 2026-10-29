import { afterAll, beforeAll, describe, expect, it } from "vitest";
import pg from "pg";

/**
 * Celular BR com e sem o nono dígito é a MESMA pessoa.
 *
 * `+553284793302` (12) e `+5532984793302` (13) — o CRM grava a forma COM o 9
 * e reencontra a grafia antiga. Fixo não ganha 9.
 */
const container = process.env.TEST_DB_CONTAINER;
if (!container) {
  throw new Error("TEST_DB_CONTAINER not set — rode via `pnpm test:db` (scripts/test-db.sh)");
}

const PORT = Number(process.env.TEST_DB_PORT ?? 54329);
const pool = new pg.Pool({
  connectionString: `postgresql://postgres:postgres@127.0.0.1:${PORT}/postgres`,
  max: 3,
});

const ORG = "c0169000-0000-4000-8000-000000000001";
const ORG_B = "c0169000-0000-4000-8000-000000000002";

async function upsert(
  phone: string | null,
  lid: string | null,
  chatId: string | null,
  notify: string | null = null,
  organizationId = ORG,
): Promise<string> {
  const { rows } = await pool.query<{ fn_upsert_wa_contact: string }>(
    "select public.fn_upsert_wa_contact($1, $2, $3, $4, $5, $6)",
    [organizationId, lid ? "lid" : "phone", phone, lid, chatId, notify],
  );
  return rows[0]!.fn_upsert_wa_contact;
}

beforeAll(async () => {
  await pool.query(
    `insert into organizations (id, slug, legal_name, display_name)
     values ($1, 'org-nono-digito', 'Nono LTDA', 'Nono') on conflict (id) do nothing`,
    [ORG],
  );
  await pool.query(
    `insert into organizations (id, slug, legal_name, display_name)
     values ($1, 'org-nono-digito-b', 'Nono B LTDA', 'Nono B') on conflict (id) do nothing`,
    [ORG_B],
  );
});

afterAll(async () => {
  await pool.query("delete from organizations where id = $1", [ORG_B]);
  await pool.query("delete from organizations where id = $1", [ORG]);
  await pool.end();
});

describe("fn_upsert_wa_contact — nono dígito canônico", () => {
  it("grava o celular de 12 dígitos COM o 9", async () => {
    const id = await upsert("+553284793301", null, "553284793301@c.us");
    const { rows } = await pool.query<{ phone_number: string }>(
      "select phone_number from contacts where id = $1",
      [id],
    );
    expect(rows[0]!.phone_number).toBe("+5532984793301");
  });

  it("reencontra o cadastro de 13 dígitos quando o WhatsApp manda sem o 9", async () => {
    const primeiro = await upsert("+5531998966398", null, "5531998966398@c.us");
    const segundo = await upsert("+553198966398", null, "553198966398@c.us");
    expect(segundo).toBe(primeiro);
    const { rows } = await pool.query<{ n: string }>(
      "select count(*)::text as n from contacts where organization_id = $1 and is_merged_into is null and phone_number in ('+553198966398','+5531998966398')",
      [ORG],
    );
    expect(rows[0]!.n).toBe("1");
  });

  it("vários eventos simultâneos da mesma identidade convergem para um único contato", async () => {
    const ids = await Promise.all(
      Array.from({ length: 6 }, () => upsert("+15551234567", null, "15551234567@c.us")),
    );
    expect(new Set(ids).size).toBe(1);
    const { rows } = await pool.query<{ n: string }>(
      "select count(*)::text as n from contacts where organization_id = $1 and is_merged_into is null and phone_number = '+15551234567'",
      [ORG],
    );
    expect(rows[0]!.n).toBe("1");
  });

  it("preserva campos internos quando uma integração sincroniza o contato existente", async () => {
    const id = await upsert("+15551234569", null, null, "Nome vindo do app");
    const consent = { marketing: { granted_at: "2026-10-29T12:00:00Z", source: "manual" } };
    await pool.query(
      `update contacts
       set display_name = 'Nome interno', name = 'Nome manual', tags = array['cliente'],
           is_blocked = true, blocked_reason = 'opt-out', force_human = true,
           consent = $2::jsonb
       where id = $1 and organization_id = $3`,
      [id, JSON.stringify(consent), ORG],
    );

    const updatedId = await upsert("+15551234569", null, null, "Nome atualizado do app");
    const { rows } = await pool.query<{
      display_name: string;
      name: string;
      tags: string[];
      is_blocked: boolean;
      blocked_reason: string;
      force_human: boolean;
      consent: typeof consent;
    }>(
      `select display_name, name, tags, is_blocked, blocked_reason, force_human, consent
       from contacts where id = $1 and organization_id = $2`,
      [id, ORG],
    );

    expect(updatedId).toBe(id);
    expect(rows[0]).toMatchObject({
      display_name: "Nome interno",
      name: "Nome manual",
      tags: ["cliente"],
      is_blocked: true,
      blocked_reason: "opt-out",
      force_human: true,
      consent,
    });
  });

  it("mantém a mesma identidade telefônica isolada entre organizações", async () => {
    const phone = "+15551234570";
    const orgAContact = await upsert(phone, null, null, "Contato A", ORG);
    const orgBContact = await upsert(phone, null, null, "Contato B", ORG_B);
    const { rows } = await pool.query<{ organization_id: string; id: string }>(
      `select organization_id, id from contacts
       where organization_id in ($1, $2) and phone_number = $3 and is_merged_into is null
       order by organization_id`,
      [ORG, ORG_B, phone],
    );

    expect(orgAContact).not.toBe(orgBContact);
    expect(rows).toHaveLength(2);
    expect(new Set(rows.map((row) => row.organization_id))).toEqual(new Set([ORG, ORG_B]));
    expect(new Set(rows.map((row) => row.id))).toEqual(new Set([orgAContact, orgBContact]));
  });

  it("fixo NÃO ganha 9", async () => {
    const id = await upsert("+553132345678", null, "553132345678@c.us");
    const { rows } = await pool.query<{ phone_number: string }>(
      "select phone_number from contacts where id = $1",
      [id],
    );
    expect(rows[0]!.phone_number).toBe("+553132345678");
  });
});
