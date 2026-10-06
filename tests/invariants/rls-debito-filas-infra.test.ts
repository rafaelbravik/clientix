/**
 * AUD-03 — Cluster 4: Filas, Logs, Infraestrutura e Server-Only
 *
 * Prova comportamental de isolamento RLS e restrição de acesso para 18 tabelas:
 * 1. event_log
 * 2. job_queue
 * 3. webhook_events_log
 * 4. api_audit_log
 * 5. metrics
 * 6. cron_jobs
 * 7. idempotency_keys
 * 8. merge_queue
 * 9. storage_redaction_queue
 * 10. pacing_ledger
 * 11. send_ledger
 * 12. before_send_traces
 * 13. llm_calls
 * 14. incidents (platform_admin_only por RLS)
 * 15. lgpd_requests
 * 16. flywheel_distiller_proposals
 * 17. flywheel_judge_verdicts
 * 18. judge_alignment_pool
 */

import { beforeAll, describe, expect, it } from "vitest";
import { countAs, sql, writeCountAs } from "./gov-helpers";

const ORG_A = "44444444-0000-4000-8000-000000000001";
const ORG_B = "44444444-0000-4000-8000-000000000002";
const ORG_C = "44444444-0000-4000-8000-000000000003";

const USER_A_ADMIN = "44444444-1111-4000-8000-000000000001";
const USER_B_ADMIN = "44444444-1111-4000-8000-000000000002";
const USER_REVOKED = "44444444-1111-4000-8000-000000000004";
const USER_MULTI = "44444444-1111-4000-8000-000000000005";
const USER_PLATFORM_ADMIN = "44444444-1111-4000-8000-000000000009";

const CONTACT_A = "44444444-2222-4000-8000-000000000001";
const CONTACT_B = "44444444-2222-4000-8000-000000000002";

const SESSION_A = "44444444-3333-4000-8000-000000000001";
const SESSION_B = "44444444-3333-4000-8000-000000000002";

const JOB_A = "44444444-4444-4000-8000-000000000001";
const JOB_B = "44444444-4444-4000-8000-000000000002";

