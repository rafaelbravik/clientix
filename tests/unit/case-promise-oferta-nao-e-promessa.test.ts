import { describe, expect, it } from "vitest";

import { casePromiseGate, type GateContext } from "@/lib/agent-engine/guardrails/before-send";
import { detectHumanPromise } from "@/lib/agent-engine/guardrails/human-promise";
import { detectarPromessaDeRetornoDoAssistente } from "@/lib/agent-engine/guardrails/retorno-do-assistente";
import { PACING_DEFAULTS } from "@/lib/agent-engine/pacing/defaults";
import { SPINNING_DEFAULTS } from "@/lib/agent-engine/spinning/defaults";

const OFERTAS: readonly string[] = [
  "Quer que eu encaminhe para a equipe verificar?",
  "Entendi! Quer que eu encaminhe para a equipe verificar?",
  "Certo! Quer que eu fale com o responsável sobre isso?",
  "Ok! Quer que eu chame alguém do time para te ajudar?",
  "Sem problema! Você quer que eu peça para o setor verificar?",
  "Tudo bem! Quer falar com alguém da equipe?",
  "Sem problema, entendi! Quer que eu peça para a equipe verificar outro período?",
  "Claro! Quer que eu encaminhe para o setor?",
  "Combinado! Você gostaria de falar com alguém da equipe?",
];

const PROMESSAS: readonly string[] = [
  "Já transferi para a equipe. Você quer continuar?",
  "Vou encaminhar para o setor. Você quer?",
  "Nossa equipe vai retornar hoje.",
  "Já acionei o time.",
  "Quer que eu te transfira? Nossa equipe vai retornar hoje.",
  "Você quer falar com a equipe que já acabei de chamar?",
  "Entendi! Já encaminhei para a equipe, tudo bem?",
  "Já acionei o time. Quer que eu encaminhe para a equipe?",
  "Quer que eu encaminhe para a equipe? Em breve alguém te atende.",
  "Pode deixar. Quer que eu chame o responsável?",
  "Fica tranquilo. Quer que eu passe para a equipe?",
  "Entendi! Vou anotar aqui. Quer que eu encaminhe para a equipe?",
  "Entendi! Entendi! Quer que eu chame a equipe?",
  "Entendi, certo, claro! Quer que eu chame a equipe?",
  "Maravilha! Quer que eu encaminhe para a equipe?",
];

function baseCtx(overrides: Partial<GateContext> = {}): GateContext {
  return {
    now: new Date("2026-10-30T12:00:00Z"),
    body: "",
    optedOut: false,
    provider: "waha",
    pacing: {
      knobs: PACING_DEFAULTS,
      state: { lastSentAt: null, sentToday: 0, numberActivatedAt: null },
      crmDailyLimit: null,
    },
    spinning: { knobs: SPINNING_DEFAULTS, window: [] },
    promise: { table: null },
    semanticPromise: null,
    disclosure: { template: null, isFirstOutbound: false, mode: "inject" },
    lgpd: null,
    casesEnabled: false,
    hasOpenCase: false,
    openedCaseThisTurn: false,
    ...overrides,
  };
}

describe("Wave 8R — detector distingue oferta de promessa", () => {
  it.each(OFERTAS)("não detecta promessa na oferta: %s", (body) => {
    expect(detectHumanPromise(body)).toBe(false);
  });

  it.each(PROMESSAS)("detecta e mantém vetada a promessa ou abertura desconhecida: %s", (body) => {
    expect(detectHumanPromise(body)).toBe(true);
  });

  it("normaliza caixa, acentos, pontuação e alias vc antes de avaliar a abertura e a pergunta", () => {
    expect(detectHumanPromise("ENTENDIDO! VC quer que eu encaminhe para a equipe? ")).toBe(false);
    expect(detectHumanPromise("TUDO BEM! Você quer que eu fale com o responsável?")).toBe(false);
  });

  it("aceita duas expressões da lista fechada separadas por vírgula", () => {
    expect(detectHumanPromise("Sem problema, entendi! Quer que eu fale com a equipe?")).toBe(false);
  });

  it("falha fechado para texto vazio ou pergunta sem iniciador permitido", () => {
    expect(detectHumanPromise("  ")).toBe(false);
    expect(detectHumanPromise("A equipe pode me ajudar? Quer que eu encaminhe?")).toBe(true);
  });

  it("não inclui garantias na allowlist de reconhecimento", () => {
    expect(detectHumanPromise("Pode deixar. Quer que eu chame o responsável?")).toBe(true);
    expect(detectHumanPromise("Fica tranquilo. Quer que eu passe para a equipe?")).toBe(true);
  });
});

