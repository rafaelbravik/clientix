import type pg from 'pg';

import { TETO_DA_ESPERA_DA_DERIVACAO_MS } from '@/lib/messaging/media/derivable';
import { midiaDerivavelPendente } from '../edge/crm/midia-derivavel';

export const INTERVALO_DA_ESPERA_DA_DERIVACAO_MS = 1_500;

export type ResultadoDaEsperaDaMidia =
  | 'sem_midia_pendente'
  | 'derivacao_concluida'
  | 'teto_da_espera';

export interface OpcoesDaEsperaDaMidia {
  organizationId: string;
  conversationId: string;
  prazoAteMs: number;
  agoraMs?: () => number;
  dormir?: (ms: number) => Promise<void>;
}

function dormir(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Aguarda somente mídia inbound já recebida nesta organização/conversa.
 * O teto é compartilhado com o drain; nenhum dado ou chamada externa é criado.
 */
export async function esperarMidiaDerivavel(
  pool: pg.Pool,
  opcoes: OpcoesDaEsperaDaMidia,
): Promise<ResultadoDaEsperaDaMidia> {
  const agoraMs = opcoes.agoraMs ?? Date.now;
  const dormirMs = opcoes.dormir ?? dormir;
  let encontrouPendente = false;

  while (true) {
    const agora = agoraMs();
    const pendente = await midiaDerivavelPendente(pool, {
      organizationId: opcoes.organizationId,
      conversationId: opcoes.conversationId,
    });

    if (pendente === null) {
      return encontrouPendente ? 'derivacao_concluida' : 'sem_midia_pendente';
    }
    encontrouPendente = true;

    const idadeDaMidia = agora - new Date(pendente.quando).getTime();
    const restanteDaMidia = TETO_DA_ESPERA_DA_DERIVACAO_MS - idadeDaMidia;
    const restanteDoTurno = opcoes.prazoAteMs - agora;
    if (restanteDaMidia <= 0 || restanteDoTurno <= 0) return 'teto_da_espera';

    await dormirMs(
      Math.max(
        1,
        Math.min(INTERVALO_DA_ESPERA_DA_DERIVACAO_MS, restanteDaMidia, restanteDoTurno),
      ),
    );
  }
}