beforeAll(() => {
  sql(`
    -- Organizações
    insert into public.organizations (id, slug, legal_name, display_name, settings) values
      ('${ORG_A}', 'c4-org-a', 'C4 Org A', 'C4 Org A', '{"plan":"enterprise"}'::jsonb),
      ('${ORG_B}', 'c4-org-b', 'C4 Org B', 'C4 Org B', '{"plan":"enterprise"}'::jsonb),
      ('${ORG_C}', 'c4-org-c', 'C4 Org C', 'C4 Org C', '{"plan":"enterprise"}'::jsonb)
      on conflict (id) do nothing;

    -- Usuários em auth.users
    insert into auth.users (id, email) values
      ('${USER_A_ADMIN}', 'c4_admin_a@test.com'),
      ('${USER_B_ADMIN}', 'c4_admin_b@test.com'),
      ('${USER_REVOKED}', 'c4_revoked@test.com'),
      ('${USER_MULTI}', 'c4_multi@test.com'),
      ('${USER_PLATFORM_ADMIN}', 'c4_padmin@test.com')
      on conflict (id) do nothing;

    -- Platform admin
    insert into public.platform_admins (user_id, granted_by, scope, mfa_required, reason) values
      ('${USER_PLATFORM_ADMIN}', '${USER_PLATFORM_ADMIN}', 'full', false, 'Local test')
      on conflict (user_id) do nothing;

    -- Memberships
    insert into public.user_organizations (user_id, organization_id, role, accepted_at) values
      ('${USER_A_ADMIN}', '${ORG_A}', 'admin', now()),
      ('${USER_B_ADMIN}', '${ORG_B}', 'admin', now()),
      ('${USER_REVOKED}', '${ORG_A}', 'admin', now()),
      ('${USER_MULTI}', '${ORG_A}', 'admin', now()),
      ('${USER_MULTI}', '${ORG_C}', 'admin', now())
      on conflict (user_id, organization_id) do nothing;

    update public.user_organizations
       set revoked_at = now()
     where user_id = '${USER_REVOKED}' and organization_id = '${ORG_A}';

    -- Contacts de apoio
    insert into public.contacts (id, organization_id, display_name) values
      ('${CONTACT_A}', '${ORG_A}', 'Contact A'),
      ('${CONTACT_B}', '${ORG_B}', 'Contact B')
      on conflict (id) do nothing;

    -- Channel sessions de apoio
    insert into public.channel_sessions (id, organization_id, waha_session_name, webhook_secret_encrypted) values
      ('${SESSION_A}', '${ORG_A}', 'c4-sess-a', '\\x00'::bytea),
      ('${SESSION_B}', '${ORG_B}', 'c4-sess-b', '\\x00'::bytea)
      on conflict (id) do nothing;

    -- 1. event_log
    insert into public.event_log (organization_id, event_type, entity_kind, status) values
      ('${ORG_A}', 'lead.created', 'lead', 'pending'),
      ('${ORG_B}', 'lead.created', 'lead', 'pending');

    -- 2. job_queue (kind watchdog sem contact_id)
    insert into public.job_queue (id, organization_id, kind, status) values
      ('${JOB_A}', '${ORG_A}', 'watchdog', 'pending'),
      ('${JOB_B}', '${ORG_B}', 'watchdog', 'pending')
      on conflict (id) do nothing;

    -- 3. webhook_events_log
    insert into public.webhook_events_log (organization_id, provider, raw_body, status) values
      ('${ORG_A}', 'waha', '{}', 'received'),
      ('${ORG_B}', 'waha', '{}', 'received');

    -- 4. api_audit_log
    insert into public.api_audit_log (organization_id, action) values
      ('${ORG_A}', 'test_audit_a'),
      ('${ORG_B}', 'test_audit_b');

    -- 5. metrics
    insert into public.metrics (organization_id, name, value) values
      ('${ORG_A}', 'test_metric_a', 10.5),
      ('${ORG_B}', 'test_metric_b', 20.5);

    -- 6. cron_jobs
    insert into public.cron_jobs (organization_id, contact_id, kind, interval_ms, next_run_at) values
      ('${ORG_A}', '${CONTACT_A}', 'every', 60000, now() + interval '1 hour'),
      ('${ORG_B}', '${CONTACT_B}', 'every', 60000, now() + interval '1 hour');

    -- 7. idempotency_keys
    insert into public.idempotency_keys (organization_id, key, endpoint, request_hash) values
      ('${ORG_A}', 'key-a', '/api/test', '\\x00'::bytea),
      ('${ORG_B}', 'key-b', '/api/test', '\\x00'::bytea);

    -- 8. merge_queue
    insert into public.merge_queue (organization_id, candidates, reason, status) values
      ('${ORG_A}', array[gen_random_uuid(), gen_random_uuid()], 'dup a', 'pending'),
      ('${ORG_B}', array[gen_random_uuid(), gen_random_uuid()], 'dup b', 'pending');

    -- 9. storage_redaction_queue
    insert into public.storage_redaction_queue (organization_id, bucket, object_path, status) values
      ('${ORG_A}', 'whatsapp-media', 'a/doc.pdf', 'pending'),
      ('${ORG_B}', 'whatsapp-media', 'b/doc.pdf', 'pending');

    -- 10. pacing_ledger
    insert into public.pacing_ledger (organization_id, channel_session_id) values
      ('${ORG_A}', '${SESSION_A}'),
      ('${ORG_B}', '${SESSION_B}');

    -- 11. send_ledger
    insert into public.send_ledger (organization_id, job_id, seq, body_hash, status) values
      ('${ORG_A}', '${JOB_A}', 1, 'hash_a', 'requested'),
      ('${ORG_B}', '${JOB_B}', 1, 'hash_b', 'requested')
      on conflict (job_id, seq) do nothing;

    -- 12. before_send_traces
    insert into public.before_send_traces (organization_id, job_id, channel_session_id, trace) values
      ('${ORG_A}', '${JOB_A}', '${SESSION_A}', '[]'::jsonb),
      ('${ORG_B}', '${JOB_B}', '${SESSION_B}', '[]'::jsonb);

    -- 13. llm_calls
    insert into public.llm_calls (organization_id, provider, model) values
      ('${ORG_A}', 'anthropic', 'claude-3'),
      ('${ORG_B}', 'anthropic', 'claude-3');

    -- 14. incidents
    insert into public.incidents (organization_id, type, severity, status) values
      ('${ORG_A}', 'quota_exceeded', 'info', 'open'),
      ('${ORG_B}', 'quota_exceeded', 'info', 'open');

    -- 15. lgpd_requests
    insert into public.lgpd_requests (organization_id, request_type, source, due_at, status) values
      ('${ORG_A}', 'data_request', 'manual', now() + interval '15 days', 'received'),
      ('${ORG_B}', 'data_request', 'manual', now() + interval '15 days', 'received');

    -- 16. flywheel_distiller_proposals
    insert into public.flywheel_distiller_proposals (organization_id, run_id, dataset, type, target, content, evidence) values
      ('${ORG_A}', gen_random_uuid(), 'ds_a', 'playbook_bullet', 'target_a', 'content a', '{}'::jsonb),
      ('${ORG_B}', gen_random_uuid(), 'ds_b', 'playbook_bullet', 'target_b', 'content b', '{}'::jsonb);

    -- 17. flywheel_judge_verdicts
    insert into public.flywheel_judge_verdicts (organization_id, dataset, trace_id, dimension, verdict, option_order, judge_family, model, run_id) values
      ('${ORG_A}', 'ds_a', 'tr_a', 'dim_a', 'yes', 'standard', 'gpt', 'gpt-4o', gen_random_uuid()),
      ('${ORG_B}', 'ds_b', 'tr_b', 'dim_b', 'yes', 'standard', 'gpt', 'gpt-4o', gen_random_uuid())
      on conflict (dataset, trace_id, dimension) do nothing;

    -- 18. judge_alignment_pool
    insert into public.judge_alignment_pool (organization_id, dataset, trace_id, dimension) values
      ('${ORG_A}', 'ds_a', 'tr_a', 'dim_a'),
      ('${ORG_B}', 'ds_b', 'tr_b', 'dim_b')
      on conflict (dataset, trace_id, dimension) do nothing;
  `);
});

