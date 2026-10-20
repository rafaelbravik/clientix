import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { afterAll, describe, expect, it } from 'vitest';
import pg, { type Pool, type PoolClient } from 'pg';

import { loadPlaybook } from '@/lib/agent-engine/agent/playbook';
import { claimJobs, completeJob, enqueueJob } from '@/lib/agent-engine/queue/queue';

const container = process.env.TEST_DB_CONTAINER;
if (!container) throw new Error('TEST_DB_CONTAINER not set — rode via `pnpm test:db`');
const containerName: string = container;
const port = Number(process.env.TEST_DB_PORT ?? 54329);
const workerPassword = process.env.TEST_AGENT_WORKER_PASSWORD;
if (!workerPassword) throw new Error('TEST_AGENT_WORKER_PASSWORD not set — rode via `pnpm test:db`');
const adminPool = new pg.Pool({
  connectionString: `postgresql://postgres:postgres@127.0.0.1:${port}/postgres`,
  max: 4,
});
const workerPool = new pg.Pool({
  connectionString: `postgresql://agent_worker:${encodeURIComponent(workerPassword)}@127.0.0.1:${port}/postgres`,
  max: 4,
});

const tableContract = {
  agent_case_events: ['INSERT', 'SELECT'],
  agent_cases: ['INSERT', 'SELECT', 'UPDATE'],
  agent_inbox_items: ['INSERT', 'SELECT', 'UPDATE'],
  ai_agent_versions: ['SELECT'],
  ai_agents: ['SELECT'],
  ai_budgets: ['SELECT'],
  ai_models: ['SELECT'],
  ai_provider_credentials: ['SELECT'],
  ai_purpose_bindings: ['SELECT'],
  ai_router_decisions: ['INSERT'],
  ai_router_members: ['SELECT'],
  ai_routers: ['SELECT'],
  api_audit_log: ['INSERT'],
  api_tokens: ['INSERT', 'SELECT', 'UPDATE'],
  attendant_availability: ['SELECT'],
  before_send_traces: ['INSERT'],
  calendar_appointments: ['SELECT'],
  catalog_products: ['SELECT'],
  channel_knobs: ['SELECT'],
  channel_session_health: ['SELECT', 'UPDATE'],
  channel_sessions: ['SELECT', 'UPDATE'],
  contacts: ['SELECT', 'UPDATE'],
  conversations: ['SELECT', 'UPDATE'],
  crm_lead_activities: ['INSERT', 'SELECT'],
  crm_lead_scores: ['INSERT', 'SELECT', 'UPDATE'],
  crm_leads: ['SELECT', 'UPDATE'],
  crm_pipelines: ['SELECT'],
  crm_proposals: ['SELECT'],
  crm_stages: ['SELECT'],
  cron_jobs: ['INSERT', 'SELECT', 'UPDATE'],
  demanda_conversas: ['SELECT'],
  demandas: ['SELECT'],
  disclosure_template_pointers: ['SELECT'],
  disclosure_template_versions: ['SELECT'],
  event_log: ['INSERT', 'SELECT', 'UPDATE'],
  flywheel_distiller_proposals: ['INSERT'],
  flywheel_judge_verdicts: ['INSERT'],
  followup_enrollment_events: ['INSERT', 'SELECT'],
  followup_enrollments: ['INSERT', 'SELECT', 'UPDATE'],
  followup_flow_pointers: ['SELECT'],
  followup_flow_versions: ['SELECT'],
  golden_candidates: ['INSERT'],
  jev_observacoes: ['INSERT'],
  job_queue: ['INSERT', 'SELECT', 'UPDATE'],
  knowledge_searches: ['INSERT'],
  lead_checkpoints: ['INSERT', 'SELECT'],
  lead_notes: ['DELETE', 'INSERT', 'SELECT'],
  lead_state: ['INSERT', 'SELECT', 'UPDATE'],
  lead_state_transitions: ['INSERT'],
  llm_calls: ['INSERT', 'SELECT'],
  message_templates: ['SELECT'],
  messages: ['DELETE', 'INSERT', 'SELECT', 'UPDATE'],
  meta_templates: ['SELECT'],
  metrics: ['INSERT', 'SELECT'],
  modulos_instalados: ['SELECT'],
  org_guardrail_layers: ['SELECT'],
  org_memory_entries: ['SELECT'],
  org_memory_pointers: ['SELECT'],
  org_memory_versions: ['SELECT'],
  organizations: ['SELECT'],
  outbound_copies: ['INSERT', 'SELECT'],
  pacing_ledger: ['INSERT', 'SELECT'],
  passagens_de_atendimento: ['INSERT'],
  people: ['SELECT'],
  platform_config: ['SELECT'],
  platform_settings: ['SELECT'],
  playbook_pointers: ['INSERT', 'SELECT'],
  playbook_versions: ['INSERT', 'SELECT'],
  promise_table_pointers: ['SELECT'],
  promise_table_versions: ['SELECT'],
  prospecting_campaigns: ['SELECT'],
  prospecting_candidates: ['SELECT'],
  reentry_template_pointers: ['SELECT'],
  reentry_template_versions: ['SELECT'],
  send_ledger: ['INSERT', 'SELECT', 'UPDATE'],
  skill_activations: ['INSERT'],
  skill_pointers: ['SELECT'],
  skill_versions: ['SELECT'],
  user_organizations: ['SELECT'],
  voice_calls: ['INSERT', 'UPDATE'],
} as const satisfies Record<string, readonly string[]>;

