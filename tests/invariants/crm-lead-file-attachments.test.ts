import { beforeAll, describe, expect, it } from "vitest";

import { lastLine, sql } from "./gov-helpers";

const ORG_A = "d1111111-1111-4111-8111-111111111111";
const ORG_B = "d2222222-2222-4222-8222-222222222222";
const USER_A = "d3333333-3333-4333-8333-333333333333";
const USER_B = "d4444444-4444-4444-8444-444444444444";
const PIPE_A = "d5555555-5555-4555-8555-555555555551";
const PIPE_B = "d5555555-5555-4555-8555-555555555552";
const FROM_A = "d6666666-6666-4666-8666-666666666661";
const REQ_A = "d6666666-6666-4666-8666-666666666662";
const FROM_B = "d6666666-6666-4666-8666-666666666663";
const REQ_B = "d6666666-6666-4666-8666-666666666664";
const LEAD_A = "d7777777-7777-4777-8777-777777777771";
const LEAD_B = "d7777777-7777-4777-8777-777777777772";
const LEAD_REQUIRED_EMPTY = "d7777777-7777-4777-8777-777777777773";
const LEAD_LGPD = "d7777777-7777-4777-8777-777777777774";
const LEAD_DELETE = "d7777777-7777-4777-8777-777777777775";
const CONTACT_LGPD = "d8888888-8888-4888-8888-888888888881";
const CONTACT_DELETE = "d8888888-8888-4888-8888-888888888882";
const ATT_A = "d9999999-9999-4999-8999-999999999991";
const ATT_A2 = "d9999999-9999-4999-8999-999999999992";
const ATT_B = "d9999999-9999-4999-8999-999999999993";
const ATT_LGPD = "d9999999-9999-4999-8999-999999999994";
const ATT_DELETE = "d9999999-9999-4999-8999-999999999995";
const STAGE_REQUIRED_EMPTY = REQ_A;
const FIELD = "documentos";

function path(org: string, lead: string, attachment: string) {
  return `${org}/lead-attachments/${lead}/${attachment}.pdf`;
}

function objeto(org: string, lead: string, attachment: string) {
  return `insert into storage.objects (bucket_id, name, metadata)
          values ('internal-media', '${path(org, lead, attachment)}', '{"size": 32}'::jsonb);`;
}

function anexo(org: string, lead: string, attachment: string) {
  return `insert into public.crm_lead_attachments
            (id, organization_id, lead_id, custom_field_key, original_filename, mime_type, size_bytes, created_by)
          values ('${attachment}', '${org}', '${lead}', '${FIELD}', 'proposta.pdf', 'application/pdf', 32,
                  '${org === ORG_A ? USER_A : USER_B}');`;
}

function falhaSql(script: string): string {
  try {
    sql(script);
  } catch (error) {
    const causa = error as { stderr?: string; stdout?: string; message?: string };
    return `${causa.stderr ?? ""}${causa.stdout ?? ""}${causa.message ?? ""}`;
  }
  throw new Error("A instrução SQL deveria ter sido recusada.");
}

function como(userId: string, statement: string): string {
  return `set role authenticated;
          select set_config('request.jwt.claims', '{"sub":"${userId}","role":"authenticated","aal":"aal1"}', false);
          ${statement}`;
}

