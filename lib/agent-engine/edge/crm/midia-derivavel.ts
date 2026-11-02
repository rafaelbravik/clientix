/**
 * Consulta canônica da mídia de uma conversa que ainda está sendo derivada.
 * O drain e um turno já em andamento usam a mesma regra para evitar que uma
 * ponta espere por um estado que a outra não reconhece.
 */
import type pg from 'pg';

import { DERIVACAO_TERMINADA, TIPOS_DERIVAVEIS } from '@/lib/messaging/media/derivable';

export interface MidiaDerivavelPendente {
  type: string;
  status: string | null;
  quando: string;
}

function instanteDeChegada(quando: unknown): number | null {
  if (typeof quando === 'string') {
    const ms = new Date(quando).getTime();
    return Number.isFinite(ms) ? ms : null;
  }
  if (quando instanceof Date) {
    const ms = quando.getTime();
    return Number.isFinite(ms) ? ms : null;
  }
  return null;
}

function ehPendente(m: {
  type?: unknown;
  media_derived_status?: unknown;
  quando?: unknown;
}): boolean {
  if (typeof m.type !== 'string' || !TIPOS_DERIVAVEIS.has(m.type)) return false;
  if (DERIVACAO_TERMINADA.has(typeof m.media_derived_status === 'string' ? m.media_derived_status : '')) {
    return false;
  }
  return instanteDeChegada(m.quando) !== null;
}

export async function midiaDerivavelPendente(
  pool: pg.Pool,
  input: { organizationId: string; conversationId: string },
): Promise<MidiaDerivavelPendente | null> {
  const { rows } = await pool.query<{
    type: string;
    media_derived_status: string | null;
    quando: string | Date;
  }>(
    `select type, media_derived_status, created_at as quando
       from messages
      where organization_id = $1
        and conversation_id = $2
        and direction = 'inbound'
        and type = any($3::text[])
        and media_url is not null
      order by created_at desc
      limit 20`,
    [input.organizationId, input.conversationId, [...TIPOS_DERIVAVEIS]],
  );
  const pendente = rows.find(ehPendente);
  if (pendente === undefined) return null;
  const emMs = instanteDeChegada(pendente.quando);
  if (emMs === null) return null;
  return {
    type: pendente.type,
    status: pendente.media_derived_status ?? null,
    quando: new Date(emMs).toISOString(),
  };
}
