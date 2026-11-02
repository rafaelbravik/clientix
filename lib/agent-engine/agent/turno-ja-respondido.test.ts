import { expect, it, vi } from 'vitest';
import type pg from 'pg';

import { anotarUltimaInboundVista } from './turno-ja-respondido';

const alvo = {
  organizationId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  contactId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
  conversationId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
  jobId: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
};

it('marca inbound com texto derivado e filtra mídia sem texto no mesmo tenant/conversa', async () => {
  const query = vi.fn(async () => ({ rows: [] }));
  await anotarUltimaInboundVista({ query } as unknown as pg.Pool, alvo, {
    apenasMidiaComTexto: true,
  });

  expect(query).toHaveBeenCalledTimes(1);
  const [sql, values] = query.mock.calls[0] as unknown as [string, unknown[]];
  expect(sql).toContain('m.organization_id = $1');
  expect(sql).toContain('m.conversation_id = $2');
  expect(sql).toContain('m.media_derived_text is not null');
  expect(values).toEqual([
    alvo.organizationId,
    alvo.conversationId,
    alvo.jobId,
    true,
    ['audio', 'image', 'document', 'video'],
  ]);
});