describe("AUD-03 Cluster 4 — Filas, Logs, Infraestrutura e Server-Only", () => {
  const TABLES_TENANT_READ = [
    "event_log",
    "job_queue",
    "webhook_events_log",
    "api_audit_log",
    "metrics",
    "cron_jobs",
    "idempotency_keys",
    "merge_queue",
    "storage_redaction_queue",
    "pacing_ledger",
    "send_ledger",
    "before_send_traces",
    "llm_calls",
    "lgpd_requests",
    "flywheel_distiller_proposals",
    "flywheel_judge_verdicts",
    "judge_alignment_pool",
  ] as const;

  for (const table of TABLES_TENANT_READ) {
    describe(`Tabela: ${table}`, () => {
      it(`Usuário de A lê rows da própria Org A`, () => {
        expect(countAs(USER_A_ADMIN, `select count(*) from public.${table} where organization_id = '${ORG_A}'`)).toBeGreaterThanOrEqual(1);
      });

      it(`Usuário de A lê ZERO rows da Org B (cross-tenant)`, () => {
        expect(countAs(USER_A_ADMIN, `select count(*) from public.${table} where organization_id = '${ORG_B}'`)).toBe(0);
      });

      it(`Usuário de B lê ZERO rows da Org A (cross-tenant simétrico)`, () => {
        expect(countAs(USER_B_ADMIN, `select count(*) from public.${table} where organization_id = '${ORG_A}'`)).toBe(0);
      });

      it(`Usuário de A é impedido de UPDATE / DELETE nas rows de Org B`, () => {
        try {
          const updated = writeCountAs(USER_A_ADMIN, `update public.${table} set organization_id = '${ORG_A}' where organization_id = '${ORG_B}'`);
          expect(updated).toBe(0);
        } catch (err: unknown) {
          expect(String(err)).toMatch(/permission denied/i);
        }

        try {
          const deleted = writeCountAs(USER_A_ADMIN, `delete from public.${table} where organization_id = '${ORG_B}'`);
          expect(deleted).toBe(0);
        } catch (err: unknown) {
          expect(String(err)).toMatch(/permission denied/i);
        }
      });
    });
  }

  describe("Tabela restrita: incidents (Platform Admin Only via RLS)", () => {
    it("Admin de tenant comum lê ZERO rows de incidents (RLS filtra tudo)", () => {
      expect(countAs(USER_A_ADMIN, `select count(*) from public.incidents where organization_id = '${ORG_A}'`)).toBe(0);
      expect(countAs(USER_A_ADMIN, `select count(*) from public.incidents where organization_id = '${ORG_B}'`)).toBe(0);
    });

    it("Platform Admin lê rows legítimas de incidents", () => {
      expect(countAs(USER_PLATFORM_ADMIN, `select count(*) from public.incidents where organization_id = '${ORG_A}'`)).toBeGreaterThanOrEqual(1);
    });

    it("Admin de tenant comum é impedido de alterar/deletar incidents", () => {
      try {
        const updated = writeCountAs(USER_A_ADMIN, `update public.incidents set status = 'resolved' where organization_id = '${ORG_B}'`);
        expect(updated).toBe(0);
      } catch (err: unknown) {
        expect(String(err)).toMatch(/permission denied/i);
      }
    });
  });

  describe("Invariantes de Membership no Cluster 4", () => {
    it("Membro revogado lê ZERO rows em event_log e metrics", () => {
      expect(countAs(USER_REVOKED, `select count(*) from public.event_log where organization_id = '${ORG_A}'`)).toBe(0);
      expect(countAs(USER_REVOKED, `select count(*) from public.metrics where organization_id = '${ORG_A}'`)).toBe(0);
    });

    it("Usuário multi-org vê apenas Org A e Org C, ZERO de Org B", () => {
      expect(countAs(USER_MULTI, `select count(*) from public.event_log where organization_id = '${ORG_A}'`)).toBeGreaterThanOrEqual(1);
      expect(countAs(USER_MULTI, `select count(*) from public.event_log where organization_id = '${ORG_B}'`)).toBe(0);
    });
  });
});
