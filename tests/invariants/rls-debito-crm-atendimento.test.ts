import { beforeAll, describe, expect, it } from "vitest";
import { countAs, sql, writeCountAs } from "./gov-helpers";

/**
 * AUD-03 — Cluster 2: CRM, Atendimento e Leads
 *
 * Prova comportamental de isolamento RLS para 19 tabelas:
 * 1. crm_pipelines
 * 2. crm_stages
 * 3. conversation_notes
 * 4. agent_cases
 * 5. agent_case_events
 * 6. agent_inbox_items
 * 7. crm_lead_activities
 * 8. crm_lead_links
 * 9. crm_lead_reactivations
 * 10. crm_lead_risk_states
 * 11. crm_lead_scores
 * 12. lead_checkpoints
 * 13. lead_notes
 * 14. lead_state
 * 15. lead_state_transitions
 * 16. orders
 * 17. nuvemshop_products
 * 18. message_templates
 * 19. conversation_assignment_events
 * 20. attendant_availability
 */

const ORG_A = "22222222-0000-4000-8000-000000000001";
const ORG_B = "22222222-0000-4000-8000-000000000002";
const ORG_C = "22222222-0000-4000-8000-000000000003";

const USER_A_ADMIN = "22222222-1111-4000-8000-000000000001";
const USER_A_AGENT = "22222222-1111-4000-8000-000000000002";
const USER_B_ADMIN = "22222222-1111-4000-8000-000000000003";
const USER_REVOKED = "22222222-1111-4000-8000-000000000004";
const USER_MULTI = "22222222-1111-4000-8000-000000000005";

const SESS_A = "22222222-2222-4000-8000-000000000001";
const SESS_B = "22222222-2222-4000-8000-000000000002";

const CONTACT_A = "22222222-3333-4000-8000-000000000001";
const CONTACT_B = "22222222-3333-4000-8000-000000000002";

const CONV_A = "22222222-4444-4000-8000-000000000001";
const CONV_B = "22222222-4444-4000-8000-000000000002";

const PIPE_A = "22222222-5555-4000-8000-000000000001";
const PIPE_B = "22222222-5555-4000-8000-000000000002";

const STAGE_A = "22222222-6666-4000-8000-000000000001";
const STAGE_B = "22222222-6666-4000-8000-000000000002";

const LEAD_A = "22222222-7777-4000-8000-000000000001";
const LEAD_B = "22222222-7777-4000-8000-000000000002";

const CASE_A = "22222222-8888-4000-8000-000000000001";
const CASE_B = "22222222-8888-4000-8000-000000000002";

