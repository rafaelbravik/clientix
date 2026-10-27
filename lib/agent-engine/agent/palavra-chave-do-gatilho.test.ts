import fs from "node:fs";
import path from "node:path";

import { describe, expect, it, vi } from "vitest";

import type { Queryable } from "../queue/queue";
import {
  agenteJaRespondeuNoServico,
  avaliarFiltroDeEntrada,
  deveBloquearEntradaDoAgente,
  lerFiltroDeEntrada,
} from "./palavra-chave-do-gatilho";

describe("admissão por palavra-chave", () => {
  it("não filtra quando a versão publicada não definiu gatilho", () => {
    expect(lerFiltroDeEntrada({ filters: { keyword_regex: null } })).toBeNull();
    expect(avaliarFiltroDeEntrada(null, ["oi"])).toBe("sem_filtro");
  });

  it("barra somente uma conversa nova cujo lote pendente não corresponde", () => {
    const resultado = avaliarFiltroDeEntrada("\\bpreço\\b", ["Olá, tudo bem?"]);
    expect(resultado).toBe("nao_corresponde");
    expect(deveBloquearEntradaDoAgente(resultado, false)).toBe(true);
  });

  it("miss de palavra-chave não silencia o agente já engajado", () => {
    const resultado = avaliarFiltroDeEntrada("\\bpreço\\b", ["Olá, tudo bem?"]);
    expect(deveBloquearEntradaDoAgente(resultado, true)).toBe(false);
  });

  it("qualquer mensagem textual da rajada pode admitir a conversa", () => {
    expect(avaliarFiltroDeEntrada("\\bpreço\\b", ["Olá", "Quero saber o preço"])).toBe("corresponde");
  });

  it("regex inválida e lote sem texto (inclusive marcador de mídia) falham abertos", () => {
    const regexInvalida = avaliarFiltroDeEntrada("[", ["sem correspondência"]);
    const semTexto = avaliarFiltroDeEntrada("\\bpreço\\b", [null, "", "[audio]", "[location]"]);
    expect(regexInvalida).toBe("regex_invalida");
    expect(semTexto).toBe("sem_texto");
    expect(deveBloquearEntradaDoAgente(regexInvalida, false)).toBe(false);
    expect(deveBloquearEntradaDoAgente(semTexto, false)).toBe(false);
    expect(deveBloquearEntradaDoAgente("sem_filtro", false)).toBe(false);
  });

  it("uma resposta anterior não transforma uma nova mensagem em nova admissão", async () => {
    const query = vi.fn().mockResolvedValue({ rows: [{ ja_respondeu: true }] });
    await expect(
      agenteJaRespondeuNoServico({ query } as unknown as Queryable, {
        organizationId: "org-a",
        conversationId: "conv-a",
        agentId: "agent-a",
      }),
    ).resolves.toBe(true);

    const [sql, values] = query.mock.calls[0]!;
    expect(values).toEqual(["org-a", "conv-a", "agent-a"]);
    expect(sql).toMatch(/m\.organization_id\s*=\s*\$1/);
    expect(sql).toMatch(/m\.conversation_id\s*=\s*\$2/);
    expect(sql).toMatch(/m\.metadata\s*->>\s*'ai_actor_id'\s*=\s*\$3/);
    expect(sql).toMatch(/m\.direction\s*=\s*'outbound'/);
    expect(sql).toMatch(/m\.sent_via\s*=\s*'ai'/);
    expect(sql).toMatch(/m\.status\s*<>\s*'failed'/);
    expect(sql).toMatch(/m\.sent_at\s*>=\s*c\.service_started_at/);
    expect(sql).not.toMatch(/active_ai_agent_id/);
  });

  it("o turno vivo aplica o filtro depois de humano/STOP e antes de iniciar o roteiro", () => {
    const source = fs.readFileSync(
      path.join(process.cwd(), "lib/agent-engine/agent/inbound-turn.ts"),
      "utf8",
    );
    const handoff = source.indexOf("if (\n    !preview &&\n    inboundsPendentes.some(");
    const optOut = source.indexOf("if (!preview && inboundsPendentes.some((texto) => detectAmbiguousOptOut(texto)))");
    const helper = source.indexOf("const filtroDeEntradaPermite = async");
    const gate = source.indexOf("if (!(await filtroDeEntradaPermite(inboundsPendentes))) return;");
    const businessHours = source.indexOf(
      "await aplicarJanelaDeAtendimento();",
      gate,
    );
    const roteiro = source.indexOf("const roteiro =", gate);

    expect(handoff).toBeGreaterThanOrEqual(0);
    expect(optOut).toBeGreaterThan(handoff);
    expect(gate).toBeGreaterThan(optOut);
    expect(businessHours).toBeGreaterThan(gate);
    expect(roteiro).toBeGreaterThan(businessHours);
    expect(roteiro).toBeGreaterThan(gate);
    expect(source.slice(helper, gate)).toMatch(/liveJob\(\)\.kind !== 'inbound_turn'/);
    expect(source.slice(helper, gate)).not.toContain("operationMode !== 'assisted'");
  });

  it("o filtro de admissão não remove rascunhos do modo assistido, sujeitos a revisão humana", () => {
    const source = fs.readFileSync(
      path.join(process.cwd(), "lib/agent-engine/agent/inbound-turn.ts"),
      "utf8",
    );
    const branch = source.indexOf("agentConfig?.operationMode === 'assisted'");
    const endBranch = source.indexOf("if (!preview && agentConfig &&", branch);
    const detection = source.indexOf("deteccoesDeterministicasDoAssistido(pool, deps", branch);
    const draft = source.indexOf("generateReplyDraft(pool, deps", detection);

    expect(branch).toBeGreaterThanOrEqual(0);
    expect(endBranch).toBeGreaterThan(branch);
    expect(detection).toBeGreaterThan(branch);
    expect(draft).toBeGreaterThan(detection);
    expect(source.slice(branch, endBranch)).not.toContain("filtroDeEntradaPermite");
    expect(source.slice(branch, endBranch)).not.toContain("aplicarJanelaDeAtendimento");
  });
});
