import { afterAll, beforeAll, describe, expect, it } from "vitest";
import pg from "pg";

import { agenteJaRespondeuNoServico } from "@/lib/agent-engine/agent/palavra-chave-do-gatilho";

const container = process.env.TEST_DB_CONTAINER;
if (!container) {
  throw new Error("TEST_DB_CONTAINER not set — rode via `pnpm test:db` (scripts/test-db.sh)");
}

const PORT = Number(process.env.TEST_DB_PORT ?? 54329);
const pool = new pg.Pool({
  connectionString: `postgresql://postgres:postgres@127.0.0.1:${PORT}/postgres`,
  max: 2,
});

const ORG_A = "e29a9c10-0a4f-4ea6-8ef1-2a9d10100001";
const ORG_B = "e29a9c10-0a4f-4ea6-8ef1-2a9d10100002";
const CONTACT_A = "e29a9c10-0a4f-4ea6-8ef1-2a9d10100003";
const CONTACT_B = "e29a9c10-0a4f-4ea6-8ef1-2a9d10100004";
const CONTACT_OTHER_AGENT = "e29a9c10-0a4f-4ea6-8ef1-2a9d10100014";
const CONTACT_FAILED = "e29a9c10-0a4f-4ea6-8ef1-2a9d10100015";
const CONTACT_PREVIOUS_SERVICE = "e29a9c10-0a4f-4ea6-8ef1-2a9d10100016";
const SESSION_A = "e29a9c10-0a4f-4ea6-8ef1-2a9d10100005";
const SESSION_B = "e29a9c10-0a4f-4ea6-8ef1-2a9d10100006";
const CONV_CURRENT = "e29a9c10-0a4f-4ea6-8ef1-2a9d10100007";
const CONV_OTHER_AGENT = "e29a9c10-0a4f-4ea6-8ef1-2a9d10100008";
const CONV_FAILED = "e29a9c10-0a4f-4ea6-8ef1-2a9d10100009";
const CONV_PREVIOUS_SERVICE = "e29a9c10-0a4f-4ea6-8ef1-2a9d10100010";
const CONV_OTHER_TENANT = "e29a9c10-0a4f-4ea6-8ef1-2a9d10100011";
const AGENT_A = "e29a9c10-0a4f-4ea6-8ef1-2a9d10100017";

async function insertOutbound(input: {
  organizationId: string;
  conversationId: string;
  sessionId: string;
  contactId: string;
  agentId: string;
  status: string;
  sentAt: string;
}): Promise<void> {
  await pool.query(
    `insert into messages (organization_id, conversation_id, channel_session_id, contact_id,
                           type, direction, status, sent_via, body, sent_at, metadata)
     values ($1, $2, $3, $4, 'text', 'outbound', $5, 'ai', 'resposta de teste', $6,
             jsonb_build_object('ai_actor_id', $7::text))`,
    [
      input.organizationId,
      input.conversationId,
      input.sessionId,
      input.contactId,
      input.status,
      input.sentAt,
      input.agentId,
    ],
  );
}

