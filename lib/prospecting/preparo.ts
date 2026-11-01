import type pg from "pg";
import type { SupabaseClient } from "@supabase/supabase-js";
import { logger } from "@/lib/logger";
import { estrategiaDoCandidato } from "./estrategia-site";
import { gerarPreviaDoCandidato } from "./previa-gerar";
import { previaAtual, type PreviaSalva } from "./previa";
import {
  carregarCandidatoParaPrevia,
  salvarPreviaDoCandidato,
  withPreviewCandidateLock,
} from "./previa-store";
import { ProspectingError } from "./provider";
import { reanalyzeCandidateSite } from "./site-store";
import { auditWebsite } from "./site-fetch";
import { sitePreparationOptions } from "./site-options";
import type { SiteAuditResult } from "./site-classify";

/** Per-organization limits keep one large list from monopolizing worker ticks. */
export const PREPARATION_LIMITS = {
  sitesPerRound: 30,
  previewsPerRound: 8,
  modelParallelism: 3,
  siteParallelism: 6,
  organizationDeadlineMs: 100_000,
  siteRetryIntervalMs: 30 * 60_000,
  siteMaxAttempts: 3,
  previewRetryBaseMs: 15 * 60_000,
  previewRetryMaxMs: 6 * 60 * 60_000,
  previewRunningLeaseMs: 10 * 60_000,
  candidatesReadLimit: 1_000,
} as const;

export interface PreparationSummary {
  considered: number;
  sitesAttempted: number;
  sitesCompleted: number;
  previewsAttempted: number;
  previewsCompleted: number;
  failures: number;
  skipped: boolean;
}

type PreparationRow = {
  id: string;
  campaign_id: string;
  data: Record<string, unknown> | null;
  status: string;
  contact_id: string | null;
  config: unknown;
  search: unknown;
  campaign_status: string;
  search_status: string;
  agent_version_id: string | null;
  agent_ready: boolean;
};

type PreparationMeta = {
  site?: { status?: string; attempts?: number; retry_after?: string; code?: string };
  preview?: {
    status?: string;
    attempts?: number;
    retry_after?: string;
    started_at?: string;
    code?: string;
  };
};

type CandidateData = Record<string, unknown> & {
  website?: string | null;
  site?: SiteAuditResult | null;
  previa?: PreviaSalva | null;
  preparacao?: PreparationMeta;
};

const ORG_LOCK = (organizationId: string) => `prospecting:${organizationId}:preparo`;
const CANDIDATE_LOCK = (organizationId: string, candidateId: string) =>
  `prospecting:${organizationId}:preparo:${candidateId}`;

const emptySummary = (): PreparationSummary => ({
  considered: 0,
  sitesAttempted: 0,
  sitesCompleted: 0,
  previewsAttempted: 0,
  previewsCompleted: 0,
  failures: 0,
  skipped: false,
});

function dataRecord(value: unknown): CandidateData {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as CandidateData)
    : {};
}

function safeCode(error: unknown, fallback: string): string {
  const code = error instanceof ProspectingError ? error.code : "";
  return /^[a-z][a-z0-9_]{0,63}$/.test(code) ? code : fallback;
}

function dateFrom(value: unknown): number | null {
  if (typeof value !== "string") return null;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? timestamp : null;
}

function siteNeedsAudit(data: CandidateData, nowMs: number): boolean {
  const site = data.site;
  const state = data.preparacao?.site;
  const attempts = Number.isInteger(state?.attempts)
    ? (state?.attempts ?? 0)
    : site?.provisorio
      ? 1
      : 0;
  if (state?.status === "exhausted" || attempts >= PREPARATION_LIMITS.siteMaxAttempts) return false;
  if (!site) {
    const retryAfter = dateFrom(state?.retry_after);
    return retryAfter === null || retryAfter <= nowMs;
  }
  if (!site.provisorio) return false;
  if (site.motivo === "invalid_url") return false;
  const retryAfter = dateFrom(state?.retry_after);
  if (retryAfter !== null) return retryAfter <= nowMs;
  const checkedAt = dateFrom(site.verificado_em);
  return checkedAt !== null && nowMs - checkedAt >= PREPARATION_LIMITS.siteRetryIntervalMs;
}

