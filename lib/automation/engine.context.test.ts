import { describe, expect, it } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";

import { evaluateConditions } from "@/lib/automation/conditions";
import { buildContext } from "@/lib/automation/engine";
import { renderTemplate } from "@/lib/automation/template";
import type { EventRow } from "@/lib/event-log/dispatcher";

const ORG = "22222222-2222-4222-8222-222222222222";
const PIPELINE = "44444444-4444-4444-8444-444444444444";
const LEAD = "55555555-5555-4555-8555-555555555555";

function adminFake(
  options: {
    pipelineOrg?: string;
    pipelineError?: boolean;
    lead?: Record<string, unknown> | null;
  } = {},
) {
  const calls: Array<{ table: string; filters: Array<[string, unknown]> }> = [];
  const data: Record<string, Record<string, unknown> | null> = {
    crm_leads:
      options.lead === undefined
        ? {
            id: LEAD,
            organization_id: ORG,
            pipeline_id: PIPELINE,
            contact_id: null,
            custom_fields: { destino: "paris-franca" },
          }
        : options.lead,
    crm_pipelines:
      options.pipelineOrg === ORG || options.pipelineOrg === undefined
        ? {
            id: PIPELINE,
            organization_id: ORG,
            settings: {
              fields: [
                {
                  key: "destino",
                  label: "Destino",
                  type: "select",
                  options: [{ value: "paris-franca", label: "Paris (França)" }],
                },
              ],
            },
          }
        : null,
  };

  const admin = {
    from(table: string) {
      const call = { table, filters: [] as Array<[string, unknown]> };
      calls.push(call);
      const query = {
        select() {
          return query;
        },
        eq(column: string, value: unknown) {
          call.filters.push([column, value]);
          return query;
        },
        async maybeSingle() {
          if (options.pipelineError && table === "crm_pipelines")
            return { data: null, error: { message: "unavailable" } };
          const row = data[table] ?? null;
          return {
            data:
              row && call.filters.every(([column, value]) => row[column] === value) ? row : null,
            error: null,
          };
        },
      };
      return query;
    },
  };

  return { admin, calls };
}

describe("buildContext — definições internas de campo de lista", () => {
  it("hidrata settings tenant-scoped e mantém o value canônico nas condições", async () => {
    const { admin, calls } = adminFake();
    const row = {
      organization_id: ORG,
      entity_kind: "crm_lead",
      entity_id: LEAD,
      payload: {},
    } as unknown as EventRow;

    const context = await buildContext(admin as unknown as SupabaseClient, row);

    expect(renderTemplate("Destino: {{destino}}", context)).toBe("Destino: Paris (França)");
    expect(
      evaluateConditions(
        [{ field: "lead.custom_fields.destino", op: "eq", value: "paris-franca" }],
        context,
      ),
    ).toBe(true);
    expect((context.lead as { custom_fields: Record<string, unknown> }).custom_fields.destino).toBe(
      "paris-franca",
    );
    expect(renderTemplate("{{camposDoFunil}}", context)).toBe("");
    expect(calls.find((call) => call.table === "crm_pipelines")?.filters).toEqual([
      ["id", PIPELINE],
      ["organization_id", ORG],
    ]);
  });

  it("falha na leitura de settings mantém a automação e o valor original", async () => {
    const { admin } = adminFake({ pipelineError: true });
    const row = {
      organization_id: ORG,
      entity_kind: "crm_lead",
      entity_id: LEAD,
      payload: {},
    } as unknown as EventRow;

    const context = await buildContext(admin as unknown as SupabaseClient, row);

    expect(renderTemplate("Destino: {{destino}}", context)).toBe("Destino: paris-franca");
    expect((context.lead as { custom_fields: Record<string, unknown> }).custom_fields.destino).toBe(
      "paris-franca",
    );
  });

  it("não usa pipeline de outro tenant", async () => {
    const { admin, calls } = adminFake({ pipelineOrg: "33333333-3333-4333-8333-333333333333" });
    const row = {
      organization_id: ORG,
      entity_kind: "crm_lead",
      entity_id: LEAD,
      payload: {},
    } as unknown as EventRow;

    const context = await buildContext(admin as unknown as SupabaseClient, row);

    expect(renderTemplate("Destino: {{destino}}", context)).toBe("Destino: paris-franca");
    expect(calls.find((call) => call.table === "crm_pipelines")?.filters).toContainEqual([
      "organization_id",
      ORG,
    ]);
  });

  it("lead ausente ou custom_fields vazio não causa lookup de pipeline", async () => {
    const row = {
      organization_id: ORG,
      entity_kind: "crm_lead",
      entity_id: LEAD,
      payload: {},
    } as unknown as EventRow;

    for (const lead of [
      null,
      { id: LEAD, organization_id: ORG, pipeline_id: PIPELINE, custom_fields: {} },
    ]) {
      const { admin, calls } = adminFake({ lead });
      await buildContext(admin as unknown as SupabaseClient, row);
      expect(calls.some((call) => call.table === "crm_pipelines")).toBe(false);
    }
  });
});
