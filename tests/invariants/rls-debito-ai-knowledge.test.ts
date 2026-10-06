/**
 * AUD-03 — Cluster 3: IA, Knowledge Base e RAG
 *
 * Prova comportamental de isolamento RLS para 25 tabelas do cluster de IA:
 * 1. ai_agents
 * 2. ai_agent_versions
 * 3. ai_agent_runs
 * 4. ai_chunks
 * 5. ai_faq_items
 * 6. ai_knowledge_sources
 * 7. ai_knowledge_versions
 * 8. ai_budgets
 * 9. ai_invocations
 * 10. ai_purpose_bindings
 * 11. ai_router_members
 * 12. org_memory_pointers
 * 13. skill_pointers
 * 14. skill_versions
 * 15. playbook_pointers
 * 16. playbook_versions
 * 17. reentry_knob_pointers
 * 18. reentry_knob_versions
 * 19. reentry_template_pointers
 * 20. reentry_template_versions
 * 21. promise_table_pointers
 * 22. promise_table_versions
 * 23. disclosure_template_pointers
 * 24. disclosure_template_versions
 * 25. outbound_copies
 */

import { beforeAll, describe, expect, it } from "vitest";
import { countAs, sql, writeCountAs } from "./gov-helpers";

const ORG_A = "33333333-0000-4000-8000-000000000001";
const ORG_B = "33333333-0000-4000-8000-000000000002";
const ORG_C = "33333333-0000-4000-8000-000000000003";

const USER_A_ADMIN = "33333333-1111-4000-8000-000000000001";
const USER_B_ADMIN = "33333333-1111-4000-8000-000000000002";
const USER_REVOKED = "33333333-1111-4000-8000-000000000004";
const USER_MULTI = "33333333-1111-4000-8000-000000000005";

const SESSION_A = "33333333-2222-4000-8000-000000000001";
const SESSION_B = "33333333-2222-4000-8000-000000000002";

const AGENT_A = "33333333-3333-4000-8000-000000000001";
const AGENT_B = "33333333-3333-4000-8000-000000000002";

const AGENT_VER_A = "33333333-4444-4000-8000-000000000001";
const AGENT_VER_B = "33333333-4444-4000-8000-000000000002";

const KB_SRC_A = "33333333-5555-4000-8000-000000000001";
const KB_SRC_B = "33333333-5555-4000-8000-000000000002";

const KB_VER_A = "33333333-6666-4000-8000-000000000001";
const KB_VER_B = "33333333-6666-4000-8000-000000000002";

const ROUTER_A = "33333333-7777-4000-8000-000000000001";
const ROUTER_B = "33333333-7777-4000-8000-000000000002";

const SKILL_VER_A = "33333333-8888-4000-8000-000000000001";
const SKILL_VER_B = "33333333-8888-4000-8000-000000000002";

const PLAYBOOK_VER_A = "33333333-9999-4000-8000-000000000001";
const PLAYBOOK_VER_B = "33333333-9999-4000-8000-000000000002";

const REENTRY_KNOB_VER_A = "33333333-aaaa-4000-8000-000000000001";
const REENTRY_KNOB_VER_B = "33333333-aaaa-4000-8000-000000000002";

const REENTRY_TPL_VER_A = "33333333-bbbb-4000-8000-000000000001";
const REENTRY_TPL_VER_B = "33333333-bbbb-4000-8000-000000000002";

const PROMISE_VER_A = "33333333-cccc-4000-8000-000000000001";
const PROMISE_VER_B = "33333333-cccc-4000-8000-000000000002";

const DISCLOSURE_VER_A = "33333333-dddd-4000-8000-000000000001";
const DISCLOSURE_VER_B = "33333333-dddd-4000-8000-000000000002";

const MEMORY_VER_A = "33333333-eeee-4000-8000-000000000001";
const MEMORY_VER_B = "33333333-eeee-4000-8000-000000000002";

