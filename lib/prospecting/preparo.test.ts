import { describe, expect, it, vi } from "vitest";
import {
  PREPARATION_LIMITS,
  prepararCandidato,
  prepararCandidatos,
  type CandidatePreparationOptions,
} from "./preparo";
import type { SiteAuditResult } from "./site-classify";
import { fingerprintDoSite, type PreviaSalva } from "./previa";
import type { gerarPreviaDoCandidato, LinhaParaPrevia } from "./previa-gerar";

const ORG_A = "10000000-0000-4000-8000-000000000011";
const ORG_B = "10000000-0000-4000-8000-000000000012";
const CAMPAIGN = "20000000-0000-4000-8000-000000000011";
const CANDIDATE = "30000000-0000-4000-8000-000000000011";
const AGENT = "40000000-0000-4000-8000-000000000011";
const VERSION = "50000000-0000-4000-8000-000000000011";

function site(overrides: Partial<SiteAuditResult> = {}): SiteAuditResult {
  return {
    ver: 1,
    classe: "site-ok",
    status: "checked",
    provisorio: false,
    citavel: true,
    external_content_trust: "UNTRUSTED_EXTERNAL_CONTENT",
    verificado_em: "2026-11-01T12:00:00.000Z",
    url: "https://empresa.example/",
    final_url: "https://empresa.example/",
    http_status: 200,
    tempo_ms: 100,
    https_disponivel: true,
    tls_valido: true,
    mobile_hint: true,
    empty_hint: false,
    builder_hint: null,
    motivo: null,
    facts: null,
    resumo: null,
    ...overrides,
  };
}

function preview(overrides: Partial<PreviaSalva> = {}): PreviaSalva {
  return {
    ver: 1,
    texto: "Olá, gostaria de conversar sobre seu site?",
    site_fingerprint: "a".repeat(64),
    gerada_em: "2026-11-01T12:00:00.000Z",
    agente_id: AGENT,
    agente_versao_id: VERSION,
    provider: "openai-assinatura",
    model: "gpt-subscription-synthetic",
    ...overrides,
  };
}

type PreparationTestRow = {
  id: string;
  campaign_id: string;
  status: string;
  contact_id: string | null;
  config: unknown;
  search: unknown;
  campaign_status: string;
  search_status: string;
  agent_version_id: string | null;
  agent_ready: boolean;
  data: Record<string, unknown>;
};

function preparationRow(overrides: Partial<PreparationTestRow> = {}): PreparationTestRow {
  return {
    id: CANDIDATE,
    campaign_id: CAMPAIGN,
    status: "new",
    contact_id: null,
    config: {
      agent_id: AGENT,
      instruction: "Apresente a empresa com clareza.",
      qualification: "Confirme se existe interesse.",
    },
    search: { avaliar_site: true, gerar_previa: true },
    campaign_status: "draft",
    search_status: "succeeded",
    agent_version_id: VERSION,
    agent_ready: true,
    data: { website: "https://empresa.example/", name: "Empresa sintética" },
    ...overrides,
  };
}

function lockClient(locked = true) {
  return {
    query: vi.fn(async (sql: string) =>
      sql.includes("pg_try_advisory_lock")
        ? { rows: [{ locked }] }
        : { rows: [{ pg_advisory_unlock: true }] },
    ),
    release: vi.fn(),
  };
}

function statefulPool(initial = preparationRow()) {
  let data = structuredClone(initial.data as Record<string, unknown>);
  const queries: Array<{ sql: string; params: unknown[] }> = [];
  const pool = {
    connect: vi.fn(async () => lockClient()),
    query: vi.fn(async (sql: string, params: unknown[] = []) => {
      queries.push({ sql, params });
      if (sql.startsWith("select p.id,p.campaign_id")) {
        if (params[0] === ORG_B) return { rows: [] };
        return { rows: [{ ...initial, data: structuredClone(data) }] };
      }
      if (sql.startsWith("select p.id,p.data,p.status,c.config,c.search")) {
        if (params[0] === ORG_B) return { rows: [] };
        return {
          rows: [
            {
              id: CANDIDATE,
              campaign_id: CAMPAIGN,
              data: structuredClone(data),
              status: initial.status,
              contact_id: initial.contact_id,
              config: initial.config,
              search: initial.search,
            },
          ],
        };
      }
      if (sql.startsWith("select data from prospecting_candidates")) {
        if (params[0] === ORG_B) return { rows: [] };
        return { rows: [{ data: structuredClone(data) }] };
      }
      if (sql.startsWith("update prospecting_candidates") && sql.includes("set data = case")) {
        const nextSite = JSON.parse(String(params[2])) as SiteAuditResult;
        data = { ...data, site: nextSite };
        return { rows: [{ data: structuredClone(data) }], rowCount: 1 };
      }
      if (
        sql.startsWith("update prospecting_candidates") &&
        sql.includes("jsonb_build_object('preparacao'")
      ) {
        const key = String(params[3]);
        const value = JSON.parse(String(params[4])) as unknown;
        data = {
          ...data,
          preparacao: { ...((data.preparacao as object | undefined) ?? {}), [key]: value },
        };
        return { rows: [{ id: CANDIDATE }], rowCount: 1 };
      }
      if (
        sql.startsWith("update prospecting_candidates") &&
        sql.includes("jsonb_build_object('previa'")
      ) {
        data = { ...data, previa: JSON.parse(String(params[5])) as PreviaSalva };
        return { rows: [{ id: CANDIDATE }], rowCount: 1 };
      }
      return { rows: [] };
    }),
  };
  return { pool, queries, currentData: () => data };
}