function previewBackoffActive(data: CandidateData, nowMs: number): boolean {
  const state = data.preparacao?.preview;
  if (state?.status === "running") {
    const startedAt = dateFrom(state.started_at);
    return startedAt !== null && nowMs - startedAt < PREPARATION_LIMITS.previewRunningLeaseMs;
  }
  if (state?.status !== "error") return false;
  const retryAfter = dateFrom(state.retry_after);
  return retryAfter !== null && retryAfter > nowMs;
}

function nextPreviewRetry(data: CandidateData, now: Date, code: string) {
  const prior = data.preparacao?.preview;
  const attempts = Math.min(
    10,
    (Number.isInteger(prior?.attempts) ? (prior?.attempts ?? 0) : 0) + 1,
  );
  const delay = Math.min(
    PREPARATION_LIMITS.previewRetryMaxMs,
    PREPARATION_LIMITS.previewRetryBaseMs * 2 ** Math.min(attempts - 1, 5),
  );
  return {
    status: "error",
    code,
    attempts,
    attempted_at: now.toISOString(),
    retry_after: new Date(now.getTime() + delay).toISOString(),
  };
}

async function savePreparationMeta(
  db: Pick<pg.Pool, "query">,
  organizationId: string,
  campaignId: string,
  candidateId: string,
  key: "site" | "preview",
  value: Record<string, unknown>,
): Promise<void> {
  await db.query(
    `update prospecting_candidates
        set data=coalesce(data,'{}'::jsonb) || jsonb_build_object(
          'preparacao', coalesce(data->'preparacao','{}'::jsonb) || jsonb_build_object($4::text,$5::jsonb)
        ), updated_at=now()
      where organization_id=$1 and campaign_id=$2 and id=$3`,
    [organizationId, campaignId, candidateId, key, JSON.stringify(value)],
  );
}

async function loadPreparationRow(
  db: Pick<pg.Pool, "query">,
  organizationId: string,
  candidateId: string,
): Promise<PreparationRow> {
  const { rows } = await db.query<PreparationRow>(
    `select p.id,p.campaign_id,p.data,p.status,p.contact_id,c.config,c.search,
            c.status as campaign_status,c.search_status,
            a.published_version_id::text as agent_version_id,
            (a.published_version_id is not null and a.paused_at is null and a.archived_at is null
              and a.operation_mode='automatic') as agent_ready
       from prospecting_candidates p
       join prospecting_campaigns c on c.organization_id=p.organization_id and c.id=p.campaign_id
       left join ai_agents a on a.organization_id=p.organization_id and a.id::text=c.config->>'agent_id'
      where p.organization_id=$1 and p.id=$2
      limit 1`,
    [organizationId, candidateId],
  );
  const row = rows[0];
  if (!row)
    throw new ProspectingError(
      "Empresa não encontrada nesta organização.",
      404,
      "candidato",
      "candidate_not_found",
    );
  return row;
}

async function withSessionLock<T>(
  pool: pg.Pool,
  key: string,
  fn: () => Promise<T>,
  busyMessage: string,
  busyCode: string,
): Promise<T | null> {
  const client = await pool.connect();
  let locked = false;
  let releaseError: Error | undefined;
  try {
    locked =
      (
        await client.query<{ locked: boolean }>(
          "select pg_try_advisory_lock(hashtextextended($1,0)) as locked",
          [key],
        )
      ).rows[0]?.locked === true;
    if (!locked) throw new ProspectingError(busyMessage, 409, "candidato", busyCode);
    return await fn();
  } finally {
    try {
      if (locked) await client.query("select pg_advisory_unlock(hashtextextended($1,0))", [key]);
    } catch (error) {
      releaseError = error instanceof Error ? error : new Error("advisory_unlock_failed");
    }
    client.release(releaseError);
  }
}

async function withCandidatePreparationLock<T>(
  pool: pg.Pool,
  organizationId: string,
  candidateId: string,
  fn: () => Promise<T>,
): Promise<T> {
  try {
    const result = await withSessionLock(
      pool,
      CANDIDATE_LOCK(organizationId, candidateId),
      fn,
      "Esta empresa já está sendo preparada. Aguarde alguns segundos.",
      "candidate_preparation_in_progress",
    );
    if (result === null) throw new Error("candidate_preparation_lock_missing_result");
    return result;
  } catch (error) {
    throw error;
  }
}

