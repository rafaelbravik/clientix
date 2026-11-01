import { describe, expect, it, vi } from "vitest";
import type { SiteAuditResult } from "./site-classify";
import { reanalyzeCandidateSite, preserveDefinitiveSiteResult, type SiteCandidateQuery } from "./site-store";

const ORG_A = "10000000-0000-4000-8000-000000000011";
const ORG_B = "10000000-0000-4000-8000-000000000012";
const CANDIDATE = "20000000-0000-4000-8000-000000000011";

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
    facts: { trust: "UNTRUSTED_EXTERNAL_CONTENT", title: "Empresa", description: null, headings: [], visible_text_length: 900 },
    resumo: "UNTRUSTED_EXTERNAL_CONTENT: conteúdo público",
    ...overrides,
  };
}

describe("persistência tenant-scoped da auditoria de site", () => {
  it("mantém veredito definitivo e guarda uma falha provisória como última tentativa", () => {
    const previous = site();
    const transient = site({ classe: "nao-medido", status: "not_measured", provisorio: true, citavel: false, motivo: "timeout" });
    expect(preserveDefinitiveSiteResult(previous, transient)).toEqual({ ...previous, ultima_tentativa: transient });
  });

  it("consulta e atualiza o candidato com organization_id em ambas as queries", async () => {
    const definitive = site();
    const provisional = site({ classe: "nao-medido", status: "not_measured", provisorio: true, citavel: false, motivo: "timeout" });
    const query = vi.fn(async (sql: string, params: unknown[] = []) => {
        if (sql.startsWith("select data")) {
          return params[0] === ORG_A ? { rows: [{ data: { website: "https://empresa.example/", site: definitive } }] } : { rows: [] };
        }
        const stored = { ...definitive, ultima_tentativa: provisional };
        return { rows: [{ data: { website: "https://empresa.example/", site: stored } }], rowCount: 1 };
      });
    const db = { query } as unknown as SiteCandidateQuery;
    const audit = vi.fn().mockResolvedValue(provisional);
    const result = await reanalyzeCandidateSite(db, ORG_A, CANDIDATE, {
      audit,
      now: () => new Date("2026-11-01T12:00:00.000Z"),
    });
    expect(audit).toHaveBeenCalledWith("https://empresa.example/", "2026-11-01T12:00:00.000Z");
    expect(result.site).toMatchObject({ classe: "site-ok", ultima_tentativa: provisional });
    expect(query.mock.calls[0]?.[0]).toContain("organization_id=$1 and id=$2");
    expect(query.mock.calls[0]?.[1]).toEqual([ORG_A, CANDIDATE]);
    expect(query.mock.calls[1]?.[0]).toContain("organization_id=$1 and id=$2");
    expect(query.mock.calls[1]?.[0]).toContain("ultima_tentativa");
    expect(query.mock.calls[1]?.[1]?.slice(0, 2)).toEqual([ORG_A, CANDIDATE]);
  });

  it("não lê nem audita candidato de outra organização", async () => {
    const db = { query: vi.fn(async () => ({ rows: [] })) };
    const audit = vi.fn();
    await expect(reanalyzeCandidateSite(db, ORG_B, CANDIDATE, { audit })).rejects.toMatchObject({ code: "candidate_not_found", status: 404 });
    expect(db.query).toHaveBeenCalledWith(
      expect.stringContaining("where organization_id=$1 and id=$2"),
      [ORG_B, CANDIDATE],
    );
    expect(audit).not.toHaveBeenCalled();
    expect(JSON.stringify(db.query.mock.calls)).not.toContain(ORG_A);
  });
});