describe("preparo automático da prospecção", () => {
  it("usa os limites por organização e mantém concorrência de preview em três", () => {
    expect(PREPARATION_LIMITS).toMatchObject({
      sitesPerRound: 30,
      previewsPerRound: 8,
      modelParallelism: 3,
      organizationDeadlineMs: 100_000,
    });
  });

  it("reanálise manual usa o store P0-2B e devolve a estratégia P0-2C", async () => {
    const { pool, queries } = statefulPool();
    const auditSite = vi.fn().mockResolvedValue(site());
    const result = await prepararCandidato(pool as never, ORG_A, CANDIDATE, {
      mode: "reanalyze",
      auditSite,
      now: () => new Date("2026-11-01T12:00:00.000Z"),
    });
    expect(auditSite).toHaveBeenCalledWith("https://empresa.example/", "2026-11-01T12:00:00.000Z");
    expect(result.site).toMatchObject({ classe: "site-ok", provisorio: false });
    expect(result.strategy.cenario).toBeTruthy();
    expect(result.previewStatus).toBe("none");
    expect(
      queries.filter((query) => query.sql.includes("organization_id=$1 and id=$2")),
    ).toHaveLength(2);
    expect(queries.every((query) => query.params[0] !== ORG_B)).toBe(true);
  });

  it("nega tenant cruzado antes de ler site ou chamar a auditoria", async () => {
    const { pool, queries } = statefulPool();
    const auditSite = vi.fn();
    await expect(
      prepararCandidato(pool as never, ORG_B, CANDIDATE, {
        mode: "reanalyze",
        auditSite,
      }),
    ).rejects.toMatchObject({ code: "candidate_not_found" });
    expect(auditSite).not.toHaveBeenCalled();
    expect(queries.every((query) => query.params[0] === ORG_B)).toBe(true);
  });

  it("manual preview usa o generator P0-2C e grava somente no candidato da organização", async () => {
    const { pool, queries, currentData } = statefulPool({
      ...preparationRow(),
      data: { website: "https://empresa.example/", site: site() },
    });
    const generated = preview();
    const generatePreview = vi
      .fn()
      .mockResolvedValue({ previa: generated, estrategia: { cenario: "site-ok" } });
    const result = await prepararCandidato(pool as never, ORG_A, CANDIDATE, {
      mode: "preview",
      generatePreview: generatePreview as unknown as typeof gerarPreviaDoCandidato,
    } satisfies CandidatePreparationOptions);
    expect(generatePreview).toHaveBeenCalledOnce();
    expect(generatePreview.mock.calls[0]?.[1]).toBe(ORG_A);
    expect(result.preview).toEqual(generated);
    expect(currentData().previa).toEqual(generated);
    const save = queries.find((query) => query.sql.includes("jsonb_build_object('previa'"));
    expect(save?.sql).toContain("where organization_id=$1 and campaign_id=$2 and id=$3");
    expect(save?.params.slice(0, 3)).toEqual([ORG_A, CAMPAIGN, CANDIDATE]);
  });

  it("campanha pausada interrompe tarefas novas sem chamar auditoria nem runtime", async () => {
    const { pool } = statefulPool({ ...preparationRow(), campaign_status: "paused" });
    const auditSite = vi.fn();
    const generatePreview = vi.fn();
    const result = await prepararCandidato(pool as never, ORG_A, CANDIDATE, {
      mode: "worker",
      auditSite,
      generatePreview: generatePreview as never,
    });
    expect(result.siteAttempted).toBe(false);
    expect(result.previewAttempted).toBe(false);
    expect(auditSite).not.toHaveBeenCalled();
    expect(generatePreview).not.toHaveBeenCalled();
  });

  it("worker limita auditorias a 30 por rodada e não usa coluna selected", async () => {
    const rows = Array.from({ length: 40 }, (_, index) => ({
      ...preparationRow({
        id: `candidate-${index}`,
        data: { website: `https://${index}.example/` },
        search: { avaliar_site: true, gerar_previa: false },
      }),
    }));
    const client = lockClient();
    const pool = {
      connect: vi.fn(async () => client),
      query: vi.fn(async (sql: string) =>
        sql.startsWith("select p.id,p.campaign_id") ? { rows } : { rows },
      ),
    };
    let running = 0;
    let maxRunning = 0;
    const prepare = vi.fn(async () => {
      running++;
      maxRunning = Math.max(maxRunning, running);
      await new Promise((resolve) => setTimeout(resolve, 2));
      running--;
      return {
        site: site(),
        strategy: {} as never,
        preview: null,
        previewStatus: "none" as const,
        siteAttempted: true,
        previewAttempted: false,
      };
    });
    const summary = await prepararCandidatos(
      pool as never,
      {} as never,
      ORG_A,
      "req-a",
      Date.now() + 60_000,
      {
        prepareCandidate: prepare as unknown as typeof prepararCandidato,
      },
    );
    expect(summary.sitesAttempted).toBe(30);
    expect(summary.sitesCompleted).toBe(30);
    expect(prepare).toHaveBeenCalledTimes(30);
    expect(maxRunning).toBeLessThanOrEqual(PREPARATION_LIMITS.siteParallelism);
    expect(pool.query.mock.calls.every(([sql]) => !String(sql).includes("selected"))).toBe(true);
  });

  it("worker limita prévias a 8 por rodada e concorrência do runtime a três", async () => {
    const rows = Array.from({ length: 15 }, (_, index) => ({
      ...preparationRow({
        id: `candidate-${index}`,
        data: { website: `https://${index}.example/`, site: site() },
        search: { avaliar_site: true, gerar_previa: true },
      }),
    }));
    const pool = {
      connect: vi.fn(async () => lockClient()),
      query: vi.fn(async () => ({ rows })),
    };
    let running = 0;
    let maxRunning = 0;
    const prepare = vi.fn(async () => {
      running++;
      maxRunning = Math.max(maxRunning, running);
      await new Promise((resolve) => setTimeout(resolve, 2));
      running--;
      return {
        site: site(),
        strategy: {} as never,
        preview: preview(),
        previewStatus: "ready" as const,
        siteAttempted: false,
        previewAttempted: true,
      };
    });
    const summary = await prepararCandidatos(
      pool as never,
      {} as never,
      ORG_A,
      "req-a",
      Date.now() + 60_000,
      {
        prepareCandidate: prepare as unknown as typeof prepararCandidato,
      },
    );
    expect(summary.previewsAttempted).toBe(8);
    expect(summary.previewsCompleted).toBe(8);
    expect(prepare).toHaveBeenCalledTimes(8);
    expect(maxRunning).toBeLessThanOrEqual(PREPARATION_LIMITS.modelParallelism);
  });

  it("encerra o lote de prévias depois de três falhas consecutivas", async () => {
    const rows = Array.from({ length: 8 }, (_, index) => ({
      ...preparationRow({
        id: `candidate-${index}`,
        data: { website: `https://${index}.example/`, site: site() },
        search: { avaliar_site: true, gerar_previa: true },
      }),
    }));
    const pool = {
      connect: vi.fn(async () => lockClient()),
      query: vi.fn(async () => ({ rows })),
    };
    const prepare = vi.fn(async () => ({
      site: site(),
      strategy: {} as never,
      preview: null,
      previewStatus: "error" as const,
      siteAttempted: false,
      previewAttempted: true,
    }));
    await prepararCandidatos(pool as never, {} as never, ORG_A, "req-a", Date.now() + 60_000, {
      prepareCandidate: prepare as unknown as typeof prepararCandidato,
    });
    expect(prepare).toHaveBeenCalledTimes(3);
  });

  it("não repete tentativas de preview indisponível até o agente ficar pronto", async () => {
    const rows = [
      {
        ...preparationRow({
          data: {
            website: "https://empresa.example/",
            site: site(),
            preparacao: { preview: { status: "not_available" } },
          },
        }),
        agent_ready: false,
      },
    ];
    const pool = {
      connect: vi.fn(async () => lockClient()),
      query: vi.fn(async () => ({ rows })),
    };
    const prepare = vi.fn();
    const summary = await prepararCandidatos(
      pool as never,
      {} as never,
      ORG_A,
      "req-a",
      Date.now() + 60_000,
      {
        prepareCandidate: prepare as unknown as typeof prepararCandidato,
      },
    );
    expect(summary.previewsAttempted).toBe(0);
    expect(prepare).not.toHaveBeenCalled();
  });

  it("não executa trabalho quando outra rodada já detém o lock da organização", async () => {
    const pool = { connect: vi.fn(async () => lockClient(false)), query: vi.fn() };
    const summary = await prepararCandidatos(pool as never, {} as never, ORG_A, "req-a");
    expect(summary.skipped).toBe(true);
    expect(pool.query).not.toHaveBeenCalled();
  });

  it("não refaz preview válida para o mesmo fingerprint e versão", async () => {
    const candidateData = { website: "https://empresa.example/", site: site() };
    const current = preview({
      site_fingerprint: fingerprintDoSite(candidateData),
      agente_versao_id: VERSION,
    });
    const { pool } = statefulPool({
      ...preparationRow(),
      data: { ...candidateData, previa: current },
    });
    const generatePreview = vi.fn();
    const result = await prepararCandidato(pool as never, ORG_A, CANDIDATE, {
      mode: "worker",
      autoAudit: false,
      generatePreview: generatePreview as never,
    });
    expect(result.previewAttempted).toBe(false);
    expect(generatePreview).not.toHaveBeenCalled();
  });
});