export type CandidatePreparationOptions = {
  mode: "worker" | "reanalyze" | "preview";
  autoAudit?: boolean;
  autoPreview?: boolean;
  now?: () => Date;
  auditSite?: typeof auditWebsite;
  generatePreview?: typeof gerarPreviaDoCandidato;
};

export type CandidatePreparationResult = {
  site: SiteAuditResult | null;
  strategy: ReturnType<typeof estrategiaDoCandidato>;
  preview: PreviaSalva | null;
  previewStatus: "ready" | "stale" | "pending" | "error" | "not_available" | "none";
  siteAttempted: boolean;
  previewAttempted: boolean;
};

/** Shared seam for worker preparation and the existing manual site/preview actions. */
export async function prepararCandidato(
  pool: pg.Pool,
  organizationId: string,
  candidateId: string,
  options: CandidatePreparationOptions,
): Promise<CandidatePreparationResult> {
  const nowFn = options.now ?? (() => new Date());
  return withCandidatePreparationLock(pool, organizationId, candidateId, async () => {
    let row = await loadPreparationRow(pool, organizationId, candidateId);
    const workerMode = options.mode === "worker";
    if (
      workerMode &&
      (!["new", "queued"].includes(row.status) ||
        !["draft", "running"].includes(row.campaign_status) ||
        row.search_status !== "succeeded")
    ) {
      return {
        site: dataRecord(row.data).site ?? null,
        strategy: estrategiaDoCandidato(dataRecord(row.data), nowFn().toISOString()),
        preview: null,
        previewStatus: "none",
        siteAttempted: false,
        previewAttempted: false,
      };
    }

    const now = nowFn();
    let data = dataRecord(row.data);
    const preparationOptions = sitePreparationOptions(row.search);
    const forcedSite = options.mode === "reanalyze";
    const shouldAudit =
      forcedSite ||
      (workerMode &&
        options.autoAudit !== false &&
        preparationOptions.avaliarSite &&
        siteNeedsAudit(data, now.getTime()));
    let siteAttempted = false;
    if (shouldAudit) {
      siteAttempted = true;
      const priorSiteState = data.preparacao?.site;
      const priorAttempts = Number.isInteger(priorSiteState?.attempts)
        ? (priorSiteState?.attempts ?? 0)
        : data.site?.provisorio
          ? 1
          : 0;
      try {
        const auditOptions = options.auditSite
          ? { audit: options.auditSite, now: nowFn }
          : { now: nowFn };
        await reanalyzeCandidateSite(pool, organizationId, candidateId, auditOptions);
        row = await loadPreparationRow(pool, organizationId, candidateId);
        data = dataRecord(row.data);
        const site = data.site ?? null;
        if (site?.provisorio) {
          const attempts = priorAttempts + 1;
          const exhausted =
            attempts >= PREPARATION_LIMITS.siteMaxAttempts || site.motivo === "invalid_url";
          await savePreparationMeta(pool, organizationId, row.campaign_id, candidateId, "site", {
            status: exhausted ? "exhausted" : "pending",
            attempts,
            checked_at: site.verificado_em,
            ...(!exhausted
              ? {
                  retry_after: new Date(
                    now.getTime() + PREPARATION_LIMITS.siteRetryIntervalMs,
                  ).toISOString(),
                }
              : {}),
          });
        } else {
          await savePreparationMeta(pool, organizationId, row.campaign_id, candidateId, "site", {
            status: "ready",
            attempts: priorAttempts + 1,
            checked_at: site?.verificado_em ?? now.toISOString(),
          });
        }
      } catch (error) {
        if (error instanceof ProspectingError && error.code === "candidate_not_found") throw error;
        const code = safeCode(error, "site_audit_failed");
        const attempts = priorAttempts + 1;
        await savePreparationMeta(pool, organizationId, row.campaign_id, candidateId, "site", {
          status: attempts >= PREPARATION_LIMITS.siteMaxAttempts ? "exhausted" : "error",
          attempts,
          code,
          ...(attempts < PREPARATION_LIMITS.siteMaxAttempts
            ? {
                retry_after: new Date(
                  now.getTime() + PREPARATION_LIMITS.siteRetryIntervalMs,
                ).toISOString(),
              }
            : {}),
        });
        if (!workerMode) throw error;
      }
    }

    // Refresh after audit: strategy and preview must use the exact persisted result.
    row = await loadPreparationRow(pool, organizationId, candidateId);
    data = dataRecord(row.data);
    const strategy = estrategiaDoCandidato(data, nowFn().toISOString());
    const rawPreview = data.previa;
    const currentPreview = previaAtual(rawPreview, data, row.agent_version_id);
    let previewStatus: CandidatePreparationResult["previewStatus"] = currentPreview
      ? "ready"
      : rawPreview
        ? "stale"
        : data.preparacao?.preview?.status === "error"
          ? "error"
          : data.preparacao?.preview?.status === "not_available"
            ? "not_available"
            : "none";

    const forcedPreview = options.mode === "preview";
    const shouldPreview =
      forcedPreview ||
      (workerMode && options.autoPreview !== false && preparationOptions.gerarPrevia);
    let previewAttempted = false;
    let preview = currentPreview;
    if (
      shouldPreview &&
      (!currentPreview || forcedPreview) &&
      (data.site || !String(data.website ?? "").trim())
    ) {
      if (workerMode && previewBackoffActive(data, nowFn().getTime())) {
        return {
          site: data.site ?? null,
          strategy,
          preview,
          previewStatus,
          siteAttempted,
          previewAttempted,
        };
      }
      if (workerMode && !row.agent_ready) {
        if (data.preparacao?.preview?.status !== "not_available") {
          await savePreparationMeta(pool, organizationId, row.campaign_id, candidateId, "preview", {
            status: "not_available",
            code: "preview_agent_unavailable",
            checked_at: nowFn().toISOString(),
          });
        }
        return {
          site: data.site ?? null,
          strategy,
          preview: null,
          previewStatus: "not_available",
          siteAttempted,
          previewAttempted,
        };
      }
      try {
        previewAttempted = true;
        const generatedAndSaved = await withPreviewCandidateLock(
          pool,
          organizationId,
          candidateId,
          async () => {
            const fresh = await carregarCandidatoParaPrevia(pool, organizationId, candidateId);
            const freshData = dataRecord(fresh.data);
            const freshAgent = await loadPreparationRow(pool, organizationId, candidateId);
            const existing = previaAtual(freshData.previa, freshData, freshAgent.agent_version_id);
            if (existing && workerMode) return existing;
            if (
              workerMode &&
              (!["new", "queued"].includes(fresh.status) ||
                !["draft", "running"].includes(freshAgent.campaign_status))
            )
              return null;
            await savePreparationMeta(
              pool,
              organizationId,
              fresh.campaign_id,
              fresh.id,
              "preview",
              {
                status: "running",
                started_at: nowFn().toISOString(),
              },
            );
            const generated = await (options.generatePreview ?? gerarPreviaDoCandidato)(
              pool,
              organizationId,
              fresh,
              { now: nowFn },
            );
            await salvarPreviaDoCandidato(pool, {
              organizationId,
              campaignId: fresh.campaign_id,
              candidateId: fresh.id,
              expectedWebsite: typeof freshData.website === "string" ? freshData.website : null,
              expectedSiteJson:
                freshData.site === undefined ? null : JSON.stringify(freshData.site),
              previa: generated.previa,
            });
            await savePreparationMeta(
              pool,
              organizationId,
              fresh.campaign_id,
              fresh.id,
              "preview",
              {
                status: "ready",
                checked_at: nowFn().toISOString(),
              },
            );
            return generated.previa;
          },
        );
        preview = generatedAndSaved;
      } catch (error) {
        if (error instanceof ProspectingError && error.code === "candidate_not_found") throw error;
        if (error instanceof ProspectingError && error.code === "preview_generation_in_progress") {
          return {
            site: data.site ?? null,
            strategy,
            preview: null,
            previewStatus,
            siteAttempted,
            previewAttempted: false,
          };
        }
        if (
          error instanceof ProspectingError &&
          (error.code === "candidate_preparation_in_progress" ||
            error.code === "preview_generation_in_progress")
        ) {
          return {
            site: data.site ?? null,
            strategy,
            preview: null,
            previewStatus,
            siteAttempted,
            previewAttempted: false,
          };
        }
        if (
          error instanceof ProspectingError &&
          error.code === "preview_agent_unavailable" &&
          workerMode
        ) {
          await savePreparationMeta(pool, organizationId, row.campaign_id, candidateId, "preview", {
            status: "not_available",
            code: "preview_agent_unavailable",
            checked_at: nowFn().toISOString(),
          });
          return {
            site: data.site ?? null,
            strategy,
            preview: null,
            previewStatus: "not_available",
            siteAttempted,
            previewAttempted,
          };
        }
        const code = safeCode(error, "preview_generation_failed");
        await savePreparationMeta(
          pool,
          organizationId,
          row.campaign_id,
          candidateId,
          "preview",
          nextPreviewRetry(data, nowFn(), code),
        );
        previewStatus = "error";
        if (!workerMode) throw error;
      }
    }

    const finalStatus = preview ? "ready" : previewStatus;
    return {
      site: data.site ?? null,
      strategy,
      preview,
      previewStatus: finalStatus,
      siteAttempted,
      previewAttempted,
    };
  });
}

