import { beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { GOV_ORG, seedGov, sql } from "./gov-helpers";

describe("message_templates.mostrar_na_barra — migration 0524", () => {
  beforeAll(() => seedGov());

  it("a coluna é NOT NULL com default true e permite persistir false", () => {
    expect(
      sql(`select column_default, is_nullable from information_schema.columns
           where table_schema = 'public' and table_name = 'message_templates'
             and column_name = 'mostrar_na_barra'`),
    ).toMatch(/true.*\|NO/);

    const templateId = randomUUID();
    const output = sql(`
      begin;
      insert into public.message_templates (id, organization_id, title, body)
        values ('${templateId}', '${GOV_ORG}', 'QA barra', 'conteúdo sintético')
        returning mostrar_na_barra;
      update public.message_templates set mostrar_na_barra = false where id = '${templateId}'
        returning mostrar_na_barra;
      rollback;
    `).split("\n");

    expect(output.filter((line) => line === "t" || line === "f")).toEqual(["t", "f"]);
  });
});