beforeAll(async () => {
  for (const [id, slug] of [
    [ORG_A, "keyword-admission-a"],
    [ORG_B, "keyword-admission-b"],
  ]) {
    await pool.query(
      `insert into organizations (id, slug, legal_name, display_name)
       values ($1, $2, 'Keyword Test', 'Keyword Test') on conflict (id) do nothing`,
      [id, slug],
    );
  }
  await pool.query(
    `insert into contacts (id, organization_id, name, phone_number) values
       ($1, $6, 'Contato A', '+5511900000001'),
       ($2, $6, 'Contato outro agente', '+5511900000002'),
       ($3, $6, 'Contato envio falho', '+5511900000003'),
       ($4, $6, 'Contato serviço anterior', '+5511900000004'),
       ($5, $7, 'Contato B', '+5511900000005')`,
    [CONTACT_A, CONTACT_OTHER_AGENT, CONTACT_FAILED, CONTACT_PREVIOUS_SERVICE, CONTACT_B, ORG_A, ORG_B],
  );
  await pool.query(
    `insert into channel_sessions (id, organization_id, waha_session_name, status, webhook_secret_encrypted) values
       ($1, $3, 'keyword-session-a', 'WORKING', '\\x00'::bytea),
       ($2, $4, 'keyword-session-b', 'WORKING', '\\x00'::bytea)`,
    [SESSION_A, SESSION_B, ORG_A, ORG_B],
  );
  await pool.query(
    `insert into conversations (id, organization_id, contact_id, channel_session_id,
                                status, is_group, service_started_at) values
       ($1, $6, $7, $11, 'open', false, now() - interval '1 hour'),
       ($2, $6, $8, $11, 'open', false, now() - interval '1 hour'),
       ($3, $6, $9, $11, 'open', false, now() - interval '1 hour'),
       ($4, $6, $10, $11, 'open', false, now() - interval '1 hour'),
       ($5, $12, $13, $14, 'open', false, now() - interval '1 hour')`,
    [
      CONV_CURRENT,
      CONV_OTHER_AGENT,
      CONV_FAILED,
      CONV_PREVIOUS_SERVICE,
      CONV_OTHER_TENANT,
      ORG_A,
      CONTACT_A,
      CONTACT_OTHER_AGENT,
      CONTACT_FAILED,
      CONTACT_PREVIOUS_SERVICE,
      SESSION_A,
      ORG_B,
      CONTACT_B,
      SESSION_B,
    ],
  );

  await insertOutbound({
    organizationId: ORG_A,
    conversationId: CONV_CURRENT,
    sessionId: SESSION_A,
    contactId: CONTACT_A,
    agentId: AGENT_A,
    status: "delivered",
    sentAt: new Date().toISOString(),
  });
  await insertOutbound({
    organizationId: ORG_A,
    conversationId: CONV_OTHER_AGENT,
    sessionId: SESSION_A,
    contactId: CONTACT_OTHER_AGENT,
    agentId: "e29a9c10-0a4f-4ea6-8ef1-2a9d10100018",
    status: "delivered",
    sentAt: new Date().toISOString(),
  });
  await insertOutbound({
    organizationId: ORG_A,
    conversationId: CONV_FAILED,
    sessionId: SESSION_A,
    contactId: CONTACT_FAILED,
    agentId: AGENT_A,
    status: "failed",
    sentAt: new Date().toISOString(),
  });
  await insertOutbound({
    organizationId: ORG_A,
    conversationId: CONV_PREVIOUS_SERVICE,
    sessionId: SESSION_A,
    contactId: CONTACT_PREVIOUS_SERVICE,
    agentId: AGENT_A,
    status: "delivered",
    sentAt: new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString(),
  });
  await insertOutbound({
    organizationId: ORG_B,
    conversationId: CONV_OTHER_TENANT,
    sessionId: SESSION_B,
    contactId: CONTACT_B,
    agentId: AGENT_A,
    status: "delivered",
    sentAt: new Date().toISOString(),
  });
});

afterAll(async () => {
  await pool.query("delete from organizations where id = any($1::uuid[])", [[ORG_A, ORG_B]]);
  await pool.end();
});

describe("a admissão da conversa usa resposta comprovada no serviço atual", () => {
  it("reconhece resposta entregue do mesmo agente", async () => {
    await expect(
      agenteJaRespondeuNoServico(pool, {
        organizationId: ORG_A,
        conversationId: CONV_CURRENT,
        agentId: AGENT_A,
      }),
    ).resolves.toBe(true);
  });

  it.each([
    ["outro agente", CONV_OTHER_AGENT],
    ["envio falho", CONV_FAILED],
    ["serviço anterior", CONV_PREVIOUS_SERVICE],
    ["conversa de outro tenant", CONV_OTHER_TENANT],
  ])("não considera %s como engajamento deste serviço", async (_label, conversationId) => {
    await expect(
      agenteJaRespondeuNoServico(pool, {
        organizationId: ORG_A,
        conversationId,
        agentId: AGENT_A,
      }),
    ).resolves.toBe(false);
  });
});