async function loadRowsForOrganization(
  db: Pick<pg.Pool, "query">,
  organizationId: string,
): Promise<PreparationRow[]> {
  const { rows } = await db.query<PreparationRow>(
    `select p.id,p.campaign_id,p.data,p.status,p.contact_id,c.config,c.search,
            c.status as campaign_status,c.search_status,
            a.published_version_id::text as agent_version_id,
            (a.published_version_id is not null and a.paused_at is null and a.archived_at is null
              and a.operation_mode='automatic') as agent_ready
       from prospecting_candidates p
       join prospecting_campaigns c on c.organization_id=p.organization_id and c.id=p.campaign_id
       left join ai_agents a on a.organization_id=p.organization_id and a.id::text=c.config->>'agent_id'
      where p.organization_id=$1 and p.status in ('new','queued')
        and c.organization_id=$1 and c.status in ('draft','running') and c.search_status='succeeded'
      order by c.created_at desc,p.updated_at,p.id
      limit $2`,
    [organizationId, PREPARATION_LIMITS.candidatesReadLimit],
  );
  return rows;
}

async function withConcurrency<T>(
  items: readonly T[],
  limit: number,
  run: (item: T) => Promise<void>,
): Promise<void> {
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (;;) {
      const index = next++;
      const item = items[index];
      if (item === undefined) return;
      await run(item);
    }
  });
  const results = await Promise.allSettled(workers);
  const failure = results.find((result) => result.status === "rejected");
  if (failure?.status === "rejected") throw failure.reason;
}

