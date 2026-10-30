import type pg from "pg";
import type { SupabaseClient } from "@supabase/supabase-js";
import { createContactHandler } from "@/app/api/v1/contacts/_handler";
import { createLeadHandler } from "@/app/api/v1/leads/_handler";
import { loadActiveRouter } from "@/lib/agent-engine/agent/router-config";
import { loadPublishedAgentConfig } from "@/lib/agent-engine/agent/agent-config";
import { createLeadSchema } from "@/lib/schemas/leads";
import { beginServiceAtOrigin } from "@/lib/atendimento/origem";
import { capabilitiesOf } from "@/lib/channels/capabilities";
import { env } from "@/lib/env";
import type { ChannelProvider } from "@/lib/channels/types";
import { phoneLookupVariants } from "@/lib/channels/phone-variants";
import { decryptWebhookSecret, encryptWebhookSecret } from "@/lib/webhooks/secrets";
import {
  campaignConfigSchema,
  normalizeProspect,
  type CampaignConfig,
  type SearchInput,
  type Prospect,
} from "./schema";
import { ProspectingError } from "./provider";
import {
  providerByName,
  providerNameForOrganization,
  validateApifyCredential,
  type ProspectingProviderName,
} from "./dispatcher";
import { assertProspectingSourceAllowed } from "./source-policy";
import { LOCAL_HTTP_LIMITS } from "./provider-local-http";
import {
  assertLocalHttpSearchCapacity,
  localHttpGlobalSlots,
  LOCAL_HTTP_SEARCH_POLICY,
} from "./local-http-limits";