beforeAll(() => {
  sql(`
    -- Organizações
    insert into public.organizations (id, slug, legal_name, display_name, settings) values
      ('${ORG_A}', 'ai-org-a', 'AI Org A', 'AI Org A', '{"plan":"enterprise"}'::jsonb),
      ('${ORG_B}', 'ai-org-b', 'AI Org B', 'AI Org B', '{"plan":"enterprise"}'::jsonb),
      ('${ORG_C}', 'ai-org-c', 'AI Org C', 'AI Org C', '{"plan":"enterprise"}'::jsonb)
      on conflict (id) do nothing;

    -- Usuários em auth.users
    insert into auth.users (id, email) values
      ('${USER_A_ADMIN}', 'ai_admin_a@test.com'),
      ('${USER_B_ADMIN}', 'ai_admin_b@test.com'),
      ('${USER_REVOKED}', 'ai_revoked@test.com'),
      ('${USER_MULTI}', 'ai_multi@test.com')
      on conflict (id) do nothing;

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

    -- channel_sessions de apoio
    insert into public.channel_sessions (id, organization_id, waha_session_name, webhook_secret_encrypted) values
      ('${SESSION_A}', '${ORG_A}', 'ai-sess-a', '\\x00'::bytea),
      ('${SESSION_B}', '${ORG_B}', 'ai-sess-b', '\\x00'::bytea)
      on conflict (id) do nothing;

    -- 1. ai_agents
    insert into public.ai_agents (id, organization_id, name, system_prompt) values
      ('${AGENT_A}', '${ORG_A}', 'Agent A', 'Prompt A'),
      ('${AGENT_B}', '${ORG_B}', 'Agent B', 'Prompt B')
      on conflict (id) do nothing;

    -- 2. ai_agent_versions
    insert into public.ai_agent_versions (id, organization_id, agent_id, version_number, system_prompt, provider, model, channel_session_id) values
      ('${AGENT_VER_A}', '${ORG_A}', '${AGENT_A}', 1, 'Prompt A v1', 'anthropic', 'claude-3', '${SESSION_A}'),
      ('${AGENT_VER_B}', '${ORG_B}', '${AGENT_B}', 1, 'Prompt B v1', 'anthropic', 'claude-3', '${SESSION_B}')
      on conflict (id) do nothing;

    -- 3. ai_agent_runs
    insert into public.ai_agent_runs (organization_id, agent_id, agent_version_id, status) values
      ('${ORG_A}', '${AGENT_A}', '${AGENT_VER_A}', 'completed'),
      ('${ORG_B}', '${AGENT_B}', '${AGENT_VER_B}', 'completed');

    -- 6. ai_knowledge_sources
    insert into public.ai_knowledge_sources (id, organization_id, agent_id, source_type, name) values
      ('${KB_SRC_A}', '${ORG_A}', '${AGENT_A}', 'faq', 'KB Source A'),
      ('${KB_SRC_B}', '${ORG_B}', '${AGENT_B}', 'faq', 'KB Source B')
      on conflict (id) do nothing;

    -- 7. ai_knowledge_versions
    insert into public.ai_knowledge_versions (id, organization_id, agent_id, version_number) values
      ('${KB_VER_A}', '${ORG_A}', '${AGENT_A}', 1),
      ('${KB_VER_B}', '${ORG_B}', '${AGENT_B}', 1)
      on conflict (id) do nothing;

    -- 4. ai_chunks (embedding de 1536 dimensões preenchido com zeros)
    insert into public.ai_chunks (organization_id, knowledge_source_id, kb_version_id, position, content, content_hash, token_count, embedding) values
      ('${ORG_A}', '${KB_SRC_A}', '${KB_VER_A}', 0, 'Chunk A', 'hash-a', 10, ('[' || array_to_string(array_fill(0, array[1536]), ',') || ']')::vector),
      ('${ORG_B}', '${KB_SRC_B}', '${KB_VER_B}', 0, 'Chunk B', 'hash-b', 10, ('[' || array_to_string(array_fill(0, array[1536]), ',') || ']')::vector);

    -- 5. ai_faq_items
    insert into public.ai_faq_items (organization_id, knowledge_source_id, question, answer) values
      ('${ORG_A}', '${KB_SRC_A}', 'Question A?', 'Answer A'),
      ('${ORG_B}', '${KB_SRC_B}', 'Question B?', 'Answer B');

    -- 8. ai_budgets
    insert into public.ai_budgets (organization_id, monthly_limit_cents) values
      ('${ORG_A}', 5000),
      ('${ORG_B}', 5000)
      on conflict (organization_id) do nothing;

    -- 9. ai_invocations
    insert into public.ai_invocations (organization_id, agent_id, invocation_kind, model, latency_ms) values
      ('${ORG_A}', '${AGENT_A}', 'bot_respond', 'claude-3', 120),
      ('${ORG_B}', '${AGENT_B}', 'bot_respond', 'claude-3', 150);

    -- 10. ai_purpose_bindings
    insert into public.ai_purpose_bindings (organization_id, purpose, provider, model_id) values
      ('${ORG_A}', 'chat', 'anthropic', 'claude-3'),
      ('${ORG_B}', 'chat', 'anthropic', 'claude-3')
      on conflict (organization_id, purpose) do nothing;

    -- ai_routers de apoio
    insert into public.ai_routers (id, organization_id, channel_session_id, name) values
      ('${ROUTER_A}', '${ORG_A}', '${SESSION_A}', 'Router A'),
      ('${ROUTER_B}', '${ORG_B}', '${SESSION_B}', 'Router B')
      on conflict (id) do nothing;

    -- 11. ai_router_members
    insert into public.ai_router_members (organization_id, router_id, agent_id, intent_name, intent_description) values
      ('${ORG_A}', '${ROUTER_A}', '${AGENT_A}', 'sales', 'Sales intent'),
      ('${ORG_B}', '${ROUTER_B}', '${AGENT_B}', 'support', 'Support intent')
      on conflict (router_id, intent_name) do nothing;

    -- 14. skill_versions
    insert into public.skill_versions (id, organization_id, name, description, body) values
      ('${SKILL_VER_A}', '${ORG_A}', 'skill-a', 'Desc A', 'Body A'),
      ('${SKILL_VER_B}', '${ORG_B}', 'skill-b', 'Desc B', 'Body B')
      on conflict (id) do nothing;

    -- 13. skill_pointers
    insert into public.skill_pointers (organization_id, name, version_id) values
      ('${ORG_A}', 'skill-a', '${SKILL_VER_A}'),
      ('${ORG_B}', 'skill-b', '${SKILL_VER_B}')
      on conflict do nothing;

    -- 16. playbook_versions
    insert into public.playbook_versions (id, organization_id, layer, content) values
      ('${PLAYBOOK_VER_A}', '${ORG_A}', 'tenant', 'Playbook A content'),
      ('${PLAYBOOK_VER_B}', '${ORG_B}', 'tenant', 'Playbook B content')
      on conflict (id) do nothing;

    -- 15. playbook_pointers
    insert into public.playbook_pointers (organization_id, layer, version_id) values
      ('${ORG_A}', 'tenant', '${PLAYBOOK_VER_A}'),
      ('${ORG_B}', 'tenant', '${PLAYBOOK_VER_B}')
      on conflict do nothing;

    -- 18. reentry_knob_versions
    insert into public.reentry_knob_versions (id, organization_id, knobs) values
      ('${REENTRY_KNOB_VER_A}', '${ORG_A}', '{"follow_up_window_hours": 24}'::jsonb),
      ('${REENTRY_KNOB_VER_B}', '${ORG_B}', '{"follow_up_window_hours": 48}'::jsonb)
      on conflict (id) do nothing;

    -- 17. reentry_knob_pointers
    insert into public.reentry_knob_pointers (organization_id, version_id) values
      ('${ORG_A}', '${REENTRY_KNOB_VER_A}'),
      ('${ORG_B}', '${REENTRY_KNOB_VER_B}')
      on conflict (organization_id) do nothing;

    -- 20. reentry_template_versions
    insert into public.reentry_template_versions (id, organization_id, variants) values
      ('${REENTRY_TPL_VER_A}', '${ORG_A}', array['Olá A!']),
      ('${REENTRY_TPL_VER_B}', '${ORG_B}', array['Olá B!'])
      on conflict (id) do nothing;

    -- 19. reentry_template_pointers
    insert into public.reentry_template_pointers (organization_id, version_id) values
      ('${ORG_A}', '${REENTRY_TPL_VER_A}'),
      ('${ORG_B}', '${REENTRY_TPL_VER_B}')
      on conflict (organization_id) do nothing;

    -- 22. promise_table_versions
    insert into public.promise_table_versions (id, organization_id, values) values
      ('${PROMISE_VER_A}', '${ORG_A}', '{"minPriceCents": 1000}'::jsonb),
      ('${PROMISE_VER_B}', '${ORG_B}', '{"minPriceCents": 2000}'::jsonb)
      on conflict (id) do nothing;

    -- 21. promise_table_pointers
    insert into public.promise_table_pointers (organization_id, version_id) values
      ('${ORG_A}', '${PROMISE_VER_A}'),
      ('${ORG_B}', '${PROMISE_VER_B}')
      on conflict (organization_id) do nothing;

    -- 24. disclosure_template_versions
    insert into public.disclosure_template_versions (id, organization_id, body) values
      ('${DISCLOSURE_VER_A}', '${ORG_A}', 'Assistente A'),
      ('${DISCLOSURE_VER_B}', '${ORG_B}', 'Assistente B')
      on conflict (id) do nothing;

    -- 23. disclosure_template_pointers
    insert into public.disclosure_template_pointers (organization_id, version_id) values
      ('${ORG_A}', '${DISCLOSURE_VER_A}'),
      ('${ORG_B}', '${DISCLOSURE_VER_B}')
      on conflict (organization_id) do nothing;

    -- org_memory_versions de apoio
    insert into public.org_memory_versions (id, organization_id, version_number, content) values
      ('${MEMORY_VER_A}', '${ORG_A}', 1, 'Memória Org A'),
      ('${MEMORY_VER_B}', '${ORG_B}', 1, 'Memória Org B')
      on conflict (id) do nothing;

    -- 12. org_memory_pointers
    insert into public.org_memory_pointers (organization_id, version_id) values
      ('${ORG_A}', '${MEMORY_VER_A}'),
      ('${ORG_B}', '${MEMORY_VER_B}')
      on conflict (organization_id) do nothing;

    -- 25. outbound_copies
    insert into public.outbound_copies (organization_id, channel_session_id, normalized_text, normalized_hash) values
      ('${ORG_A}', '${SESSION_A}', 'copy a', 'hash-a'),
      ('${ORG_B}', '${SESSION_B}', 'copy b', 'hash-b');
  `);
});

