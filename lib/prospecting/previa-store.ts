import type pg from "pg";
import { ProspectingError } from "./provider";
import type { LinhaParaPrevia } from "./previa-gerar";
import type { PreviaSalva } from "./previa";

export async function carregarCandidatoParaPrevia(
  db: Pick<pg.Pool, "query">,
  organizationId: string,
  candidateId: string,
): Promise<LinhaParaPrevia> {
  const { rows } = await db.query<LinhaParaPrevia>(
    `select p.id,p.campaign_id,p.data,p.status,p.contact_id,c.config,c.search
       from prospecting_candidates p
       join prospecting_campaigns c
         on c.organization_id=p.organization_id and c.id=p.campaign_id
      where p.organization_id=$1 and p.id=$2
      limit 1`,
    [organizationId, candidateId],
  );
  const candidate = rows[0];
  if (!candidate) {
    throw new ProspectingError("Empresa não encontrada nesta organização.", 404, "candidato", "candidate_not_found");
  }
  return candidate;
}

export async function salvarPreviaDoCandidato(
  db: Pick<pg.Pool, "query">,
  args: {
    organizationId: string;
    campaignId: string;
    candidateId: string;
    expectedWebsite: string | null;
    expectedSiteJson: string | null;
    previa: PreviaSalva;
  },
): Promise<void> {
  const { rows } = await db.query<{ id: string }>(
    `update prospecting_candidates
        set data = coalesce(data,'{}'::jsonb) || jsonb_build_object('previa',$6::jsonb),
            updated_at=now()
      where organization_id=$1 and campaign_id=$2 and id=$3
        and status in ('new','queued')
        and data->>'website' is not distinct from $4
        and data->'site' is not distinct from $5::jsonb
      returning id`,
    [
      args.organizationId,
      args.campaignId,
      args.candidateId,
      args.expectedWebsite,
      args.expectedSiteJson,
      JSON.stringify(args.previa),
    ],
  );
  if (!rows.length) {
    throw new ProspectingError(
      "A auditoria mudou enquanto a prévia era gerada. Atualize a tela e gere novamente.",
      409,
      "candidato",
      "preview_source_changed",
    );
  }
}

/** A PostgreSQL session lock prevents double-clicks across app instances. */
export async function withPreviewCandidateLock<T>(
  pool: pg.Pool,
  organizationId: string,
  candidateId: string,
  fn: () => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  const key = `prospecting-preview:${organizationId}:${candidateId}`;
  let locked = false;
  try {
    locked =
      (await client.query<{ locked: boolean }>(
        "select pg_try_advisory_lock(hashtextextended($1,0)) as locked",
        [key],
      )).rows[0]?.locked === true;
    if (!locked) {
      throw new ProspectingError(
        "Uma prévia desta empresa já está sendo gerada. Aguarde alguns segundos.",
        409,
        "candidato",
        "preview_generation_in_progress",
      );
    }
    return await fn();
  } finally {
    try {
      if (locked) {
        await client.query("select pg_advisory_unlock(hashtextextended($1,0))", [key]);
      }
    } finally {
      client.release();
    }
  }
}