const serviceFunctions = [
  'public.emit_event(text,text,uuid,jsonb,jsonb,uuid)',
  'public.fn_appointment_enrollment_current(uuid,uuid,text)',
  'public.fn_buscar_trechos_das_fontes(uuid,uuid[],vector,integer,real,text)',
  'public.fn_claim_due_followup_enrollments(integer,integer)',
  'public.fn_decrypt_oauth(bytea)',
  'public.fn_followup_apply_step(uuid,uuid,bigint,jsonb,jsonb)',
  'public.fn_followup_claim_current(uuid,uuid,text,timestamptz)',
  'public.fn_followup_job_current(uuid,uuid,uuid,text)',
  'public.fn_followup_patch(uuid,uuid,bigint,jsonb)',
  'public.fn_followup_turno_descartado(uuid,uuid)',
  'public.fn_gasto_de_ia_do_mes(uuid)',
  'public.fn_meet_delivery_policy(uuid,uuid,text,timestamptz)',
  'public.fn_meet_delivery_settle(uuid,uuid,text,timestamptz,text,timestamptz)',
  'public.fn_org_operante(uuid)',
  'public.fn_reply_delivery_policy(uuid,uuid,text,timestamptz)',
  'public.fn_reply_prepare(uuid,uuid,text,timestamptz)',
  'public.fn_reply_receipt_policy(uuid,uuid,text,timestamptz)',
  'public.fn_reply_record_receipt(uuid,uuid,text,timestamptz,uuid,text,text[])',
  'public.fn_reply_settle(uuid,uuid,text,timestamptz,text,text)',
  'public.fn_service_boundary(uuid,uuid)',
  'public.fn_service_observe_command(uuid,uuid)',
];

const workerFunctions = [
  'public.fn_appointment_enrollment_current(uuid,uuid,text)',
  'public.fn_buscar_trechos_das_fontes(uuid,uuid[],vector,integer,real,text)',
  'public.fn_claim_due_followup_enrollments(integer,integer)',
  'public.fn_event_log_e_registro(text)',
  'public.fn_followup_apply_step(uuid,uuid,bigint,jsonb,jsonb)',
  'public.fn_followup_claim_current(uuid,uuid,text,timestamptz)',
  'public.fn_followup_job_current(uuid,uuid,uuid,text)',
  'public.fn_followup_patch(uuid,uuid,bigint,jsonb)',
  'public.fn_followup_turno_descartado(uuid,uuid)',
  'public.fn_gasto_de_ia_do_mes(uuid)',
  'public.fn_log_event(uuid,text,jsonb)',
  'public.fn_meet_delivery_policy(uuid,uuid,text,timestamptz)',
  'public.fn_meet_delivery_settle(uuid,uuid,text,timestamptz,text,timestamptz)',
  'public.fn_org_operante(uuid)',
  'public.fn_reply_delivery_policy(uuid,uuid,text,timestamptz)',
  'public.fn_reply_receipt_policy(uuid,uuid,text,timestamptz)',
  'public.fn_reply_settle(uuid,uuid,text,timestamptz,text,text)',
];

const sequences = [
  'public.lead_checkpoints_seq_seq',
  'public.lead_state_transitions_seq_seq',
] as const;

