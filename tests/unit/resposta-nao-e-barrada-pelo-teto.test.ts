import { describe, expect, it, vi } from 'vitest';

import { decidePacing } from '@/lib/agent-engine/pacing/engine';
import { PACING_DEFAULTS } from '@/lib/agent-engine/pacing/defaults';
import { loadPacingState, recordSend } from '@/lib/agent-engine/pacing/store';
import type { Queryable } from '@/lib/agent-engine/queue/queue';

const COMERCIAL = new Date('2026-07-28T13:00:00Z'); // 10h em São Paulo, terça

function input(overrides: {
  resposta?: boolean;
  sentToday?: number;
  lastSentAt?: Date | null;
  minimumIntervalMs?: number;
}) {
  return {
    now: COMERCIAL,
    knobs: PACING_DEFAULTS,
    resposta: overrides.resposta,
    state: {
      lastSentAt: overrides.lastSentAt ?? null,
      sentToday: overrides.sentToday ?? 0,
      numberActivatedAt: null,
    },
    crmDailyLimit: null,
    minimumIntervalMs: overrides.minimumIntervalMs,
    rng: () => 0,
  };
}

describe('resposta e teto diário de disparos (9061)', () => {
  it('mantém o teto para disparos normais', () => {
    const decision = decidePacing(input({ sentToday: 20 }));
    expect(decision.allow).toBe(false);
    if (!decision.allow) expect(decision.code).toBe('warmup_cap');
  });

  it('resposta não consome nem é barrada pelo teto, mas mantém o espaçamento', () => {
    const decision = decidePacing(
      input({
        resposta: true,
        sentToday: 999,
        lastSentAt: new Date(COMERCIAL.getTime() - 200),
        minimumIntervalMs: PACING_DEFAULTS.throttleMs + 500,
      }),
    );
    expect(decision).toEqual({
      allow: true,
      waitMs: PACING_DEFAULTS.throttleMs + 500 - 200,
    });
  });

  it('envio sem marca de resposta continua sujeito ao teto', () => {
    const decision = decidePacing(input({ sentToday: 20 }));
    expect(decision.allow).toBe(false);
    if (!decision.allow) expect(decision.code).toBe('warmup_cap');
  });
});

describe('ledger de pacing (9061)', () => {
  it('conta somente disparos e mantém filtro por organização e sessão', async () => {
    const query = vi.fn().mockResolvedValue({
      rows: [{ last_sent_at: COMERCIAL, sent_today: '2' }],
    });
    const db = { query } as unknown as Queryable;

    const state = await loadPacingState(db, 'org-a', 'session-a', {
      now: COMERCIAL,
      timezone: 'America/Sao_Paulo',
      numberActivatedAt: null,
    });

    expect(state.sentToday).toBe(2);
    expect(query).toHaveBeenCalledOnce();
    expect(query.mock.calls[0]?.[0]).toContain('where organization_id = $1 and channel_session_id = $2');
    expect(query.mock.calls[0]?.[0]).toContain('and not resposta');
    expect(query.mock.calls[0]?.[1]).toEqual(['org-a', 'session-a', expect.any(Date)]);
  });

  it('grava a marca de resposta explicitamente sem alterar os filtros de tenant', async () => {
    const query = vi.fn().mockResolvedValue({ rows: [] });
    const db = { query } as unknown as Queryable;
    const sentAt = new Date('2026-07-28T13:00:00Z');

    await recordSend(db, 'org-a', 'session-a', sentAt, { resposta: true });

    expect(query.mock.calls[0]?.[0]).toContain('organization_id, channel_session_id, sent_at, resposta');
    expect(query.mock.calls[0]?.[1]).toEqual(['org-a', 'session-a', sentAt, true]);
  });
});