beforeAll(() => {
  sql(`
    insert into auth.users (id, email) values
      ('${USER_A}', 'crm-file-a@invariant.test'), ('${USER_B}', 'crm-file-b@invariant.test')
      on conflict (id) do nothing;
    insert into public.organizations (id, slug, legal_name, display_name, settings) values
      ('${ORG_A}', 'crm-file-a', 'CRM File A', 'CRM File A', '{"visibility_mode":"all"}'::jsonb),
      ('${ORG_B}', 'crm-file-b', 'CRM File B', 'CRM File B', '{"visibility_mode":"all"}'::jsonb)
      on conflict (id) do nothing;
    insert into public.user_organizations (user_id, organization_id, role, accepted_at) values
      ('${USER_A}', '${ORG_A}', 'agent', now()), ('${USER_B}', '${ORG_B}', 'agent', now())
      on conflict do nothing;
    insert into public.crm_pipelines (id, organization_id, name, slug, settings) values
      ('${PIPE_A}', '${ORG_A}', 'CRM file A', 'crm-file-a',
       '{"fields":[{"key":"${FIELD}","label":"Documentos","type":"file","multiple":true,"obrigatorio_em":{"etapas":["${REQ_A}"]}}]}'::jsonb),
      ('${PIPE_B}', '${ORG_B}', 'CRM file B', 'crm-file-b',
       '{"fields":[{"key":"${FIELD}","label":"Documentos","type":"file","multiple":true,"obrigatorio_em":{"etapas":["${REQ_B}"]}}]}'::jsonb)
      on conflict (id) do nothing;
    insert into public.crm_stages (id, organization_id, pipeline_id, name, slug, position) values
      ('${FROM_A}', '${ORG_A}', '${PIPE_A}', 'Entrada A', 'entrada-a', 10),
      ('${REQ_A}', '${ORG_A}', '${PIPE_A}', 'Documentação A', 'documentacao-a', 20),
      ('${FROM_B}', '${ORG_B}', '${PIPE_B}', 'Entrada B', 'entrada-b', 10),
      ('${REQ_B}', '${ORG_B}', '${PIPE_B}', 'Documentação B', 'documentacao-b', 20)
      on conflict (id) do nothing;
    insert into public.contacts (id, organization_id, display_name) values
      ('${CONTACT_LGPD}', '${ORG_A}', 'Titular de teste'),
      ('${CONTACT_DELETE}', '${ORG_A}', 'Titular removido de teste')
      on conflict (id) do nothing;
    insert into public.crm_leads (id, organization_id, pipeline_id, stage_id, title, owner_user_id, contact_id) values
      ('${LEAD_A}', '${ORG_A}', '${PIPE_A}', '${FROM_A}', 'Lead A', '${USER_A}', null),
      ('${LEAD_B}', '${ORG_B}', '${PIPE_B}', '${FROM_B}', 'Lead B', '${USER_B}', null),
      ('${LEAD_REQUIRED_EMPTY}', '${ORG_A}', '${PIPE_A}', '${FROM_A}', 'Sem documento', '${USER_A}', null),
      ('${LEAD_LGPD}', '${ORG_A}', '${PIPE_A}', '${FROM_A}', 'Lead LGPD', '${USER_A}', '${CONTACT_LGPD}'),
      ('${LEAD_DELETE}', '${ORG_A}', '${PIPE_A}', '${FROM_A}', 'Lead de exclusão', '${USER_A}', '${CONTACT_DELETE}')
      on conflict (id) do nothing;
    insert into storage.buckets (id, name, public, file_size_limit)
      values ('internal-media', 'internal-media', false, 52428800)
      on conflict (id) do update set public = false, file_size_limit = excluded.file_size_limit;
    ${objeto(ORG_A, LEAD_A, ATT_A)}
    ${objeto(ORG_A, LEAD_A, ATT_A2)}
    ${objeto(ORG_B, LEAD_B, ATT_B)}
    ${objeto(ORG_A, LEAD_LGPD, ATT_LGPD)}
    ${objeto(ORG_A, LEAD_DELETE, ATT_DELETE)}
    ${anexo(ORG_A, LEAD_A, ATT_A)}
    ${anexo(ORG_A, LEAD_A, ATT_A2)}
    ${anexo(ORG_B, LEAD_B, ATT_B)}
    ${anexo(ORG_A, LEAD_LGPD, ATT_LGPD)}
    ${anexo(ORG_A, LEAD_DELETE, ATT_DELETE)}
  `);
});

