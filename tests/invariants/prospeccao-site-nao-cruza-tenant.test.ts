import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import pg from "pg";

import type { McpContext } from "@/lib/mcp/types";
import { crmGetProspectingSiteAudit } from "@/lib/mcp/tools/prospeccao-site";
import { pgComoSupabase } from "../pg-como-supabase";

const container = process.env.TEST_DB_CONTAINER;
if (!container) throw new Error("TEST_DB_CONTAINER not set — rode via `pnpm test:db` (scripts/test-db.sh)");

const pool = new pg.Pool({
  connectionString: `postgresql://postgres:postgres@127.0.0.1:${Number(process.env.TEST_DB_PORT ?? 54329)}/postgres`,
  max: 3,
});
const db = pgComoSupabase(pool);
const orgA = randomUUID();
const orgB = randomUUID();
const contactA = randomUUID();
const contactB = randomUUID();
const campaignA = randomUUID();
const campaignB = randomUUID();
const candidateA = randomUUID();
const candidateB = randomUUID();
const slugSuffix = randomUUID().slice(0, 8);

function audit(classe: string, titulo: string) {
  return {
    ver: 1,
    classe,
    status: "checked",
    provisorio: false,
    citavel: true,
    external_content_trust: "UNTRUSTED_EXTERNAL_CONTENT",
    verificado_em: "2026-10-30T12:00:00.000Z",
    url: "https://example.test/",
    final_url: "https://example.test/",
    http_status: 200,
    tempo_ms: 100,
    https_disponivel: true,
    tls_valido: true,
    mobile_hint: false,
    empty_hint: false,
    builder_hint: null,
    motivo: classe === "site-ruim" ? "viewport_missing" : null,
    facts: {
      trust: "UNTRUSTED_EXTERNAL_CONTENT",
      title: titulo,
      description: null,
      headings: [],
      visible_text_length: 100,
    },
    resumo: null,
  };
}

function context(organizationId: string, contactId: string): McpContext {
  return {
    organizationId,
    contatoDoTurno: contactId,
    actor: { type: "ai_agent", id: "synthetic-agent" },
    supabase: db,
  } as unknown as McpContext;
}

beforeAll(async () => {
  await pool.query(
    `insert into organizations(id,slug,legal_name,display_name)
     values ($1,$3,'Org A','Org A'),($2,$4,'Org B','Org B')`,
    [orgA, orgB, `mcp-prospect-a-${slugSuffix}`, `mcp-prospect-b-${slugSuffix}`],
  );
  await pool.query(
    `insert into contacts(id,organization_id,name,phone_number,consent)
     values ($1,$3,'Contato A','+5511988880000','{}'),($2,$4,'Contato B','+5511988880000','{}')`,
    [contactA, contactB, orgA, orgB],
  );
  await pool.query(
    `insert into prospecting_campaigns(id,organization_id,request_id,name,search,config,status)
     values ($1,$3,gen_random_uuid(),'Campanha A','{}','{}','paused'),
            ($2,$4,gen_random_uuid(),'Campanha B','{}','{}','paused')`,
    [campaignA, campaignB, orgA, orgB],
  );
  await pool.query(
    `insert into prospecting_candidates(id,organization_id,campaign_id,place_id,phone,data,status,contact_id)
     values ($1,$3,$5,'place-collision','+5511988880000',$7,'sent',$9),
            ($2,$4,$6,'place-collision','+5511988880000',$8,'sent',$10)`,
    [
      candidateA,
      candidateB,
      orgA,
      orgB,
      campaignA,
      campaignB,
      JSON.stringify({ name: "Empresa A", website: "https://a.example.test", site: audit("site-ok", "FACT-A") }),
      JSON.stringify({ name: "Empresa B", website: "https://b.example.test", site: audit("site-ruim", "FACT-B") }),
      contactA,
      contactB,
    ],
  );
});

afterAll(async () => {
  await pool.query("delete from organizations where id = any($1::uuid[])", [[orgA, orgB]]);
  await pool.end();
});

describe("crm_get_prospecting_site_audit — isolamento e vínculo real no Postgres", () => {
  it("A e B leem cada auditoria pelo contato vinculado, apesar de colisão de telefone e place_id", async () => {
    const [a, b] = await Promise.all([
      crmGetProspectingSiteAudit.handler({}, context(orgA, contactA)),
      crmGetProspectingSiteAudit.handler({}, context(orgB, contactB)),
    ]);
    expect(a).toMatchObject({ disponivel: true, auditoria: { classe: "site-ok", fatos_citaveis: { titulo: "FACT-A" } } });
    expect(b).toMatchObject({ disponivel: true, auditoria: { classe: "site-ruim", fatos_citaveis: { titulo: "FACT-B" } } });
    expect(JSON.stringify(a)).not.toContain("FACT-B");
    expect(JSON.stringify(b)).not.toContain("FACT-A");
  });

  it("A não alcança contato/candidato B mesmo se IDs forem enviados pelo modelo", async () => {
    const result = await crmGetProspectingSiteAudit.handler(
      { organization_id: orgB, contact_id: contactB, candidate_id: candidateB } as never,
      context(orgA, contactA),
    );
    expect(result).toMatchObject({ disponivel: true, auditoria: { classe: "site-ok" } });
    expect(JSON.stringify(result)).not.toContain("FACT-B");
    expect(JSON.stringify(result)).not.toContain(candidateB);
  });

  it("recusa contato B no contexto autenticado de A sem revelar se o candidato existe", async () => {
    const result = await crmGetProspectingSiteAudit.handler({}, context(orgA, contactB));
    expect(result).toEqual({ disponivel: false, codigo: "prospecting_audit_not_found" });
    expect(JSON.stringify(result)).not.toMatch(/FACT-B|place-collision|candidate/i);
  });

  it("não retorna raw HTML/provider material e não consulta por telefone ou place_id", async () => {
    const result = await crmGetProspectingSiteAudit.handler({}, context(orgA, contactA));
    expect(JSON.stringify(result)).not.toMatch(/raw_html|provider_response|token|place-collision|candidate_id|contact_id|organization_id/i);
  });
});