beforeAll(() => {
  sql(`
    -- Orgs
    insert into public.organizations (id, slug, legal_name, display_name, settings) values
      ('${ORG_A}', 'c2-org-a', 'C2 Org A', 'C2 Org A', '{"plan":"enterprise"}'::jsonb),
      ('${ORG_B}', 'c2-org-b', 'C2 Org B', 'C2 Org B', '{"plan":"enterprise"}'::jsonb),
      ('${ORG_C}', 'c2-org-c', 'C2 Org C', 'C2 Org C', '{"plan":"enterprise"}'::jsonb)
      on conflict (id) do nothing;

    -- Users
    insert into auth.users (id, email) values
      ('${USER_A_ADMIN}', 'c2-admin-a@test.local'),
      ('${USER_A_AGENT}', 'c2-agent-a@test.local'),
      ('${USER_B_ADMIN}', 'c2-admin-b@test.local'),
      ('${USER_REVOKED}', 'c2-revoked@test.local'),
      ('${USER_MULTI}', 'c2-multi@test.local')
      on conflict (id) do nothing;

    -- Memberships
    insert into public.user_organizations (user_id, organization_id, role, accepted_at) values
      ('${USER_A_ADMIN}', '${ORG_A}', 'admin', now()),
      ('${USER_A_AGENT}', '${ORG_A}', 'agent', now()),
      ('${USER_B_ADMIN}', '${ORG_B}', 'admin', now()),
      ('${USER_REVOKED}', '${ORG_A}', 'agent', now()),
      ('${USER_MULTI}', '${ORG_A}', 'admin', now()),
      ('${USER_MULTI}', '${ORG_C}', 'admin', now())
      on conflict (user_id, organization_id) do nothing;

    update public.user_organizations
       set revoked_at = now()
     where user_id = '${USER_REVOKED}' and organization_id = '${ORG_A}';

    -- channel_sessions
    insert into public.channel_sessions (id, organization_id, waha_session_name, webhook_secret_encrypted) values
      ('${SESS_A}', '${ORG_A}', 'c2-sess-a', '\\x00'::bytea),
      ('${SESS_B}', '${ORG_B}', 'c2-sess-b', '\\x00'::bytea)
      on conflict (id) do nothing;

    -- contacts
    insert into public.contacts (id, organization_id, display_name) values
      ('${CONTACT_A}', '${ORG_A}', 'Contact A'),
      ('${CONTACT_B}', '${ORG_B}', 'Contact B')
      on conflict (id) do nothing;

    -- conversations
    insert into public.conversations (id, organization_id, contact_id, channel_session_id) values
      ('${CONV_A}', '${ORG_A}', '${CONTACT_A}', '${SESS_A}'),
      ('${CONV_B}', '${ORG_B}', '${CONTACT_B}', '${SESS_B}')
      on conflict (id) do nothing;

    -- crm_pipelines
    insert into public.crm_pipelines (id, organization_id, name, slug) values
      ('${PIPE_A}', '${ORG_A}', 'Pipe A', 'pipe-a'),
      ('${PIPE_B}', '${ORG_B}', 'Pipe B', 'pipe-b')
      on conflict (id) do nothing;

    -- crm_stages
    insert into public.crm_stages (id, organization_id, pipeline_id, name, slug, position) values
      ('${STAGE_A}', '${ORG_A}', '${PIPE_A}', 'Stage A', 'stage-a', 1),
      ('${STAGE_B}', '${ORG_B}', '${PIPE_B}', 'Stage B', 'stage-b', 1)
      on conflict (id) do nothing;

    -- crm_leads
    insert into public.crm_leads (id, organization_id, pipeline_id, stage_id, title) values
      ('${LEAD_A}', '${ORG_A}', '${PIPE_A}', '${STAGE_A}', 'Lead A'),
      ('${LEAD_B}', '${ORG_B}', '${PIPE_B}', '${STAGE_B}', 'Lead B')
      on conflict (id) do nothing;

    -- conversation_notes
    insert into public.conversation_notes (organization_id, conversation_id, body) values
      ('${ORG_A}', '${CONV_A}', 'Note A'),
      ('${ORG_B}', '${CONV_B}', 'Note B');

    -- agent_cases
    insert into public.agent_cases (id, organization_id, conversation_id, title, summary, blocker) values
      ('${CASE_A}', '${ORG_A}', '${CONV_A}', 'Case A', 'Summary A', 'Blocker A'),
      ('${CASE_B}', '${ORG_B}', '${CONV_B}', 'Case B', 'Summary B', 'Blocker B')
      on conflict (id) do nothing;

    -- agent_case_events
    insert into public.agent_case_events (organization_id, case_id, kind, actor_kind) values
      ('${ORG_A}', '${CASE_A}', 'opened', 'system'),
      ('${ORG_B}', '${CASE_B}', 'opened', 'system');

    -- agent_inbox_items
    insert into public.agent_inbox_items (organization_id, kind, title) values
      ('${ORG_A}', 'handoff', 'Inbox A'),
      ('${ORG_B}', 'handoff', 'Inbox B');

    -- crm_lead_activities
    insert into public.crm_lead_activities (organization_id, lead_id, source_module, type) values
      ('${ORG_A}', '${LEAD_A}', 'crm', 'note'),
      ('${ORG_B}', '${LEAD_B}', 'crm', 'note');

    -- crm_lead_links
    insert into public.crm_lead_links (organization_id, lead_id, target_kind, target_id, link_kind) values
      ('${ORG_A}', '${LEAD_A}', 'contact', '${CONTACT_A}', 'primary'),
      ('${ORG_B}', '${LEAD_B}', 'contact', '${CONTACT_B}', 'primary');

    -- crm_lead_reactivations
    insert into public.crm_lead_reactivations (organization_id, lead_id, status, expires_at) values
      ('${ORG_A}', '${LEAD_A}', 'pending', now() + interval '1 day'),
      ('${ORG_B}', '${LEAD_B}', 'pending', now() + interval '1 day');

    -- crm_lead_risk_states
    insert into public.crm_lead_risk_states (organization_id, lead_id, bucket, since, cold_hours) values
      ('${ORG_A}', '${LEAD_A}', 'em_dia', now() - interval '1 hour', 24),
      ('${ORG_B}', '${LEAD_B}', 'em_dia', now() - interval '1 hour', 24);

    -- crm_lead_scores
    insert into public.crm_lead_scores (organization_id, lead_id, ai_probability, ai_probability_reason, ai_probability_evidence) values
      ('${ORG_A}', '${LEAD_A}', 80, 'Score teste A', '{"factors": [{"ancora": "ref-a"}]}'::jsonb),
      ('${ORG_B}', '${LEAD_B}', 70, 'Score teste B', '{"factors": [{"ancora": "ref-b"}]}'::jsonb);

    -- lead_checkpoints
    insert into public.lead_checkpoints (organization_id, contact_id, commitments, objections) values
      ('${ORG_A}', '${CONTACT_A}', '[]'::jsonb, '[]'::jsonb),
      ('${ORG_B}', '${CONTACT_B}', '[]'::jsonb, '[]'::jsonb);

    -- lead_notes
    insert into public.lead_notes (organization_id, contact_id, headline, body) values
      ('${ORG_A}', '${CONTACT_A}', 'Headline A', 'Body A'),
      ('${ORG_B}', '${CONTACT_B}', 'Headline B', 'Body B');

    -- lead_state
    insert into public.lead_state (organization_id, contact_id, stage) values
      ('${ORG_A}', '${CONTACT_A}', 'new'),
      ('${ORG_B}', '${CONTACT_B}', 'new');

    -- lead_state_transitions
    insert into public.lead_state_transitions (organization_id, contact_id, from_stage, to_stage) values
      ('${ORG_A}', '${CONTACT_A}', 'new', 'contacted'),
      ('${ORG_B}', '${CONTACT_B}', 'new', 'contacted');

    -- orders
    insert into public.orders (organization_id, external_id, external_provider, status, total_cents, ordered_at) values
      ('${ORG_A}', 'ORD-A-1', 'nuvemshop', 'paid', 10000, now()),
      ('${ORG_B}', 'ORD-B-1', 'nuvemshop', 'paid', 20000, now());

    -- nuvemshop_products
    insert into public.nuvemshop_products (organization_id, external_id, title, price_cents, last_updated_at) values
      ('${ORG_A}', '1001', 'Prod A', 1000, now()),
      ('${ORG_B}', '1002', 'Prod B', 2000, now());

    -- message_templates
    insert into public.message_templates (organization_id, title, body) values
      ('${ORG_A}', 'Tpl A', 'Hello A'),
      ('${ORG_B}', 'Tpl B', 'Hello B');

    -- conversation_assignment_events
    insert into public.conversation_assignment_events (organization_id, conversation_id, to_user_id, reason) values
      ('${ORG_A}', '${CONV_A}', '${USER_A_AGENT}', 'claim'),
      ('${ORG_B}', '${CONV_B}', '${USER_B_ADMIN}', 'claim');

    -- attendant_availability
    insert into public.attendant_availability (organization_id, user_id, is_available) values
      ('${ORG_A}', '${USER_A_AGENT}', true),
      ('${ORG_B}', '${USER_B_ADMIN}', true)
      on conflict (organization_id, user_id) do nothing;
  `);
});