async function prepareOrganizationLocked(
  pool: pg.Pool,
  organizationId: string,
  deadline: number,
  prepareCandidate: typeof prepararCandidato = prepararCandidato,
  clock: () => number = Date.now,
): Promise<PreparationSummary> {
  const summary = emptySummary();
  const now = new Date();
  let rows = await loadRowsForOrganization(pool, organizationId);
  summary.considered = rows.length;

  const siteTasks = rows
    .filter(
      (row) =>
        sitePreparationOptions(row.search).avaliarSite &&
        siteNeedsAudit(dataRecord(row.data), now.getTime()),
    )
    .slice(0, PREPARATION_LIMITS.sitesPerRound);
  await withConcurrency(siteTasks, PREPARATION_LIMITS.siteParallelism, async (row) => {
    if (clock() >= deadline) return;
    try {
      const result = await prepareCandidate(pool, organizationId, row.id, {
        mode: "worker",
        autoPreview: false,
      });
      if (result.siteAttempted) summary.sitesAttempted++;
      if (result.siteAttempted && result.site) summary.sitesCompleted++;
    } catch (error) {
      if (error instanceof ProspectingError && error.code === "candidate_preparation_in_progress")
        return;
      if (error instanceof ProspectingError && error.code === "candidate_not_found") throw error;
      summary.sitesAttempted++;
      summary.failures++;
      logger.warn("[prospecting.preparo] auditoria de candidato falhou", {
        organization_id: organizationId,
        candidate_id: row.id,
        error: safeCode(error, "site_audit_failed"),
      });
    }
  });

  if (clock() >= deadline) return summary;
  rows = await loadRowsForOrganization(pool, organizationId);
  const nowMs = Date.now();
  const previewTasks = rows
    .filter((row) => {
      const data = dataRecord(row.data);
      if (!sitePreparationOptions(row.search).gerarPrevia) return false;
      if (data.preparacao?.preview?.status === "not_available" && !row.agent_ready) return false;
      if (!data.site && String(data.website ?? "").trim()) return false;
      if (previaAtual(data.previa, data, row.agent_version_id)) return false;
      if (previewBackoffActive(data, nowMs)) return false;
      return true;
    })
    .slice(0, PREPARATION_LIMITS.previewsPerRound);
  let failureStreak = 0;
  for (
    let offset = 0;
    offset < previewTasks.length && failureStreak < 3 && clock() < deadline;
    offset += PREPARATION_LIMITS.modelParallelism
  ) {
    const batch = previewTasks.slice(offset, offset + PREPARATION_LIMITS.modelParallelism);
    await withConcurrency(batch, PREPARATION_LIMITS.modelParallelism, async (row) => {
      if (clock() >= deadline) return;
      try {
        const result = await prepareCandidate(pool, organizationId, row.id, {
          mode: "worker",
          autoAudit: false,
        });
        if (result.previewAttempted) summary.previewsAttempted++;
        if (result.previewAttempted && result.preview) summary.previewsCompleted++;
        if (result.previewStatus === "error") failureStreak++;
      } catch (error) {
        if (error instanceof ProspectingError && error.code === "candidate_preparation_in_progress")
          return;
        if (error instanceof ProspectingError && error.code === "candidate_not_found") throw error;
        summary.failures++;
        summary.previewsAttempted++;
        failureStreak++;
        logger.warn("[prospecting.preparo] prévia de candidato falhou", {
          organization_id: organizationId,
          candidate_id: row.id,
          error: safeCode(error, "preview_generation_failed"),
        });
      }
    });
  }
  return summary;
}