export interface Campaign {
  id: string;
  organization_id: string;
  name: string;
  search: SearchInput & {
    provider?: ProspectingProviderName;
    source?: string;
    accepted?: boolean;
    dispatch_status?: "queued" | "dispatching" | "submitted";
  };
  config: CampaignConfig | null;
  status: string;
  search_status: string;
  run_id: string | null;
  dataset_id: string | null;
  next_send_at: Date;
  created_at: Date;
  error: string | null;
}
export interface Candidate {
  id: string;
  organization_id: string;
  campaign_id: string;
  data: Prospect;
  status: string;
  phone: string | null;
  contact_id: string | null;
  lead_id: string | null;
  conversation_id: string | null;
  service_boundary: unknown;
  message_id: string;
}
/** Session-scoped PostgreSQL lock shared by commands and worker; no process-local lock. */
export async function withProspectingLock<T>(
  pool: pg.Pool,
  org: string,
  fn: (db: pg.PoolClient) => Promise<T>,
): Promise<T> {
  const db = await pool.connect();
  let locked = false;
  try {
    locked =
      (
        await db.query<{ locked: boolean }>(
          "select pg_try_advisory_lock(hashtextextended($1,0)) as locked",
          [`prospecting:${org}`],
        )
      ).rows[0]?.locked === true;
    if (!locked)
      throw new ProspectingError(
        "Uma operação está em andamento. Tente novamente em alguns segundos.",
        409,
      );
    return await fn(db);
  } finally {
    try {
      if (locked)
        await db.query("select pg_advisory_unlock(hashtextextended($1,0))", [`prospecting:${org}`]);
    } finally {
      db.release();
    }
  }
}
export async function credential(db: pg.Pool | pg.PoolClient, admin: SupabaseClient, org: string) {
  const { rows } = await db.query<{ credential_encrypted: Buffer }>(
    "select credential_encrypted from prospecting_settings where organization_id=$1",
    [org],
  );
  const encrypted = rows[0]?.credential_encrypted;
  if (!encrypted)
    throw new ProspectingError("Configure a chave de busca antes de extrair empresas.");
  const key = await decryptWebhookSecret(admin, encrypted.toString("hex"));
  if (!key)
    throw new ProspectingError(
      "Não foi possível abrir a chave de busca. Salve a configuração novamente.",
    );
  return key;
}
export async function configureCredential(
  pool: pg.Pool,
  admin: SupabaseClient,
  org: string,
  key: string,
) {
  await validateApifyCredential(key);
  const encrypted = await encryptWebhookSecret(admin, key);
  if (!encrypted)
    throw new ProspectingError("A cifra de credenciais da instalação não está disponível.");
  await pool.query(
    "insert into prospecting_settings(organization_id,credential_encrypted) values ($1,$2::bytea) on conflict(organization_id) do update set credential_encrypted=excluded.credential_encrypted,updated_at=now()",
    [org, encrypted],
  );
}
export async function createSearch(
  pool: pg.Pool,
  admin: SupabaseClient,
  org: string,
  requestId: string,
  search: SearchInput,
) {
  return withProspectingLock(pool, org, async (db) => {
    const prior = await db.query<Campaign>(
      "select * from prospecting_campaigns where organization_id=$1 and request_id=$2",
      [org, requestId],
    );
    if (prior.rows[0]) return prior.rows[0];
    const providerName = await providerNameForOrganization(db, org);
    if (providerName === "local-http") {
      // This wave has no approved real source. The policy gate runs before a
      // queue row is created and before any network request can be made.
      const rawUrl = env.PROSPECTING_LOCAL_HTTP_URL.trim();
      if (!rawUrl)
        throw new ProspectingError(
          "O engine local não está configurado nesta instalação.",
          503,
          "campanha",
          "local_http_unavailable",
        );
      assertProspectingSourceAllowed("google_maps");
      return createLocalHttpSearch(db, org, requestId, search);
    }
    const key = await credential(db, admin, org);
    const { rows } = await db.query<Campaign>(
      "insert into prospecting_campaigns(organization_id,request_id,name,search) values($1,$2,$3,$4) returning *",
      [org, requestId, search.name, search],
    );
    const campaign = rows[0]!;
    try {
      const run = await providerByName("apify").startSearch(key, search);
      await db.query(
        "update prospecting_campaigns set run_id=$3,dataset_id=$4,search_status='running',updated_at=now() where organization_id=$1 and id=$2",
        [org, campaign.id, run.id, run.defaultDatasetId ?? null],
      );
    } catch (error) {
      await db.query(
        "update prospecting_campaigns set search_status='unknown',error=$3,updated_at=now() where organization_id=$1 and id=$2",
        [
          org,
          campaign.id,
          error instanceof ProspectingError
            ? error.message
            : "Não foi possível confirmar a busca. Confira as execuções no provedor antes de repetir.",
        ],
      );
    }
    return (
      await db.query<Campaign>(
        "select * from prospecting_campaigns where organization_id=$1 and id=$2",
        [org, campaign.id],
      )
    ).rows[0]!;
  });
}

async function withLocalHttpGlobalLock<T>(db: pg.PoolClient, fn: () => Promise<T>): Promise<T> {
  const locked =
    (await db.query<{ locked: boolean }>(
      "select pg_try_advisory_lock(hashtextextended('prospecting:local-http:dispatch',0)) as locked",
    )).rows[0]?.locked === true;
  if (!locked)
    throw new ProspectingError("A fila de busca está ocupada. Tente novamente em instantes.", 409);
  try {
    return await fn();
  } finally {
    await db.query("select pg_advisory_unlock(hashtextextended('prospecting:local-http:dispatch',0))");
  }
}