describe("Wave 8R — casePromiseGate e fail-safe", () => {
  it.each(OFERTAS)("deixa a oferta passar sem caso aberto e sem ativar o fail-safe: %s", (body) => {
    const verdict = casePromiseGate.evaluate(
      baseCtx({ casesEnabled: true, hasOpenCase: false, openedCaseThisTurn: false, body }),
    );
    expect(verdict).toEqual({ pass: true });
  });

  it.each(PROMESSAS)("veta promessa sem caso pelo código consumido pelo fail-safe: %s", (body) => {
    const verdict = casePromiseGate.evaluate(
      baseCtx({ casesEnabled: true, hasOpenCase: false, openedCaseThisTurn: false, body }),
    );
    expect(verdict.pass).toBe(false);
    if (!verdict.pass) expect(verdict.code).toBe("case_promise_without_case");
  });

  it("preserva o no-op quando casos estão desligados, inclusive para promessa real", () => {
    const verdict = casePromiseGate.evaluate(
      baseCtx({ casesEnabled: false, body: "Nossa equipe vai retornar hoje." }),
    );
    expect(verdict).toEqual({ pass: true });
  });

  it("preserva envio quando já existe caso aberto ou foi aberto neste turno", () => {
    expect(
      casePromiseGate.evaluate(
        baseCtx({ casesEnabled: true, hasOpenCase: true, body: "Vou encaminhar para o setor." }),
      ),
    ).toEqual({ pass: true });
    expect(
      casePromiseGate.evaluate(
        baseCtx({ casesEnabled: true, openedCaseThisTurn: true, body: "Vou encaminhar para o setor." }),
      ),
    ).toEqual({ pass: true });
  });
});

describe("retorno do assistente exige follow-up no mesmo turno", () => {
  it.each([
    "Combinado, retomamos daqui a duas horas.",
    "Amanhã eu volto a falar com você.",
    "Te chamo amanhã de manhã.",
    "A gente se fala mais tarde.",
  ])("detecta promessa clara de retorno: %s", (body) => {
    expect(detectarPromessaDeRetornoDoAssistente(body)).toBe(true);
  });

  it.each(["Retomando o que conversamos, seguem os detalhes.", "O sistema retoma automaticamente."])(
    "não confunde descrição/gerúndio com compromisso: %s",
    (body) => expect(detectarPromessaDeRetornoDoAssistente(body)).toBe(false),
  );

  it("veta retorno sem agendamento quando a feature de casos está desligada", () => {
    const verdict = casePromiseGate.evaluate(
      baseCtx({
        body: "Combinado, retomamos daqui a duas horas.",
        casesEnabled: false,
        followup: { disponivel: true, agendadoNesteTurno: false },
      }),
    );
    expect(verdict.pass).toBe(false);
    if (!verdict.pass) expect(verdict.code).toBe("followup_promise_without_followup");
  });

  it("libera retorno efetivamente agendado no turno", () => {
    expect(
      casePromiseGate.evaluate(
        baseCtx({
          body: "Combinado, retomamos daqui a duas horas.",
          followup: { disponivel: true, agendadoNesteTurno: true },
        }),
      ),
    ).toEqual({ pass: true });
  });

  it("explica quando a ferramenta de retorno não está disponível", () => {
    const verdict = casePromiseGate.evaluate(
      baseCtx({
        body: "Combinado, retomamos daqui a duas horas.",
        followup: { disponivel: false, agendadoNesteTurno: false },
      }),
    );
    expect(verdict.pass).toBe(false);
    if (!verdict.pass) expect(verdict.reason).toContain("não tem a ferramenta de retorno");
  });

  it("mantém caller sem contexto de follow-up retrocompatível", () => {
    expect(
      casePromiseGate.evaluate(
        baseCtx({ body: "Combinado, retomamos daqui a duas horas.", casesEnabled: false }),
      ),
    ).toEqual({ pass: true });
  });

  it("não reclassifica promessa de humano como retorno do assistente", () => {
    expect(
      casePromiseGate.evaluate(
        baseCtx({
          body: "Nossa equipe vai retornar hoje.",
          casesEnabled: false,
          followup: { disponivel: true, agendadoNesteTurno: false },
        }),
      ),
    ).toEqual({ pass: true });
  });
});
