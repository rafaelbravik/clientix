import { describe, expect, it, vi } from 'vitest';
import type pg from 'pg';

import { esperarMidiaDerivavel } from './espera-da-midia';

const organizationId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const conversationId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

describe('esperarMidiaDerivavel', () => {
  it('aguarda a derivação dentro do teto e limita a consulta à organização e conversa', async () => {
    const inicio = Date.parse('2026-11-02T12:00:00.000Z');
    let agora = inicio + 1_000;
    let consultas = 0;
    const query = vi.fn(async (_sql: string, values: unknown[]) => {
      consultas += 1;
      expect(values).toEqual([organizationId, conversationId, ['audio', 'image', 'document', 'video']]);
      return {
        rows:
          consultas === 1
            ? [{ type: 'audio', media_derived_status: 'pending', quando: new Date(inicio).toISOString() }]
            : [],
      };
    });
    const dormir = vi.fn(async (ms: number) => {
      agora += ms;
    });

    const resultado = await esperarMidiaDerivavel({ query } as unknown as pg.Pool, {
      organizationId,
      conversationId,
      prazoAteMs: inicio + 10_000,
      agoraMs: () => agora,
      dormir,
    });

    expect(resultado).toBe('derivacao_concluida');
    expect(consultas).toBe(2);
    expect(dormir).toHaveBeenCalledTimes(1);
  });

  it('não espera quando não há mídia pendente', async () => {
    const query = vi.fn(async () => ({ rows: [] }));
    const dormir = vi.fn(async () => undefined);

    await expect(
      esperarMidiaDerivavel({ query } as unknown as pg.Pool, {
        organizationId,
        conversationId,
        prazoAteMs: Date.now() + 10_000,
        dormir,
      }),
    ).resolves.toBe('sem_midia_pendente');
    expect(dormir).not.toHaveBeenCalled();
  });

  it('encerra no teto de 120 segundos sem uma nova espera', async () => {
    const inicio = Date.parse('2026-11-02T12:00:00.000Z');
    const query = vi.fn(async () => ({
      rows: [{ type: 'image', media_derived_status: 'pending', quando: new Date(inicio).toISOString() }],
    }));
    const dormir = vi.fn(async () => undefined);

    await expect(
      esperarMidiaDerivavel({ query } as unknown as pg.Pool, {
        organizationId,
        conversationId,
        prazoAteMs: inicio + 130_000,
        agoraMs: () => inicio + 120_001,
        dormir,
      }),
    ).resolves.toBe('teto_da_espera');
    expect(dormir).not.toHaveBeenCalled();
  });
});