async function createLocalHttpSearch(
  db: pg.PoolClient,
  org: string,
  requestId: string,
  search: SearchInput,
): Promise<Campaign> {
  return withLocalHttpGlobalLock(db, async () => {
    const stats = (
      await db.query<{
        accepted_24h: number;
        last_accepted_at: Date | null;
        active_org: number;
      }>(
        `select
           count(*) filter (where search->>'accepted'='true' and created_at > now()-interval '24 hours')::int as accepted_24h,
           max(created_at) filter (where search->>'accepted'='true') as last_accepted_at,
           count(*) filter (where search_status in ('starting','running') or (search_status='unknown' and updated_at > now()-interval '10 minutes'))::int as active_org
         from prospecting_campaigns
         where organization_id=$1 and search->>'provider'='local-http'`,
        [org],
      )
    ).rows[0]!;
    assertLocalHttpSearchCapacity(
      {
        acceptedInLast24Hours: Number(stats.accepted_24h),
        lastAcceptedAt: stats.last_accepted_at ? new Date(stats.last_accepted_at) : null,
        activeForOrganization: Number(stats.active_org),
      },
    );
    const searchSnapshot = {
      ...search,
      provider: "local-http" as const,
      source: "google_maps",
      accepted: true,
      dispatch_status: "queued" as const,
      limits: {
        per_org_per_day: LOCAL_HTTP_SEARCH_POLICY.maxPerOrganizationPer24Hours,
        min_interval_seconds: LOCAL_HTTP_SEARCH_POLICY.minIntervalMs / 1000,
        max_concurrent_per_org: LOCAL_HTTP_SEARCH_POLICY.maxConcurrentPerOrganization,
        max_global_concurrent: LOCAL_HTTP_SEARCH_POLICY.maxConcurrentGlobal,
        response_bytes: LOCAL_HTTP_LIMITS.maxResponseBytes,
      },
    };
    const { rows } = await db.query<Campaign>(
      "insert into prospecting_campaigns(organization_id,request_id,name,search) values($1,$2,$3,$4) returning *",
      [org, requestId, search.name, searchSnapshot],
    );
    return rows[0]!;
  });
}

/** Reserva no máximo três jobs e um por organização em round-robin pela espera mais antiga. */
export async function claimQueuedLocalHttpSearches(
  pool: pg.Pool,
  blockedOrganizations: readonly string[] = [],
): Promise<Campaign[]> {
  const db = await pool.connect();
  let locked = false;
  try {
    locked =
      (await db.query<{ locked: boolean }>(
        "select pg_try_advisory_lock(hashtextextended('prospecting:local-http:dispatch',0)) as locked",
      )).rows[0]?.locked === true;
    if (!locked) return [];
    // A criação remota tem prazo de 10s e o engine recebe timeout máximo de
    // 300s. Um dispatching mais velho que 2 min significa queda entre claim e
    // confirmação; vira unknown, conserva a quota de 24h e deixa a reconciliação
    // impedir repetição até o limite conservador de execução do engine.
    await db.query(
      `update prospecting_campaigns
       set search_status='unknown',error='Busca local sem confirmação. A quota permanece reservada por segurança.',updated_at=now()
       where search_status='starting' and search->>'provider'='local-http'
         and search->>'dispatch_status'='dispatching' and updated_at<now()-interval '2 minutes'`,
    );
    const active =
      (await db.query<{ count: number }>(
        `select count(*)::int as count from prospecting_campaigns
         where search->>'provider'='local-http'
           and (search_status='running'
             or (search_status='unknown' and updated_at > now()-interval '10 minutes')
             or (search_status='starting' and search->>'dispatch_status'='dispatching'))`,
      )).rows[0]?.count ?? 0;
    const slots = localHttpGlobalSlots(Number(active));
    if (!slots) return [];
    const eligible = (
      await db.query<{ id: string; organization_id: string }>(
        `select id, organization_id from (
           select distinct on (c.organization_id) c.id, c.organization_id, c.created_at
           from prospecting_campaigns c
           where c.search_status='starting'
             and c.search->>'provider'='local-http'
             and c.search->>'dispatch_status'='queued'
             and c.organization_id <> all($1::uuid[])
             and not exists (
               select 1 from prospecting_campaigns active
               where active.organization_id=c.organization_id
                 and active.search->>'provider'='local-http'
                 and (active.search_status='running'
                   or (active.search_status='unknown' and active.updated_at > now()-interval '10 minutes')
                   or (active.search_status='starting' and active.search->>'dispatch_status'='dispatching'))
             )
           order by c.organization_id, c.created_at, c.id
         ) eligible order by created_at, organization_id limit $2`,
        [blockedOrganizations, slots],
      )
    ).rows;
    const claimed: Campaign[] = [];
    for (const item of eligible) {
      const result = await db.query<Campaign>(
        `update prospecting_campaigns
         set search=jsonb_set(search,'{dispatch_status}','"dispatching"'::jsonb,true),updated_at=now()
         where organization_id=$1 and id=$2 and search_status='starting'
           and search->>'provider'='local-http' and search->>'dispatch_status'='queued'
         returning *`,
        [item.organization_id, item.id],
      );
      if (result.rows[0]) claimed.push(result.rows[0]);
    }
    return claimed;
  } finally {
    try {
      if (locked)
        await db.query("select pg_advisory_unlock(hashtextextended('prospecting:local-http:dispatch',0))");
    } finally {
      db.release();
    }
  }
}