describe("crm_lead_attachments — fronteira tenant e Storage privado", () => {
  it("mantém o bucket privado, grants mínimos e a coluna interna fora do authenticated", () => {
    expect(sql("select public::text || '|' || file_size_limit from storage.buckets where id = 'internal-media';")).toBe("false|52428800");
    expect(sql(`select has_table_privilege('authenticated','public.crm_lead_attachments','INSERT')::text || '|' ||
                      has_table_privilege('authenticated','public.crm_lead_attachments','UPDATE')::text || '|' ||
                      has_table_privilege('authenticated','public.crm_lead_attachments','DELETE')::text;`)).toBe("false|false|false");
    expect(sql(`select has_table_privilege('service_role','public.crm_lead_attachments','SELECT')::text || '|' ||
                      has_table_privilege('service_role','public.crm_lead_attachments','INSERT')::text || '|' ||
                      has_table_privilege('service_role','public.crm_lead_attachments','UPDATE')::text || '|' ||
                      has_table_privilege('service_role','public.crm_lead_attachments','DELETE')::text;`)).toBe("true|true|false|true");
    expect(sql("select has_column_privilege('authenticated','public.crm_lead_attachments','storage_path','SELECT')::text || '|' || has_column_privilege('authenticated','public.crm_lead_attachments','original_filename','SELECT')::text;")).toBe("false|false");
    expect(sql("select relrowsecurity::text || '|' || relforcerowsecurity::text from pg_class where oid='public.crm_lead_attachments'::regclass;")).toBe("true|true");
    expect(sql("select has_function_privilege('anon','public.fn_delete_crm_lead_attachment(uuid,uuid,uuid)','EXECUTE')::text || '|' || has_function_privilege('authenticated','public.fn_delete_crm_lead_attachment(uuid,uuid,uuid)','EXECUTE')::text || '|' || has_function_privilege('service_role','public.fn_delete_crm_lead_attachment(uuid,uuid,uuid)','EXECUTE')::text;")).toBe("false|true|false");
  });

  it("authenticated só lista anexos do lead e tenant visíveis", () => {
    expect(lastLine(sql(como(USER_A, `select count(*) from public.crm_lead_attachments where organization_id='${ORG_A}' and lead_id='${LEAD_A}';`))).trim()).toBe("2");
    expect(lastLine(sql(como(USER_A, `select count(*) from public.crm_lead_attachments where organization_id='${ORG_B}';`))).trim()).toBe("0");
    expect(falhaSql(como(USER_A, `select storage_path from public.crm_lead_attachments where id='${ATT_A}';`))).toMatch(/permission denied/i);
    expect(falhaSql(como(USER_A, `select public.fn_delete_crm_lead_attachment('${ORG_B}','${LEAD_B}','${ATT_B}');`))).toContain("lead_attachment_forbidden");
  });

  it("authenticated não baixa objetos de lead diretamente pelo bucket", () => {
    const podeConsultar = sql("select has_table_privilege('authenticated','storage.objects','SELECT');").trim() === "t";
    if (podeConsultar) {
      expect(lastLine(sql(como(USER_A, `select count(*) from storage.objects where bucket_id='internal-media' and name='${path(ORG_A, LEAD_A, ATT_A)}';`))).trim()).toBe("0");
    }
    expect(sql("select public::text from storage.buckets where id='internal-media';")).toBe("false");
  });

  it("authenticated não pode inserir, atualizar ou excluir diretamente metadados", () => {
    const noInsert = falhaSql(como(USER_A, `insert into public.crm_lead_attachments (organization_id,lead_id,custom_field_key,original_filename,mime_type,size_bytes) values ('${ORG_A}','${LEAD_A}','${FIELD}','x.pdf','application/pdf',32);`));
    const noUpdate = falhaSql(como(USER_A, `update public.crm_lead_attachments set safe_filename='adulterado.pdf' where id='${ATT_A}';`));
    const noDelete = falhaSql(como(USER_A, `delete from public.crm_lead_attachments where id='${ATT_A}';`));
    expect(noInsert).toMatch(/permission denied/i);
    expect(noUpdate).toMatch(/permission denied/i);
    expect(noDelete).toMatch(/permission denied/i);
  });

  it("bloqueia tenant cruzado e mudança de etapa sem anexo, mas permite estágio com anexo persistido", () => {
    expect(falhaSql(`update public.crm_leads set stage_id='${STAGE_REQUIRED_EMPTY}' where id='${LEAD_REQUIRED_EMPTY}';`)).toContain("required_file_attachment_missing");
    expect(falhaSql(`insert into public.crm_lead_attachments (id,organization_id,lead_id,custom_field_key,original_filename,mime_type,size_bytes)
                       values ('d9999999-9999-4999-8999-999999999996','${ORG_B}','${LEAD_A}','${FIELD}','x.pdf','application/pdf',32);`)).toContain("lead_attachment_lead_not_found");
    sql(`update public.crm_leads set stage_id='${REQ_A}' where id='${LEAD_A}' and organization_id='${ORG_A}';`);
    expect(lastLine(sql(`select stage_id from public.crm_leads where id='${LEAD_A}';`))).toBe(REQ_A);
  });

  it("service_role grava metadados via path derivado e a remoção protege o último campo obrigatório", () => {
    const attachment = "d9999999-9999-4999-8999-999999999997";
    sql(objeto(ORG_B, LEAD_B, attachment));
    sql(`set role service_role; ${anexo(ORG_B, LEAD_B, attachment)}`);
    expect(lastLine(sql(`select storage_path from public.crm_lead_attachments where id='${attachment}';`))).toBe(path(ORG_B, LEAD_B, attachment));

    const removeUm = sql(como(USER_A, `select public.fn_delete_crm_lead_attachment('${ORG_A}','${LEAD_A}','${ATT_A2}');`));
    expect(lastLine(removeUm)).toBe("t");
    expect(falhaSql(como(USER_A, `select public.fn_delete_crm_lead_attachment('${ORG_A}','${LEAD_A}','${ATT_A}');`))).toContain("required_file_attachment_missing");
    sql(`update public.crm_leads set stage_id='${FROM_A}' where id='${LEAD_A}';`);
    expect(lastLine(sql(como(USER_A, `select public.fn_delete_crm_lead_attachment('${ORG_A}','${LEAD_A}','${ATT_A}');`))).trim()).toBe("t");
    expect(lastLine(sql(`select count(*) from public.storage_redaction_queue where bucket='internal-media' and object_path='${path(ORG_A, LEAD_A, ATT_A)}' and status='pending';`))).toBe("1");
  });

  it("LGPD anonimização e exclusão física revogam metadados e enfileiram mídia", () => {
    sql(`update public.contacts set is_anonymized=true, anonymized_at=now() where id='${CONTACT_LGPD}' and organization_id='${ORG_A}';`);
    expect(lastLine(sql(`select count(*) from public.crm_lead_attachments where id='${ATT_LGPD}';`))).toBe("0");
    expect(lastLine(sql(`select count(*) from public.storage_redaction_queue where bucket='internal-media' and object_path='${path(ORG_A, LEAD_LGPD, ATT_LGPD)}' and status='pending';`))).toBe("1");

    sql(`delete from public.contacts where id='${CONTACT_DELETE}' and organization_id='${ORG_A}';`);
    expect(lastLine(sql(`select count(*) from public.crm_lead_attachments where id='${ATT_DELETE}';`))).toBe("0");
    expect(lastLine(sql(`select count(*) from public.storage_redaction_queue where bucket='internal-media' and object_path='${path(ORG_A, LEAD_DELETE, ATT_DELETE)}' and status='pending';`))).toBe("1");
  });

  it("varredura de órfãos preserva anexos ativos e enfileira apenas objetos órfãos antigos", () => {
    const orphan = `${ORG_A}/lead-attachments/${LEAD_REQUIRED_EMPTY}/d9999999-9999-4999-8999-999999999998.pdf`;
    sql(`update storage.objects set created_at=now()-interval '2 days' where bucket_id='internal-media' and name='${path(ORG_B, LEAD_B, ATT_B)}';
        insert into storage.objects (bucket_id,name,metadata,created_at) values ('internal-media','${orphan}','{"size":32}'::jsonb,now()-interval '2 days');
        set role service_role;
        select public.fn_enqueue_orphan_crm_lead_attachments(100);`);
    expect(lastLine(sql(`select count(*) from public.storage_redaction_queue where bucket='internal-media' and object_path='${path(ORG_B, LEAD_B, ATT_B)}';`))).toBe("0");
    expect(lastLine(sql(`select count(*) from public.storage_redaction_queue where bucket='internal-media' and object_path='${orphan}' and status='pending';`))).toBe("1");
  });
});
