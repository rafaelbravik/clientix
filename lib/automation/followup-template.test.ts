import { describe, expect, it, vi } from "vitest";

import type { Queryable } from "@/lib/agent-engine/queue/queue";
import { renderizarCamposPersonalizadosNoFollowup } from "@/lib/automation/followup-template";

const ORG = "22222222-2222-4222-8222-222222222222";
const CONTACT = "33333333-3333-4333-8333-333333333333";
const PIPELINE = "44444444-4444-4444-8444-444444444444";
const LEAD = "55555555-5555-4555-8555-555555555555";

function database(
  options: {
    leads?: Array<Record<string, unknown>>;
    settings?: Record<string, unknown> | null;
    fail?: boolean;
  } = {},
) {
  const calls: Array<{ sql: string; values: unknown[] }> = [];
  const query = vi.fn(async (sql: string, values: unknown[] = []) => {
    calls.push({ sql, values });
    if (options.fail) throw new Error("read failed");
    if (sql.includes("from crm_leads l")) return { rows: options.leads ?? [] };
    if (sql.includes("from crm_pipelines"))
      return { rows: [{ settings: options.settings ?? null }] };
    throw new Error("unexpected query");
  });
  return { db: { query } as unknown as Queryable, calls, query };
}

function lead(customFields: Record<string, unknown> | null = { destino: "paris-franca" }) {
  return {
    id: LEAD,
    organization_id: ORG,
    pipeline_id: PIPELINE,
    status: "open",
    last_activity_at: "2026-10-01T10:00:00.000Z",
    created_at: "2026-09-01T10:00:00.000Z",
    custom_fields: customFields,
    pipeline_is_default: true,
  };
}

const SETTINGS = {
  fields: [
    {
      key: "destino",
      label: "Destino",
      type: "select",
      options: [{ value: "paris-franca", label: "Paris (França)" }],
    },
  ],
};

describe("follow-up usa o renderer comum para campos de lista", () => {
  it("traduz labels, conserva tokens alheios e consulta lead/pipeline no tenant", async () => {
    const { db, calls } = database({ leads: [lead()], settings: SETTINGS });

    const result = await renderizarCamposPersonalizadosNoFollowup(db, {
      organizationId: ORG,
      contactId: CONTACT,
      template: "Oi {{nome}}, destino {{destino}} / {{lead.custom_fields.destino}} / {{volta}}",
      context: { contact: { name: "Ana" } },
    });

    expect(result).toBe("Oi {{nome}}, destino Paris (França) / Paris (França) / {{volta}}");
    expect(calls).toHaveLength(2);
    expect(calls[0]?.sql).toContain("l.organization_id = $1 and l.contact_id = $2");
    expect(calls[0]?.sql).toContain("p.organization_id = l.organization_id");
    expect(calls[0]?.values).toEqual([ORG, CONTACT]);
    expect(calls[1]?.sql).toContain("where organization_id = $1 and id = $2");
    expect(calls[1]?.values).toEqual([ORG, PIPELINE]);
  });

  it("não faz leitura de settings sem valores personalizados", async () => {
    const { db, calls } = database({ leads: [lead({})] });

    const result = await renderizarCamposPersonalizadosNoFollowup(db, {
      organizationId: ORG,
      contactId: CONTACT,
      template: "Destino {{destino}}",
    });

    expect(result).toBe("Destino {{destino}}");
    expect(calls).toHaveLength(1);
  });

  it("sem lead ativo não escolhe outro registro nem consulta settings", async () => {
    const { db, calls } = database({ leads: [{ ...lead(), status: "won" }] });

    const result = await renderizarCamposPersonalizadosNoFollowup(db, {
      organizationId: ORG,
      contactId: CONTACT,
      template: "Destino {{destino}}",
    });

    expect(result).toBe("Destino {{destino}}");
    expect(calls).toHaveLength(1);
  });

  it("mantém valor removido e aplica fallback somente quando vazio", async () => {
    const { db } = database({
      leads: [lead({ destino: "operadora-removida" })],
      settings: SETTINGS,
    });
    const { db: dbVazio } = database({ leads: [lead({ destino: "" })], settings: SETTINGS });

    const unknown = await renderizarCamposPersonalizadosNoFollowup(db, {
      organizationId: ORG,
      contactId: CONTACT,
      template: "{{destino}}",
    });
    const empty = await renderizarCamposPersonalizadosNoFollowup(dbVazio, {
      organizationId: ORG,
      contactId: CONTACT,
      template: '{{destino|"a definir"}}',
    });

    expect(unknown).toBe("operadora-removida");
    expect(empty).toBe("a definir");
  });

  it("erro de apoio não bloqueia nem altera o corpo do follow-up", async () => {
    const { db } = database({ fail: true });
    const body = "Destino {{destino}}";

    await expect(
      renderizarCamposPersonalizadosNoFollowup(db, {
        organizationId: ORG,
        contactId: CONTACT,
        template: body,
      }),
    ).resolves.toBe(body);
  });
});
