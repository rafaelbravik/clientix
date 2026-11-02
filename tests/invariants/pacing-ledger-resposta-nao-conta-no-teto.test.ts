import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { decidePacing } from '@/lib/agent-engine/pacing/engine';
import { PACING_DEFAULTS } from '@/lib/agent-engine/pacing/defaults';
import { loadPacingState, recordSend } from '@/lib/agent-engine/pacing/store';

if (!process.env.TEST_DB_CONTAINER) throw new Error('rode via pnpm test:db');

const pool = new pg.Pool({
  host: '127.0.0.1',
  port: Number(process.env.TEST_DB_PORT ?? 54329),
  user: 'postgres',
  password: 'postgres',
  database: 'postgres',
  max: 2,
});

const orgA = randomUUID();
const orgB = randomUUID();
const sessionA = randomUUID();
const sessionB = randomUUID();
const NOW = new Date('2026-07-28T13:00:00Z');
const TIMEZONE = 'America/Sao_Paulo';

beforeAll(async () => {
  for (const org of [orgA, orgB]) {
    await pool.query(
      `insert into organizations(id,slug,legal_name,display_name,timezone)
       values($1::uuid,$1::text,'Pacing test','Pacing test',$2)`,
      [org, TIMEZONE],
    );
  }
  await pool.query(
    `insert into channel_sessions(id,organization_id,provider,waha_session_name,status,webhook_secret_encrypted)
     values($1,$2,'waha','pacing-a','WORKING','\\x00'::bytea),
           ($3,$4,'waha','pacing-b','WORKING','\\x00'::bytea)`,
    [sessionA, orgA, sessionB, orgB],
  );
});

afterAll(() => pool.end());

async function state(organizationId: string, channelSessionId: string) {
  return loadPacingState(pool, organizationId, channelSessionId, {
    now: NOW,
    timezone: TIMEZONE,
    numberActivatedAt: null,
  });
}

describe('pacing_ledger e teto diário (9061)', () => {
  it('tem marca booleana false por padrão para linhas antigas e novos escritores', async () => {
    const { rows } = await pool.query(
      `select data_type, column_default, is_nullable
         from information_schema.columns
        where table_schema = 'public' and table_name = 'pacing_ledger' and column_name = 'resposta'`,
    );
    expect(rows).toEqual([{ data_type: 'boolean', column_default: 'false', is_nullable: 'NO' }]);
  });

  it('migration 9061 atualiza o schema 9059 e preserva linhas existentes como disparos', async () => {
    const oldSend = new Date(NOW.getTime() - 60_000);
    await pool.query(
      `insert into pacing_ledger (organization_id, channel_session_id, sent_at)
       values ($1, $2, $3)`,
      [orgA, sessionA, oldSend],
    );
    // O banco nasce do baseline 9061; remover só a coluna nova reproduz a forma
    // 9059 sem tocar em dados ou objetos de outras waves.
    await pool.query('alter table public.pacing_ledger drop column resposta');
    const migration = readFileSync(
      'supabase/migrations/20261102153625_9061_pacing_reply_daily_cap.sql',
      'utf8',
    );
    await pool.query(migration);

    const { rows } = await pool.query(
      `select resposta from pacing_ledger
        where organization_id = $1 and channel_session_id = $2 and sent_at = $3`,
      [orgA, sessionA, oldSend],
    );
    expect(rows).toEqual([{ resposta: false }]);
    await pool.query(
      `delete from pacing_ledger
        where organization_id = $1 and channel_session_id = $2 and sent_at = $3`,
      [orgA, sessionA, oldSend],
    );
  });

  it('resposta não consome cap, segue como último envio e não mistura organizações', async () => {
    const dispatchA = new Date(NOW.getTime() - 50 * 60_000);
    const responseA = new Date(NOW.getTime() - 10 * 60_000);
    const dispatchB = new Date(NOW.getTime() - 5 * 60_000);
    await recordSend(pool, orgA, sessionA, dispatchA);
    await recordSend(pool, orgA, sessionA, responseA, { resposta: true });
    await recordSend(pool, orgB, sessionB, dispatchB);

    const [a, b] = await Promise.all([state(orgA, sessionA), state(orgB, sessionB)]);
    expect(a?.sentToday).toBe(1);
    expect(a?.lastSentAt?.getTime()).toBe(responseA.getTime());
    expect(b?.sentToday).toBe(1);
    expect(b?.lastSentAt?.getTime()).toBe(dispatchB.getTime());
  });

  it('cap barra disparo e libera resposta', async () => {
    for (let index = 0; index < 20; index += 1) {
      await recordSend(pool, orgA, sessionA, new Date(NOW.getTime() - (index + 1) * 60_000));
    }
    const current = await state(orgA, sessionA);
    const base = {
      now: NOW,
      knobs: PACING_DEFAULTS,
      state: current,
      crmDailyLimit: null,
      rng: () => 0,
    };
    expect(decidePacing(base).allow).toBe(false);
    expect(decidePacing({ ...base, resposta: true }).allow).toBe(true);
  });
});