const contractPairs = Object.entries(tableContract).flatMap(([table, privileges]) =>
  privileges.map((privilege) => [table, privilege] as const),
);

function valuesClause(rows: readonly (readonly [string, string])[]): {
  sql: string;
  params: string[];
} {
  const params = rows.flatMap(([table, privilege]) => [table, privilege]);
  const sql = rows
    .map((_, index) => `($${index * 2 + 1}::text, $${index * 2 + 2}::text)`)
    .join(', ');
  return { sql, params };
}

async function connectAsAgentWorker(): Promise<PoolClient> {
  const client = await workerPool.connect();
  try {
    const identity = await client.query<{ session_user: string; current_user: string }>(
      'select session_user::text, current_user::text',
    );
    if (
      identity.rows[0]?.session_user !== 'agent_worker' ||
      identity.rows[0]?.current_user !== 'agent_worker'
    ) {
      throw new Error('worker test pool did not authenticate directly as agent_worker');
    }
    return client;
  } catch (error) {
    client.release();
    throw error;
  }
}

const queueWorkerPool = {
  connect: connectAsAgentWorker,
} as unknown as Pool;

afterAll(async () => {
  await Promise.all([adminPool.end(), workerPool.end()]);
});

describe('contrato completo de ACL do worker', () => {
  it('aplica e reaplica a allowlist; testa operações reais, isolamento e negações', async () => {
    const client = await adminPool.connect();
    const orgA = randomUUID();
    const orgB = randomUUID();
    const suffix = randomUUID();
    const { sql: requiredValues, params: requiredParams } = valuesClause(contractPairs);

    try {
      await client.query('begin');
      const roleExists = await client.query("select to_regrole('agent_worker') is not null as present");
      expect(roleExists.rows[0]?.present).toBe(true);

      const migration = readFileSync(
        resolve(process.cwd(), 'supabase/migrations/20261017142810_0514_worker_runtime_acl_contract.sql'),
        'utf8',
      );
      await client.query(migration);
      await client.query(migration);

      const triggerAclMigration = readFileSync(
        resolve(process.cwd(), 'supabase/migrations/20261019204527_0515_agent_worker_trigger_function_acl.sql'),
        'utf8',
      );
      await client.query(triggerAclMigration);
      await client.query(triggerAclMigration);

      const missing = await client.query(
        `with required(table_name, privilege) as (values ${requiredValues})
         select table_name, privilege
           from required
          where not has_table_privilege('service_role', 'public.' || table_name, privilege)
             or not has_table_privilege('agent_worker', 'public.' || table_name, privilege)
          order by table_name, privilege`,
        requiredParams,
      );
      expect(missing.rows).toEqual([]);

      const extras = await client.query(
        `with required(table_name, privilege) as (values ${requiredValues})
         select c.relname, p.privilege
           from pg_class c
           join pg_namespace n on n.oid = c.relnamespace
           cross join unnest(array['SELECT','INSERT','UPDATE','DELETE','TRUNCATE','REFERENCES','TRIGGER']) p(privilege)
          where n.nspname = 'public'
            and c.relkind in ('r', 'p')
            and has_table_privilege('agent_worker', c.oid, p.privilege)
            and not exists (
              select 1 from required r
               where r.table_name = c.relname and r.privilege = p.privilege
            )
          order by c.relname, p.privilege`,
        requiredParams,
      );
      expect(extras.rows).toEqual([]);

      const rls = await client.query(
        `with required(table_name) as (values ${[...new Set(contractPairs.map(([table]) => table))]
          .map((_, index) => `($${index + 1}::text)`)
          .join(', ')})
         select r.table_name
           from required r
           join pg_class c on c.oid = to_regclass('public.' || r.table_name)
          where not c.relrowsecurity
          order by r.table_name`,
        [...new Set(contractPairs.map(([table]) => table))],
      );
      expect(rls.rows).toEqual([]);

      const functionRows = await client.query(
        `select functions.signature
           from unnest($1::text[]) as functions(signature)
          where to_regprocedure(signature) is null
             or not has_function_privilege('service_role', to_regprocedure(signature), 'EXECUTE')
          order by functions.signature`,
        [serviceFunctions],
      );
      expect(functionRows.rows).toEqual([]);

      const workerFunctionRows = await client.query(
        `select functions.signature
           from unnest($1::text[]) as functions(signature)
          where to_regprocedure(signature) is null
             or not has_function_privilege('agent_worker', to_regprocedure(signature), 'EXECUTE')
          order by functions.signature`,
        [workerFunctions],
      );
      expect(workerFunctionRows.rows).toEqual([]);

      const functionBoundary = await client.query(
        "select has_function_privilege('agent_worker', 'public.fn_decrypt_oauth(bytea)', 'EXECUTE') as worker_can_decrypt_oauth, has_function_privilege('anon', 'public.fn_event_log_e_registro(text)', 'EXECUTE') as anon_can_classify_event, has_function_privilege('anon', 'public.fn_log_event(uuid,text,jsonb)', 'EXECUTE') as anon_can_log_event",
      );
      expect(functionBoundary.rows[0]).toEqual({
        worker_can_decrypt_oauth: false,
        anon_can_classify_event: false,
        anon_can_log_event: false,
      });

      const sequencePrivileges = await client.query(
        `select
           has_sequence_privilege('agent_worker', $1, 'USAGE') as checkpoint_usage,
           has_sequence_privilege('agent_worker', $2, 'USAGE') as transition_usage,
           has_sequence_privilege('agent_worker', $1, 'SELECT') as checkpoint_select,
           has_sequence_privilege('agent_worker', $2, 'SELECT') as transition_select,
           has_sequence_privilege('agent_worker', $1, 'UPDATE') as checkpoint_update,
           has_sequence_privilege('agent_worker', $2, 'UPDATE') as transition_update`,
        [...sequences],
      );
      expect(sequencePrivileges.rows[0]).toEqual({
        checkpoint_usage: true,
        transition_usage: true,
        checkpoint_select: false,
        transition_select: false,
        checkpoint_update: false,
        transition_update: false,
      });

      const unauthorizedFunctionGrants = await client.query(
        `select p.oid::regprocedure::text as signature
           from pg_proc p
           join pg_namespace n on n.oid = p.pronamespace
           cross join lateral aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) acl
          where n.nspname = 'public'
            and acl.grantee = (select oid from pg_roles where rolname = 'agent_worker')
            and acl.privilege_type = 'EXECUTE'
           and p.oid not in (select to_regprocedure(functions.signature)::oid from unnest($1::text[]) as functions(signature))
          order by signature`,
        [workerFunctions],
      );
      expect(unauthorizedFunctionGrants.rows).toEqual([]);

      const roleState = await client.query(
        `select rolsuper, rolcanlogin, rolinherit, rolbypassrls, rolcreatedb, rolcreaterole, rolreplication
           from pg_roles where rolname = 'agent_worker'`,
      );
      expect(roleState.rows[0]).toEqual({
        rolsuper: false,
        rolcanlogin: true,
        rolinherit: false,
        rolbypassrls: true,
        rolcreatedb: false,
        rolcreaterole: false,
        rolreplication: false,
      });
      const schemaState = await client.query(
        `select has_schema_privilege('agent_worker', 'public', 'USAGE') as public_usage,
                has_schema_privilege('agent_worker', 'public', 'CREATE') as public_create,
                has_database_privilege('agent_worker', current_database(), 'CONNECT') as db_connect,
                has_database_privilege('agent_worker', current_database(), 'CREATE') as db_create`,
      );
      expect(schemaState.rows[0]).toEqual({
        public_usage: true,
        public_create: false,
        db_connect: true,
        db_create: false,
      });

      await client.query(
        `insert into public.organizations (id, slug, legal_name, display_name)
         values
           ($1, $3 || '-a', 'Worker A', 'Worker A'),
           ($2, $3 || '-b', 'Worker B', 'Worker B')`,
        [orgA, orgB, `worker-acl-${suffix}`],
      );

      const platform = await client.query(
        `select 1 from public.playbook_pointers
          where organization_id is null and layer = 'platform' limit 1`,
      );
      if ((platform.rowCount ?? 0) === 0) {
        const version = await client.query<{ id: string }>(
          `insert into public.playbook_versions (organization_id, layer, content)
           values (null, 'platform', '## Worker ACL platform fixture') returning id`,
        );
        await client.query(
          `insert into public.playbook_pointers (organization_id, layer, version_id)
           values (null, 'platform', $1)`,
          [version.rows[0]?.id],
        );
      }

      const tenantIds = [orgA, orgB] as const;
      for (const [index, organizationId] of tenantIds.entries()) {
        const marker = index === 0 ? 'WORKER_TENANT_A_MARKER' : 'WORKER_TENANT_B_MARKER';
        const version = await client.query<{ id: string }>(
          `insert into public.playbook_versions (organization_id, layer, content)
           values ($1, 'tenant', $2) returning id`,
          [organizationId, `## ${marker}`],
        );
        await client.query(
          `insert into public.playbook_pointers (organization_id, layer, version_id)
           values ($1, 'tenant', $2)`,
          [organizationId, version.rows[0]?.id],
        );
      }

      const tenantBExists = await client.query(
        `select 1 from public.playbook_versions where organization_id = $1 and content like '%WORKER_TENANT_B_MARKER%'`,
        [orgB],
      );
      expect(tenantBExists.rowCount).toBe(1);

      await client.query('set local role agent_worker');

      const tenantAPlaybook = await loadPlaybook(
        client as unknown as Parameters<typeof loadPlaybook>[0],
        orgA,
      );
      expect(tenantAPlaybook.prompt).toContain('WORKER_TENANT_A_MARKER');
      expect(tenantAPlaybook.prompt).not.toContain('WORKER_TENANT_B_MARKER');

      const inserted = await enqueueJob(client, orgA, {
        kind: 'watchdog',
        payload: { test_fixture: 'worker-acl-contract' },
      });
      const selected = await client.query(
        'select id from public.job_queue where organization_id = $1 and id = $2',
        [orgA, inserted.job.id],
      );
      expect(selected.rowCount).toBe(1);

      const updated = await client.query(
        `update public.job_queue
            set status = 'done'
          where organization_id = $1 and id = $2 and status = 'pending'
          returning id`,
        [orgA, inserted.job.id],
      );
      expect(updated.rowCount).toBe(1);

      await client.query('savepoint deny_queue_delete');
      let deleteError: unknown;
      try {
        await client.query('delete from public.job_queue where id = $1', [inserted.job.id]);
      } catch (error) {
        deleteError = error;
      }
      expect(deleteError).toMatchObject({ code: '42501' });
      await client.query('rollback to savepoint deny_queue_delete');

      await client.query('savepoint deny_queue_truncate');
      let truncateError: unknown;
      try {
        await client.query('truncate table public.job_queue');
      } catch (error) {
        truncateError = error;
      }
      expect(truncateError).toMatchObject({ code: '42501' });
      await client.query('rollback to savepoint deny_queue_truncate');

      for (const operation of ['update', 'delete'] as const) {
        await client.query(`savepoint deny_playbook_${operation}`);
        let error: unknown;
        try {
          const statement =
            operation === 'update'
              ? 'update public.playbook_versions set content = content where false'
              : 'delete from public.playbook_versions where false';
          await client.query(statement);
        } catch (caught) {
          error = caught;
        }
        expect(error).toMatchObject({ code: '42501' });
        await client.query(`rollback to savepoint deny_playbook_${operation}`);
      }
    } finally {
      await client.query('rollback').catch(() => undefined);
      client.release();
    }
  }, 30_000);

  it('serializa dois contenders: um único claim e conclusão válida do lease', async () => {
    const organizationId = randomUUID();
    const suffix = randomUUID();
    let jobId: string | undefined;

    try {
      await adminPool.query(
        `insert into public.organizations (id, slug, legal_name, display_name)
         values ($1, $2, 'Queue ACL fixture', 'Queue ACL fixture')`,
        [organizationId, `worker-queue-acl-${suffix}`],
      );

      const enqueueClient = await connectAsAgentWorker();
      try {
        const { job } = await enqueueJob(enqueueClient, organizationId, {
          kind: 'watchdog',
          payload: { test_fixture: 'worker-queue-concurrency' },
        });
        jobId = job.id;
      } finally {
        enqueueClient.release();
      }

      const workerA = `acl-a-${suffix}`;
      const workerB = `acl-b-${suffix}`;
      const [claimedA, claimedB] = await Promise.all([
        claimJobs(queueWorkerPool, { workerId: workerA, maxConcurrency: 4, batchSize: 1 }),
        claimJobs(queueWorkerPool, { workerId: workerB, maxConcurrency: 4, batchSize: 1 }),
      ]);
      const claimed = [...claimedA, ...claimedB];
      expect(claimed).toHaveLength(1);

      const lease = claimed[0];
      if (!lease) throw new Error('a fila não retornou o job claimado');
      expect([workerA, workerB]).toContain(lease.locked_by);
      await completeJob(queueWorkerPool, lease.id, lease.locked_by ?? '', undefined, lease.claim_acquired_at);

      const completed = await adminPool.query(
        'select status from public.job_queue where id = $1',
        [lease.id],
      );
      expect(completed.rows[0]?.status).toBe('done');
    } finally {
      if (jobId) await adminPool.query('delete from public.job_queue where id = $1', [jobId]);
      await adminPool.query('delete from public.organizations where id = $1', [organizationId]);
    }
  }, 30_000);

  it('permite que agent_worker grave um desfecho pelo trigger de event_log', async () => {
    const organizationId = randomUUID();
    const otherOrganizationId = randomUUID();
    const suffix = randomUUID();
    let eventId: string | undefined;

    await adminPool.query(
      `insert into public.organizations (id, slug, legal_name, display_name)
       values
         ($1, $3 || '-a', 'Worker event log A', 'Worker event log A'),
         ($2, $3 || '-b', 'Worker event log B', 'Worker event log B')`,
      [organizationId, otherOrganizationId, `worker-event-log-trigger-${suffix}`],
    );

    const worker = await connectAsAgentWorker();
    try {
      const result = await worker.query<{ id: string; status: string }>(
        `insert into public.event_log
           (organization_id, event_type, entity_kind, status, payload, metadata)
         values
           ($1, 'agent.operator_turn', 'agent', 'pending', $2::jsonb, $3::jsonb)
         returning id, status`,
        [
          organizationId,
          JSON.stringify({ test_fixture: 'worker-trigger-acl', organization_id: otherOrganizationId }),
          JSON.stringify({ test_fixture: 'worker-trigger-acl' }),
        ],
      );
      const row = result.rows[0];
      if (!row) throw new Error('event_log did not return the inserted worker event');
      eventId = row.id;
      expect(row.status).toBe('pending');

      const persisted = await adminPool.query<{
        organization_id: string;
        event_type: string;
        status: string;
      }>(
        `select organization_id::text, event_type, status
           from public.event_log where id = $1`,
        [eventId],
      );
      expect(persisted.rows[0]).toEqual({
        organization_id: organizationId,
        event_type: 'agent.operator_turn',
        status: 'pending',
      });
    } finally {
      worker.release();
      if (eventId) await adminPool.query('delete from public.event_log where id = $1', [eventId]);
      await adminPool.query('delete from public.organizations where id = any($1::uuid[])', [
        [organizationId, otherOrganizationId],
      ]);
    }
  }, 30_000);

  it('permite que agent_worker registre eventos pelo fn_log_event sem aceitar org do payload', async () => {
    const organizationId = randomUUID();
    const otherOrganizationId = randomUUID();
    const suffix = randomUUID();
    let eventId: string | undefined;

    await adminPool.query(
      `insert into public.organizations (id, slug, legal_name, display_name)
       values
         ($1, $3 || '-a', 'Worker log function A', 'Worker log function A'),
         ($2, $3 || '-b', 'Worker log function B', 'Worker log function B')`,
      [organizationId, otherOrganizationId, `worker-log-function-${suffix}`],
    );

    const worker = await connectAsAgentWorker();
    try {
      const result = await worker.query<{ event_id: string }>(
        `select public.fn_log_event($1::uuid, 'agent.operator_turn', $2::jsonb)::text as event_id`,
        [
          organizationId,
          JSON.stringify({ test_fixture: 'worker-log-function-acl', organization_id: otherOrganizationId }),
        ],
      );
      eventId = result.rows[0]?.event_id;
      if (!eventId) throw new Error('fn_log_event did not return the inserted event id');

      const persisted = await adminPool.query<{ organization_id: string; event_type: string }>(
        `select organization_id::text, event_type
           from public.event_log where id = $1`,
        [eventId],
      );
      expect(persisted.rows[0]).toEqual({
        organization_id: organizationId,
        event_type: 'agent.operator_turn',
      });
    } finally {
      worker.release();
      if (eventId) await adminPool.query('delete from public.event_log where id = $1', [eventId]);
      await adminPool.query('delete from public.organizations where id = any($1::uuid[])', [
        [organizationId, otherOrganizationId],
      ]);
    }
  }, 30_000);
});
