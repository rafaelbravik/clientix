import type { SiteAuditResult } from "./site-classify";
import { auditWebsite } from "./site-fetch";
import { ProspectingError } from "./provider";

type QueryResult<Row> = { rows: Row[]; rowCount?: number | null };
export type SiteCandidateQuery = {
  query<Row = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<QueryResult<Row>>;
};

export function preserveDefinitiveSiteResult(
  previous: SiteAuditResult | null,
  next: SiteAuditResult,
): SiteAuditResult {
  if (previous && !previous.provisorio && next.provisorio) {
    return { ...previous, ultima_tentativa: next };
  }
  return next;
}

export async function reanalyzeCandidateSite(
  db: SiteCandidateQuery,
  organizationId: string,
  candidateId: string,
  options: { audit?: typeof auditWebsite; now?: () => Date } = {},
): Promise<{ site: SiteAuditResult; data: Record<string, unknown> }> {
  const candidate = (
    await db.query<{ data: Record<string, unknown> | null }>(
      "select data from prospecting_candidates where organization_id=$1 and id=$2 limit 1",
      [organizationId, candidateId],
    )
  ).rows[0];
  if (!candidate)
    throw new ProspectingError("Empresa não encontrada nesta organização.", 404, "candidato", "candidate_not_found");

  const data = candidate.data && typeof candidate.data === "object" ? candidate.data : {};
  const website = typeof data.website === "string" ? data.website : null;
  const next = await (options.audit ?? auditWebsite)(website, (options.now ?? (() => new Date()))().toISOString());
  const previous = data.site && typeof data.site === "object" ? (data.site as SiteAuditResult) : null;
  const persisted = preserveDefinitiveSiteResult(previous, next);
  const updated = (
    await db.query<{ data: Record<string, unknown> }>(
      `update prospecting_candidates
          set data = case
            when jsonb_typeof(data->'site')='object'
             and coalesce(data->'site'->>'provisorio','false')='false'
             and $3::jsonb->>'provisorio'='true'
            then jsonb_set(coalesce(data,'{}'::jsonb),'{site,ultima_tentativa}',$3::jsonb,true)
            else jsonb_set(coalesce(data,'{}'::jsonb),'{site}',$3::jsonb,true)
          end,
          updated_at=now()
        where organization_id=$1 and id=$2 and data->>'website' is not distinct from $4
        returning data`,
      [organizationId, candidateId, JSON.stringify(next), website],
    )
  ).rows[0];
  if (!updated) throw new ProspectingError("Empresa não encontrada nesta organização.", 404, "candidato", "candidate_not_found");
  // The SQL CASE repeats the preservation atomically against the latest row. This
  // projection also makes the operation's response deterministic in unit tests.
  const storedSite = (updated.data.site as SiteAuditResult | undefined) ?? persisted;
  return { site: storedSite, data: updated.data };
}
