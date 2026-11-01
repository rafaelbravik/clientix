import { beforeAll, describe, expect, it } from "vitest";
import { sql } from "./gov-helpers";

const organizationId = "10000000-0000-4000-8000-000000000051";
const campaignId = "20000000-0000-4000-8000-000000000051";
const contactId = "30000000-0000-4000-8000-000000000051";

beforeAll(() =>
  sql(`insert into organizations(id,slug,legal_name,display_name)
       values ('${organizationId}','prospecting-site-lgpd','Org LGPD','Org LGPD');
       insert into prospecting_campaigns(id,organization_id,request_id,name,search)
       values ('${campaignId}','${organizationId}',gen_random_uuid(),'Campanha LGPD','{}');`),
);

describe("LGPD cascade redaction of prospecting site data", () => {
  it("removes site audit, strategy and preview from a redacted contact candidate", () => {
    sql(`insert into contacts(id,organization_id,name,phone_number)
         values ('${contactId}','${organizationId}','Pessoa de Teste','+5511988880051');
         insert into prospecting_candidates(organization_id,campaign_id,place_id,phone,data,status,contact_id,error)
         values ('${organizationId}','${campaignId}','site-lgpd-place','+5511988880051',
           '{"name":"Pessoa de Teste","site":{"resumo":"SITE-AUDIT-PRIVATE","facts":{"title":"SITE-FACT-PRIVATE"}},"estrategia":{"angulo":"STRATEGY-PRIVATE"},"previa":{"texto":"PREVIEW-PRIVATE"}}',
           'queued','${contactId}','Pessoa de Teste');
         select fn_lgpd_cascade_redact_contact('${organizationId}','${contactId}',gen_random_uuid());`);

    const erased = JSON.parse(
      sql(`select json_build_object('data',data,'phone',phone,'error',error,'status',status)
           from prospecting_candidates where organization_id='${organizationId}' and contact_id='${contactId}'`),
    ) as { data: Record<string, unknown>; phone: string | null; error: string | null; status: string };

    expect(erased.phone).toBeNull();
    expect(erased.error).toBeNull();
    expect(erased.status).toBe("skipped");
    expect(erased.data).not.toHaveProperty("site");
    expect(erased.data).not.toHaveProperty("estrategia");
    expect(erased.data).not.toHaveProperty("previa");
    expect(JSON.stringify(erased)).not.toMatch(/SITE-AUDIT-PRIVATE|SITE-FACT-PRIVATE|STRATEGY-PRIVATE|PREVIEW-PRIVATE|Pessoa de Teste/);
  });
});