/** Automatic preparation runs outside the send/search lock and has its own org lease. */
export async function prepararCandidatos(
  pool: pg.Pool,
  _admin: SupabaseClient,
  organizationId: string,
  requestId: string,
  deadline = Date.now() + PREPARATION_LIMITS.organizationDeadlineMs,
  dependencies: { prepareCandidate?: typeof prepararCandidato; now?: () => number } = {},
): Promise<PreparationSummary> {
  const summary = emptySummary();
  let locked = false;
  const client = await pool.connect();
  let releaseError: Error | undefined;
  try {
    locked =
      (
        await client.query<{ locked: boolean }>(
          "select pg_try_advisory_lock(hashtextextended($1,0)) as locked",
          [ORG_LOCK(organizationId)],
        )
      ).rows[0]?.locked === true;
    if (!locked) return { ...summary, skipped: true };
    const result = await prepareOrganizationLocked(
      pool,
      organizationId,
      deadline,
      dependencies.prepareCandidate ?? prepararCandidato,
      dependencies.now ?? Date.now,
    );
    Object.assign(summary, result);
  } finally {
    try {
      if (locked)
        await client.query("select pg_advisory_unlock(hashtextextended($1,0))", [
          ORG_LOCK(organizationId),
        ]);
    } catch (error) {
      releaseError = error instanceof Error ? error : new Error("advisory_unlock_failed");
    }
    client.release(releaseError);
  }
  if (summary.sitesAttempted || summary.previewsAttempted || summary.failures) {
    logger.info("[prospecting.preparo] rodada concluída", {
      organization_id: organizationId,
      request_id: requestId,
      candidates_considered: summary.considered,
      sites_attempted: summary.sitesAttempted,
      sites_completed: summary.sitesCompleted,
      previews_attempted: summary.previewsAttempted,
      previews_completed: summary.previewsCompleted,
      failures: summary.failures,
    });
  }
  return summary;
}
