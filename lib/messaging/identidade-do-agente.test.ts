import { describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";

import {
  idDoAgenteEmissor,
  metadataComNomeDoAgente,
  nomeDoAgenteEmissor,
} from "./identidade-do-agente";

const ORG = "11111111-1111-4111-8111-111111111111";
const AGENT = "22222222-2222-4222-8222-222222222222";
const OTHER_ORG = "33333333-3333-4333-8333-333333333333";

function clientFalso(nome: string | null, filtros?: Array<[string, string]>) {
  const query: Record<string, unknown> = {};
  query.select = vi.fn(() => query);
  query.eq = vi.fn((campo: string, valor: string) => {
    filtros?.push([campo, valor]);
    return query;
  });
  query.maybeSingle = vi.fn(async () => ({
    data: nome === null ? null : { name: nome },
    error: null,
  }));
  const supabase = { from: vi.fn(() => query) } as unknown as SupabaseClient;
  return { supabase, query };
}

describe("identidade do agente emissor", () => {
  it("usa agent_id, nunca confunde ai_agent.id com run id", () => {
    expect(idDoAgenteEmissor({ type: "ai_agent", id: "run-id", agent_id: AGENT, role: "agent" })).toBe(AGENT);
    expect(idDoAgenteEmissor({ type: "ai_agent", id: AGENT, role: "agent" })).toBeNull();
  });

  it("usa agent_id em webhook somente quando o texto foi escrito pela IA", () => {
    expect(
      idDoAgenteEmissor({ type: "webhook_source", id: "rule-id", textoEscritoPelaIA: true, agent_id: AGENT }),
    ).toBe(AGENT);
    expect(idDoAgenteEmissor({ type: "webhook_source", id: "rule-id", agent_id: AGENT })).toBeNull();
  });

  it("consulta o nome por organization_id + id do agente e remove espaços externos", async () => {
    const filtros: Array<[string, string]> = [];
    const { supabase } = clientFalso("  Bia da Locação  ", filtros);

    await expect(
      nomeDoAgenteEmissor(supabase, ORG, {
        type: "ai_agent",
        id: "run-id",
        agent_id: AGENT,
        role: "agent",
      }),
    ).resolves.toBe("Bia da Locação");
    expect(supabase.from).toHaveBeenCalledWith("ai_agents");
    expect(supabase.from).toHaveBeenCalledTimes(1);
    expect(filtros).toEqual([
      ["organization_id", ORG],
      ["id", AGENT],
    ]);
  });

  it("não retorna nome de outra organização", async () => {
    const filtros: Array<[string, string]> = [];
    const { supabase } = clientFalso(null, filtros);

    await expect(
      nomeDoAgenteEmissor(supabase, OTHER_ORG, {
        type: "ai_agent",
        id: "run-id",
        agent_id: AGENT,
        role: "agent",
      }),
    ).resolves.toBeNull();
    expect(filtros).toContainEqual(["organization_id", OTHER_ORG]);
    expect(filtros).toContainEqual(["id", AGENT]);
  });

  it("não consulta com id genérico/inválido nem com ator sem autoria IA", async () => {
    const { supabase } = clientFalso("não deve ser lido");
    await expect(
      nomeDoAgenteEmissor(supabase, ORG, { type: "ai_agent", id: "agent-engine", role: "agent" }),
    ).resolves.toBeNull();
    await expect(
      nomeDoAgenteEmissor(supabase, ORG, { type: "webhook_source", id: "rule", agent_id: AGENT }),
    ).resolves.toBeNull();
    expect(supabase.from).not.toHaveBeenCalled();
  });

  it("metadata canônico do servidor vence nome forjado e preserva outros metadados", () => {
    expect(
      metadataComNomeDoAgente(
        { trace_id: "trace-1", ai_actor_name: "Forjado" },
        true,
        "  Bia da Locação ",
      ),
    ).toEqual({ trace_id: "trace-1", ai_actor_name: "Bia da Locação" });
  });

  it("sobrescreve o valor forjado com null quando não há identidade confiável", () => {
    expect(
      metadataComNomeDoAgente({ ai_actor_name: "Forjado", agent_name: "Alias" }, true, null),
    ).toEqual({ ai_actor_name: null, agent_name: "Alias" });
  });

  it("retira a chave reservada de mensagem que não é IA", () => {
    expect(metadataComNomeDoAgente({ ai_actor_name: "Forjado", request_id: "r1" }, false, null)).toEqual({
      request_id: "r1",
    });
  });
});
