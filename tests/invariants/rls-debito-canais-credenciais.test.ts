import { beforeAll, describe, expect, it } from "vitest";
import { countAs, sql, writeCountAs } from "./gov-helpers";

/**
 * AUD-03 — Cluster 1: Credenciais, Sessões e Canais
 *
 * Prova comportamental de isolamento RLS, com JWT simulado (authenticated),
 * tentativas cruzadas de SELECT, INSERT com org_id forjado, UPDATE e DELETE.
 *
 * Tabelas cobertas:
 * 1. channel_sessions
 * 2. api_tokens
 * 3. tenant_integrations
 * 4. calendar_oauth_nonces
 * 5. channel_knobs
 * 6. channel_session_health
 * 7. channel_session_warmup
 */

const ORG_A = "11111111-0000-4000-8000-000000000001";
const ORG_B = "11111111-0000-4000-8000-000000000002";
const ORG_C = "11111111-0000-4000-8000-000000000003"; // Para testar multi-org

const USER_A_ADMIN = "11111111-1111-4000-8000-000000000001";
const USER_A_AGENT = "11111111-1111-4000-8000-000000000002";
const USER_B_ADMIN = "11111111-1111-4000-8000-000000000003";
const USER_REVOKED = "11111111-1111-4000-8000-000000000004";
const USER_MULTI = "11111111-1111-4000-8000-000000000005";

const SESS_A = "11111111-2222-4000-8000-000000000001";
const SESS_B = "11111111-2222-4000-8000-000000000002";
const SESS_C = "11111111-2222-4000-8000-000000000003";

beforeAll(() => {
  sql(`
    -- Inserir organizações
    insert into public.organizations (id, slug, legal_name, display_name, settings) values
      ('${ORG_A}', 'c1-org-a', 'C1 Org A', 'C1 Org A', '{"plan":"enterprise"}'::jsonb),
      ('${ORG_B}', 'c1-org-b', 'C1 Org B', 'C1 Org B', '{"plan":"enterprise"}'::jsonb),
      ('${ORG_C}', 'c1-org-c', 'C1 Org C', 'C1 Org C', '{"plan":"enterprise"}'::jsonb)
      on conflict (id) do nothing;

    -- Inserir usuários auth
    insert into auth.users (id, email) values
      ('${USER_A_ADMIN}', 'c1-admin-a@test.local'),
      ('${USER_A_AGENT}', 'c1-agent-a@test.local'),
      ('${USER_B_ADMIN}', 'c1-admin-b@test.local'),
      ('${USER_REVOKED}', 'c1-revoked@test.local'),
      ('${USER_MULTI}', 'c1-multi@test.local')
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

    -- Revogar membership de USER_REVOKED
    update public.user_organizations
       set revoked_at = now()
     where user_id = '${USER_REVOKED}' and organization_id = '${ORG_A}';

    -- channel_sessions
    insert into public.channel_sessions (id, organization_id, waha_session_name, webhook_secret_encrypted) values
      ('${SESS_A}', '${ORG_A}', 'c1-sess-a', '\\x00'::bytea),
      ('${SESS_B}', '${ORG_B}', 'c1-sess-b', '\\x00'::bytea),
      ('${SESS_C}', '${ORG_C}', 'c1-sess-c', '\\x00'::bytea)
      on conflict (id) do nothing;

    -- api_tokens
    insert into public.api_tokens (organization_id, name, prefix, token_hash, scopes, created_by) values
      ('${ORG_A}', 'Token A', 'dsk_a1', 'hash_a', '["read"]'::jsonb, '${USER_A_ADMIN}'),
      ('${ORG_B}', 'Token B', 'dsk_b1', 'hash_b', '["read"]'::jsonb, '${USER_B_ADMIN}')
      on conflict (id) do nothing;

    -- tenant_integrations
    insert into public.tenant_integrations (organization_id, provider, oauth_access_token_encrypted, webhook_secret_encrypted) values
      ('${ORG_A}', 'nuvemshop', '\\x00'::bytea, '\\x00'::bytea),
      ('${ORG_B}', 'nuvemshop', '\\x00'::bytea, '\\x00'::bytea)
      on conflict (organization_id, provider) do nothing;

    -- calendar_oauth_nonces
    insert into public.calendar_oauth_nonces (nonce, organization_id, user_id, expira_em) values
      ('nonce-a-1', '${ORG_A}', '${USER_A_ADMIN}', now() + interval '1 hour'),
      ('nonce-b-1', '${ORG_B}', '${USER_B_ADMIN}', now() + interval '1 hour')
      on conflict (nonce) do nothing;

    -- channel_knobs
    insert into public.channel_knobs (organization_id, channel_session_id, throttle_ms) values
      ('${ORG_A}', '${SESS_A}', 1000),
      ('${ORG_B}', '${SESS_B}', 2000)
      on conflict (organization_id, channel_session_id) do nothing;

    -- channel_session_health
    insert into public.channel_session_health (organization_id, channel_session_id, status) values
      ('${ORG_A}', '${SESS_A}', 'healthy'),
      ('${ORG_B}', '${SESS_B}', 'degraded')
      on conflict (id) do nothing;

    -- channel_session_warmup
    insert into public.channel_session_warmup (organization_id, channel_session_id, day, messages_sent) values
      ('${ORG_A}', '${SESS_A}', current_date, 50),
      ('${ORG_B}', '${SESS_B}', current_date, 100)
      on conflict (channel_session_id, day) do nothing;

    -- instagram_comment_rules
    insert into public.instagram_comment_rules (organization_id, channel_session_id, name, dm_message) values
      ('${ORG_A}', '${SESS_A}', 'Rule A', 'Olá pelo IG A'),
      ('${ORG_B}', '${SESS_B}', 'Rule B', 'Olá pelo IG B');
  `);
});