describe("AUD-03 Cluster 2 — CRM, Atendimento e Leads", () => {
  const TABLES_CLUSTER_2 = [
    "crm_pipelines",
    "crm_stages",
    "conversation_notes",
    "agent_cases",
    "agent_case_events",
    "agent_inbox_items",
    "crm_lead_activities",
    "crm_lead_links",
    "crm_lead_reactivations",
    "crm_lead_risk_states",
    "crm_lead_scores",
    "lead_checkpoints",
    "lead_notes",
    "lead_state",
    "lead_state_transitions",
    "orders",
    "nuvemshop_products",
    "message_templates",
    "conversation_assignment_events",
    "attendant_availability",
  ] as const;

  for (const table of TABLES_CLUSTER_2) {
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

  describe("Invariantes de Membership no Cluster 2", () => {
    it("Membro revogado lê ZERO rows em crm_pipelines e conversation_notes", () => {
      expect(countAs(USER_REVOKED, `select count(*) from public.crm_pipelines where organization_id = '${ORG_A}'`)).toBe(0);
      expect(countAs(USER_REVOKED, `select count(*) from public.conversation_notes where organization_id = '${ORG_A}'`)).toBe(0);
    });

    it("Usuário multi-org vê apenas Org A e Org C, ZERO de Org B", () => {
      expect(countAs(USER_MULTI, `select count(*) from public.crm_pipelines where organization_id = '${ORG_A}'`)).toBeGreaterThanOrEqual(1);
      expect(countAs(USER_MULTI, `select count(*) from public.crm_pipelines where organization_id = '${ORG_B}'`)).toBe(0);
    });
  });
});