export async function dispatchClaimedLocalHttpSearch(pool: pg.Pool, campaign: Campaign): Promise<void> {
  try {
    const run = await providerByName("local-http").startSearch("", campaign.search);
    const status = run.status === "FAILED" ? "failed" : run.status === "SUCCEEDED" ? "succeeded" : "running";
    await pool.query(
      `update prospecting_campaigns
       set run_id=$3,dataset_id=$4,cost_usd=0,search_status=$5,
           search=jsonb_set(search,'{dispatch_status}','"submitted"'::jsonb,true),error=null,updated_at=now()
       where organization_id=$1 and id=$2 and search_status='starting'
         and search->>'dispatch_status'='dispatching'`,
      [campaign.organization_id, campaign.id, run.id, run.defaultDatasetId ?? run.id, status],
    );
  } catch (error) {
    const failure = error instanceof ProspectingError ? error : null;
    const status = failure?.uncertain ? "unknown" : "failed";
    const message = failure?.message ?? "Não foi possível iniciar a busca local.";
    await pool.query(
      `update prospecting_campaigns set search_status=$3,error=$4,updated_at=now()
       where organization_id=$1 and id=$2 and search_status='starting'
         and search->>'dispatch_status'='dispatching'`,
      [campaign.organization_id, campaign.id, status, message],
    );
  }
}
export async function synchronizeSearch(db: pg.PoolClient, admin: SupabaseClient, c: Campaign) {
  if (!c.run_id) return;
  const providerName = c.search.provider ?? "apify";
  const provider = providerByName(providerName);
  const key = providerName === "apify" ? await credential(db, admin, c.organization_id) : "";
  const run = await provider.readSearch(key, c.run_id);
  if (["FAILED", "ABORTED", "TIMED-OUT"].includes(run.status)) {
    await db.query(
      "update prospecting_campaigns set search_status='failed',error=$3,updated_at=now() where organization_id=$1 and id=$2",
      [c.organization_id, c.id, `A busca terminou com estado ${run.status}.`],
    );
    return;
  }
  if (run.status !== "SUCCEEDED") return;
  const dataset = run.defaultDatasetId ?? c.dataset_id;
  if (!dataset) throw new ProspectingError("Busca concluída sem resultado disponível.");
  const items = await provider.readResults(key, dataset, c.search.limit);
  let inserted = 0;
  await db.query("begin");
  try {
    for (const item of items) {
      const p = normalizeProspect(item);
      if (!p) continue;
      const result = await db.query(
        "insert into prospecting_candidates(organization_id,campaign_id,place_id,phone,data) values($1,$2,$3,$4,$5) on conflict do nothing",
        [c.organization_id, c.id, p.key, p.phone, p],
      );
      inserted += result.rowCount ?? 0;
    }
    await db.query(
      "update prospecting_campaigns set search_status='succeeded',dataset_id=$3,cost_usd=$4,result_count=$5,skipped_count=$6,error=null,updated_at=now() where organization_id=$1 and id=$2",
      [
        c.organization_id,
        c.id,
        dataset,
        run.usageTotalUsd ?? null,
        inserted,
        items.length - inserted,
      ],
    );
    await db.query("commit");
  } catch (error) {
    await db.query("rollback");
    throw error;
  }
}
export async function validateConfig(db: pg.PoolClient, org: string, input: CampaignConfig) {
  const config = campaignConfigSchema.parse(input);
  const agent = (
    await db.query(
      "select v.tool_ids,v.pipeline_ids from ai_agents a join ai_agent_versions v on v.id=a.published_version_id and v.organization_id=a.organization_id where a.organization_id=$1 and a.id=$2 and v.status='published' and a.archived_at is null and a.paused_at is null and a.operation_mode='automatic'",
      [org, config.agent_id],
    )
  ).rows[0];
  if (!agent) throw new ProspectingError("Escolha um agente publicado e em operação automática.");
  if (
    !agent.tool_ids?.includes("crm_move_lead_stage") ||
    !agent.pipeline_ids?.includes(config.pipeline_id)
  )
    throw new ProspectingError(
      "Publique o agente com a ferramenta de mover negócios e acesso ao funil escolhido.",
    );
  const channel = (
    await db.query<{ provider: ChannelProvider; status: string }>(
      "select provider,status from channel_sessions where organization_id=$1 and id=$2 and archived_at is null",
      [org, config.channel_session_id],
    )
  ).rows[0];
  if (
    !channel ||
    channel.status !== "WORKING" ||
    !capabilitiesOf(channel.provider).freeformOutsideWindow
  )
    throw new ProspectingError(
      "Escolha uma conexão ativa que permita iniciar conversas de texto. Canais que exigem modelo aprovado ainda não participam desta campanha.",
    );
  const router = await loadActiveRouter(db as unknown as pg.Pool, org, config.channel_session_id);
  if (router) {
    if (!router.sticky || !router.members.some((m) => m.agentId === config.agent_id))
      throw new ProspectingError(
        "Inclua o agente no roteador deste canal e ative a continuidade do agente antes de iniciar.",
      );
  } else {
    const bound = await loadPublishedAgentConfig(
      db as unknown as pg.Pool,
      org,
      config.channel_session_id,
    );
    if (bound?.agentId !== config.agent_id)
      throw new ProspectingError(
        "Publique o agente no canal escolhido para que ele também atenda às respostas.",
      );
  }
  const stages = (
    await db.query<{ id: string }>(
      "select id from crm_stages where organization_id=$1 and pipeline_id=$2 and id=any($3::uuid[]) and not is_archived and not is_won and not is_lost",
      [org, config.pipeline_id, [config.stage_id, config.qualified_stage_id]],
    )
  ).rows;
  if (config.stage_id === config.qualified_stage_id || stages.length !== 2)
    throw new ProspectingError(
      "Escolha duas etapas abertas e diferentes do mesmo funil: entrada e qualificados.",
    );
  return config;
}
export async function activateCampaign(
  pool: pg.Pool,
  admin: SupabaseClient,
  org: string,
  id: string,
  input: CampaignConfig,
) {
  return withProspectingLock(pool, org, async (db) => {
    const config = await validateConfig(db, org, input);
    const c = (
      await db.query<Campaign>(
        "select * from prospecting_campaigns where organization_id=$1 and id=$2",
        [org, id],
      )
    ).rows[0];
    if (!c) throw new ProspectingError("Campanha não encontrada.", 404);
    if (c.status !== "draft" || c.search_status !== "succeeded")
      throw new ProspectingError(
        "Aguarde a busca terminar; uma campanha já iniciada deve ser retomada.",
        409,
      );
    if (
      (
        await db.query(
          "select id from prospecting_campaigns where organization_id=$1 and status='running'",
          [org],
        )
      ).rows.length
    )
      throw new ProspectingError("Pause a campanha atual antes de iniciar outra.", 409);
    if (c.config && JSON.stringify(campaignConfigSchema.parse(c.config)) !== JSON.stringify(config))
      throw new ProspectingError(
        "A preparação já começou. Retome com a mesma configuração da campanha.",
        409,
      );
    await db.query(
      "update prospecting_campaigns set config=$3 where organization_id=$1 and id=$2",
      [org, id, config],
    );
    // Activation is the authorized origin. A later tick only uses this captured boundary.
    const candidates = (
      await db.query<Candidate>(
        "select * from prospecting_candidates where organization_id=$1 and campaign_id=$2 and status='new' order by created_at,id",
        [org, id],
      )
    ).rows;
    for (const p of candidates) {
      if (!p.phone) {
        await db.query(
          "update prospecting_candidates set status='skipped',error='Sem telefone brasileiro válido.' where organization_id=$1 and id=$2",
          [org, p.id],
        );
        continue;
      }
      const known = await db.query(
        "select id from contacts where organization_id=$1 and phone_number=any($2::text[])",
        [org, phoneLookupVariants(p.phone)],
      );
      if (known.rows.length && !p.contact_id) {
        const owned = await db.query(
          "select id from contacts where organization_id=$1 and id=$2 and source='prospecting' and source_metadata->>'campaign_id'=$3 and source_metadata->>'place_id'=$4",
          [org, known.rows[0].id, id, p.data.key],
        );
        if (owned.rows[0]) p.contact_id = owned.rows[0].id;
      }
      if (known.rows.length && !p.contact_id) {
        await db.query(
          "update prospecting_candidates set status='skipped',error='Contato já existe no CRM; atendimento preservado.' where organization_id=$1 and id=$2",
          [org, p.id],
        );
        continue;
      }
      const ctx = {
        organization_id: org,
        actor: { type: "webhook_source" as const, id },
        requestId: `rule:${id}`,
      };
      let contactId = p.contact_id;
      if (!contactId) {
        const contact = await createContactHandler(admin, ctx, {
          name: p.data.name,
          display_name: p.data.name,
          phone_number: p.phone,
          source: "prospecting",
          source_metadata: { campaign_id: id, place_id: p.data.key, maps_url: p.data.maps_url },
          consent: { legitimate_interest: { ref: config.legal_basis_ref } },
        });
        contactId = String(contact.contact.id);
        await db.query(
          "update prospecting_candidates set contact_id=$3 where organization_id=$1 and id=$2",
          [org, p.id, contactId],
        );
      }
      let leadId = p.lead_id;
      if (!leadId) {
        const existing = await db.query(
          "select id from crm_leads where organization_id=$1 and source='prospecting' and external_id=$2",
          [org, p.id],
        );
        leadId = existing.rows[0]?.id ?? null;
      }
      if (!leadId) {
        const lead = await createLeadHandler(admin, ctx, {
          ...createLeadSchema.parse({
            pipeline_id: config.pipeline_id,
            stage_id: config.stage_id,
            title: p.data.name,
            contact_id: contactId,
            owner_agent_id: config.agent_id,
            source: "prospecting",
            description: `Campanha: ${c.name}\nQualificação: ${config.qualification}`.slice(
              0,
              2000,
            ),
          }),
          external_id: p.id,
        });
        leadId = String(lead.id);
        await db.query(
          "update prospecting_candidates set lead_id=$3 where organization_id=$1 and id=$2",
          [org, p.id, leadId],
        );
      }
      await db.query(
        "update prospecting_candidates set contact_id=$3,lead_id=$4 where organization_id=$1 and id=$2",
        [org, p.id, contactId, leadId],
      );
      const boundary = await beginServiceAtOrigin(admin, org, contactId, config.channel_session_id);
      await db.query(
        "update conversations set active_ai_agent_id=$3,metadata=coalesce(metadata,'{}'::jsonb) || jsonb_build_object('prospecting_campaign_id',$4::text) where organization_id=$1 and id=$2",
        [org, boundary.conversation_id, config.agent_id, id],
      );
      await db.query(
        "update prospecting_candidates set status='queued',conversation_id=$3,service_boundary=$4,error=null,updated_at=now() where organization_id=$1 and id=$2",
        [org, p.id, boundary.conversation_id, boundary],
      );
    }
    await db.query(
      "update prospecting_campaigns set config=$3,status='running',next_send_at=now()+interval '1 minute',error=null,updated_at=now() where organization_id=$1 and id=$2",
      [org, id, config],
    );
    return { started: true };
  });
}