describe("AUD-03 Cluster 1 — Credenciais, Sessões e Canais", () => {
  describe("channel_sessions", () => {
    it("Admin A lê apenas sessão da Org A e ZERO da Org B", () => {
      expect(countAs(USER_A_ADMIN, `select count(*) from public.channel_sessions where organization_id = '${ORG_A}'`)).toBe(1);
      expect(countAs(USER_A_ADMIN, `select count(*) from public.channel_sessions where organization_id = '${ORG_B}'`)).toBe(0);
    });

    it("Admin B lê apenas sessão da Org B e ZERO da Org A", () => {
      expect(countAs(USER_B_ADMIN, `select count(*) from public.channel_sessions where organization_id = '${ORG_B}'`)).toBe(1);
      expect(countAs(USER_B_ADMIN, `select count(*) from public.channel_sessions where organization_id = '${ORG_A}'`)).toBe(0);
    });

    it("Admin A é impedido de forjar INSERT de channel_sessions para Org B", () => {
      const res = writeCountAs(
        USER_A_ADMIN,
        `insert into public.channel_sessions (organization_id, waha_session_name, webhook_secret_encrypted)
         values ('${ORG_B}', 'hacked-b', '\\x00'::bytea)`
      );
      expect(res).toBe(0);
    });

    it("Admin A é impedido de alterar ou excluir channel_sessions da Org B", () => {
      expect(writeCountAs(USER_A_ADMIN, `update public.channel_sessions set waha_session_name = 'pwn' where organization_id = '${ORG_B}'`)).toBe(0);
      expect(writeCountAs(USER_A_ADMIN, `delete from public.channel_sessions where organization_id = '${ORG_B}'`)).toBe(0);
    });
  });

  describe("api_tokens", () => {
    it("Admin A lê tokens da Org A e ZERO da Org B", () => {
      expect(countAs(USER_A_ADMIN, `select count(*) from public.api_tokens where organization_id = '${ORG_A}'`)).toBe(1);
      expect(countAs(USER_A_ADMIN, `select count(*) from public.api_tokens where organization_id = '${ORG_B}'`)).toBe(0);
    });

    it("Agent (sem role admin) lê ZERO tokens mesmo na sua Org A", () => {
      expect(countAs(USER_A_AGENT, `select count(*) from public.api_tokens where organization_id = '${ORG_A}'`)).toBe(0);
    });

    it("Admin A é impedido de forjar INSERT de api_tokens para Org B", () => {
      const res = writeCountAs(
        USER_A_ADMIN,
        `insert into public.api_tokens (organization_id, name, prefix, token_hash, scopes, created_by)
         values ('${ORG_B}', 'Hacked Token', 'dsk_hx', 'hash_x', '["read"]'::jsonb, '${USER_A_ADMIN}')`
      );
      expect(res).toBe(0);
    });

    it("Admin A é impedido de UPDATE / DELETE em api_tokens da Org B", () => {
      expect(writeCountAs(USER_A_ADMIN, `update public.api_tokens set name = 'PWN' where organization_id = '${ORG_B}'`)).toBe(0);
      expect(writeCountAs(USER_A_ADMIN, `delete from public.api_tokens where organization_id = '${ORG_B}'`)).toBe(0);
    });
  });

  describe("tenant_integrations", () => {
    it("Admin A lê integrações da Org A e ZERO da Org B", () => {
      expect(countAs(USER_A_ADMIN, `select count(*) from public.tenant_integrations where organization_id = '${ORG_A}'`)).toBe(1);
      expect(countAs(USER_A_ADMIN, `select count(*) from public.tenant_integrations where organization_id = '${ORG_B}'`)).toBe(0);
    });

    it("Admin A é impedido de forjar INSERT de tenant_integrations para Org B", () => {
      const res = writeCountAs(
        USER_A_ADMIN,
        `insert into public.tenant_integrations (organization_id, provider, oauth_access_token_encrypted, webhook_secret_encrypted)
         values ('${ORG_B}', 'vtex', '\\x00'::bytea, '\\x00'::bytea)`
      );
      expect(res).toBe(0);
    });

    it("Admin A é impedido de UPDATE / DELETE em tenant_integrations da Org B", () => {
      expect(writeCountAs(USER_A_ADMIN, `update public.tenant_integrations set status = 'error' where organization_id = '${ORG_B}'`)).toBe(0);
      expect(writeCountAs(USER_A_ADMIN, `delete from public.tenant_integrations where organization_id = '${ORG_B}'`)).toBe(0);
    });
  });

  describe("calendar_oauth_nonces (server-only / deny-all: ACL revoked e calendar_oauth_nonces_ninguem_le)", () => {
    it("Authenticated não tem privilégio de SELECT/INSERT e recebe permission denied", () => {
      expect(() => {
        sql(`
          set role authenticated;
          select set_config('request.jwt.claims', '{"sub":"${USER_A_ADMIN}"}', false);
          select count(*) from public.calendar_oauth_nonces;
        `);
      }).toThrow(/permission denied/);

      expect(() => {
        sql(`
          set role authenticated;
          select set_config('request.jwt.claims', '{"sub":"${USER_A_ADMIN}"}', false);
          insert into public.calendar_oauth_nonces (nonce, organization_id, user_id, expira_em)
          values ('hacked-nonce', '${ORG_A}', '${USER_A_ADMIN}', now() + interval '1 hour');
        `);
      }).toThrow(/permission denied/);
    });
  });

  describe("channel_knobs", () => {
    it("Membro A lê knobs da Org A e ZERO da Org B", () => {
      expect(countAs(USER_A_ADMIN, `select count(*) from public.channel_knobs where organization_id = '${ORG_A}'`)).toBe(1);
      expect(countAs(USER_A_ADMIN, `select count(*) from public.channel_knobs where organization_id = '${ORG_B}'`)).toBe(0);
    });

    it("Tentativa cruzada de escrita para Org B é barrada por RLS", () => {
      expect(writeCountAs(USER_A_ADMIN, `update public.channel_knobs set throttle_ms = 9999 where organization_id = '${ORG_B}'`)).toBe(0);
      expect(writeCountAs(USER_A_ADMIN, `delete from public.channel_knobs where organization_id = '${ORG_B}'`)).toBe(0);
    });
  });

  describe("channel_session_health", () => {
    it("Membro A lê health da Org A e ZERO da Org B", () => {
      expect(countAs(USER_A_ADMIN, `select count(*) from public.channel_session_health where organization_id = '${ORG_A}'`)).toBe(1);
      expect(countAs(USER_A_ADMIN, `select count(*) from public.channel_session_health where organization_id = '${ORG_B}'`)).toBe(0);
    });

    it("Tentativa cruzada de escrita para Org B é barrada por RLS", () => {
      expect(writeCountAs(USER_A_ADMIN, `update public.channel_session_health set status = 'pwn' where organization_id = '${ORG_B}'`)).toBe(0);
      expect(writeCountAs(USER_A_ADMIN, `delete from public.channel_session_health where organization_id = '${ORG_B}'`)).toBe(0);
    });
  });

  describe("channel_session_warmup", () => {
    it("Membro A lê warmup da Org A e ZERO da Org B", () => {
      expect(countAs(USER_A_ADMIN, `select count(*) from public.channel_session_warmup where organization_id = '${ORG_A}'`)).toBe(1);
      expect(countAs(USER_A_ADMIN, `select count(*) from public.channel_session_warmup where organization_id = '${ORG_B}'`)).toBe(0);
    });

    it("Tentativa cruzada de escrita para Org B é barrada por RLS", () => {
      expect(writeCountAs(USER_A_ADMIN, `update public.channel_session_warmup set messages_sent = 999 where organization_id = '${ORG_B}'`)).toBe(0);
      expect(writeCountAs(USER_A_ADMIN, `delete from public.channel_session_warmup where organization_id = '${ORG_B}'`)).toBe(0);
    });
  });

  describe("instagram_comment_rules", () => {
    it("Admin A lê regras da Org A e ZERO da Org B", () => {
      expect(countAs(USER_A_ADMIN, `select count(*) from public.instagram_comment_rules where organization_id = '${ORG_A}'`)).toBeGreaterThanOrEqual(1);
      expect(countAs(USER_A_ADMIN, `select count(*) from public.instagram_comment_rules where organization_id = '${ORG_B}'`)).toBe(0);
    });

    it("Admin B lê regras da Org B e ZERO da Org A", () => {
      expect(countAs(USER_B_ADMIN, `select count(*) from public.instagram_comment_rules where organization_id = '${ORG_B}'`)).toBeGreaterThanOrEqual(1);
      expect(countAs(USER_B_ADMIN, `select count(*) from public.instagram_comment_rules where organization_id = '${ORG_A}'`)).toBe(0);
    });

    it("Admin A é impedido de UPDATE / DELETE nas regras da Org B", () => {
      expect(writeCountAs(USER_A_ADMIN, `update public.instagram_comment_rules set name = 'pwn' where organization_id = '${ORG_B}'`)).toBe(0);
      expect(writeCountAs(USER_A_ADMIN, `delete from public.instagram_comment_rules where organization_id = '${ORG_B}'`)).toBe(0);
    });
  });

  describe("Invariantes de Membership: Revogação e Multi-Org", () => {
    it("Usuário com membership revogada não lê nenhuma linha da organização", () => {
      expect(countAs(USER_REVOKED, `select count(*) from public.channel_sessions where organization_id = '${ORG_A}'`)).toBe(0);
      expect(countAs(USER_REVOKED, `select count(*) from public.channel_knobs where organization_id = '${ORG_A}'`)).toBe(0);
    });

    it("Usuário multi-org lê linhas de Org A e Org C, mas ZERO de Org B", () => {
      expect(countAs(USER_MULTI, `select count(*) from public.channel_sessions where organization_id = '${ORG_A}'`)).toBe(1);
      expect(countAs(USER_MULTI, `select count(*) from public.channel_sessions where organization_id = '${ORG_C}'`)).toBe(1);
      expect(countAs(USER_MULTI, `select count(*) from public.channel_sessions where organization_id = '${ORG_B}'`)).toBe(0);
    });
  });
});