describe("AUD-03 Cluster 3 — IA, Knowledge Base e RAG", () => {
  const TABLES_CLUSTER_3 = [
    "ai_agents",
    "ai_agent_versions",
    "ai_agent_runs",
    "ai_chunks",
    "ai_faq_items",
    "ai_knowledge_sources",
    "ai_knowledge_versions",
    "ai_budgets",
    "ai_invocations",
    "ai_purpose_bindings",
    "ai_router_members",
    "org_memory_pointers",
    "skill_pointers",
    "skill_versions",
    "playbook_pointers",
    "playbook_versions",
    "reentry_knob_pointers",
    "reentry_knob_versions",
    "reentry_template_pointers",
    "reentry_template_versions",
    "promise_table_pointers",
    "promise_table_versions",
    "disclosure_template_pointers",
    "disclosure_template_versions",
    "outbound_copies",
  ] as const;

  for (const table of TABLES_CLUSTER_3) {
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

  describe("Invariantes de Membership no Cluster 3", () => {
    it("Membro revogado lê ZERO rows em ai_agents e ai_faq_items", () => {
      expect(countAs(USER_REVOKED, `select count(*) from public.ai_agents where organization_id = '${ORG_A}'`)).toBe(0);
      expect(countAs(USER_REVOKED, `select count(*) from public.ai_faq_items where organization_id = '${ORG_A}'`)).toBe(0);
    });

    it("Usuário multi-org vê apenas Org A e Org C, ZERO de Org B", () => {
      expect(countAs(USER_MULTI, `select count(*) from public.ai_agents where organization_id = '${ORG_A}'`)).toBeGreaterThanOrEqual(1);
      expect(countAs(USER_MULTI, `select count(*) from public.ai_agents where organization_id = '${ORG_B}'`)).toBe(0);
    });
  });
});
