import { describe, expect, it } from "vitest";

import {
  casePromiseGate,
  type GateContext,
} from "@/lib/agent-engine/guardrails/before-send";
import { detectHumanPromise } from "@/lib/agent-engine/guardrails/human-promise";
import { PACING_DEFAULTS } from "@/lib/agent-engine/pacing/defaults";
import { SPINNING_DEFAULTS } from "@/lib/agent-engine/spinning/defaults";

const OFERTA = "Entendi! Quer que eu encaminhe para a equipe verificar?";
const PROMESSA = "Vou encaminhar para o setor. Você quer?";

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
    casesEnabled: true,
    hasOpenCase: false,
    openedCaseThisTurn: false,
    ...overrides,
  };
}

describe("invariante: oferta de humano não é promessa executada", () => {
  it("mantém oferta com reconhecimento fora do gate de caso", () => {
    expect(detectHumanPromise(OFERTA)).toBe(false);
    expect(casePromiseGate.evaluate(baseCtx({ body: OFERTA }))).toEqual({ pass: true });
  });

  it("mantém promessa real vetada sem caso aberto", () => {
    expect(detectHumanPromise(PROMESSA)).toBe(true);
    expect(casePromiseGate.evaluate(baseCtx({ body: PROMESSA }))).toMatchObject({
      pass: false,
      code: "case_promise_without_case",
    });
  });
});
