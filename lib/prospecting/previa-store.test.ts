import { describe, expect, it, vi } from "vitest";
import { carregarCandidatoParaPrevia, salvarPreviaDoCandidato, withPreviewCandidateLock } from "./previa-store";
import { ProspectingError } from "./provider";

const ORG_A = "10000000-0000-4000-8000-000000000011";
const CANDIDATE = "20000000-0000-4000-8000-000000000011";
const CAMPAIGN = "30000000-0000-4000-8000-000000000011";

describe("persistência e concorrência da prévia", () => {
  it("carrega candidato e campanha somente pela organização da sessão", async () => {
    const row = { id: CANDIDATE, campaign_id: CAMPAIGN, data: {}, status: "new", contact_id: null, config: {}, search: {} };
    const query = vi.fn().mockResolvedValue({ rows: [row] });
    await expect(carregarCandidatoParaPrevia({ query } as never, ORG_A, CANDIDATE)).resolves.toEqual(row);
    expect(query.mock.calls[0]?.[0]).toContain("c.organization_id=p.organization_id");
    expect(query.mock.calls[0]?.[0]).toContain("where p.organization_id=$1 and p.id=$2");
    expect(query.mock.calls[0]?.[1]).toEqual([ORG_A, CANDIDATE]);
  });

  it("não encontra nem atualiza candidato de outro tenant", async () => {
    const query = vi.fn().mockResolvedValue({ rows: [] });
    await expect(carregarCandidatoParaPrevia({ query } as never, ORG_A, CANDIDATE))
      .rejects.toMatchObject({ code: "candidate_not_found", status: 404 });
    await expect(salvarPreviaDoCandidato({ query } as never, {
      organizationId: ORG_A,
      campaignId: CAMPAIGN,
      candidateId: CANDIDATE,
      expectedWebsite: "https://empresa.example",
      expectedSiteJson: null,
      previa: {} as never,
    })).rejects.toMatchObject({ code: "preview_source_changed", status: 409 });
    expect(query.mock.calls[1]?.[0]).toContain("where organization_id=$1 and campaign_id=$2 and id=$3");
    expect(query.mock.calls[1]?.[1]?.slice(0, 3)).toEqual([ORG_A, CAMPAIGN, CANDIDATE]);
  });

  it("salva somente a chave previa e preserva o JSONB de auditoria existente", async () => {
    const query = vi.fn().mockResolvedValue({ rows: [{ id: CANDIDATE }] });
    await salvarPreviaDoCandidato({ query } as never, {
      organizationId: ORG_A,
      campaignId: CAMPAIGN,
      candidateId: CANDIDATE,
      expectedWebsite: "https://empresa.example",
      expectedSiteJson: '{"classe":"site-ok"}',
      previa: { texto: "prévia sintética" } as never,
    });
    expect(query.mock.calls[0]?.[0]).toContain("coalesce(data,'{}'::jsonb) || jsonb_build_object('previa',$6::jsonb)");
    expect(query.mock.calls[0]?.[0]).toContain("data->'site' is not distinct from $5::jsonb");
    expect(query.mock.calls[0]?.[0]).toContain("and status in ('new','queued')");
    expect(query.mock.calls[0]?.[1]?.slice(0, 5)).toEqual([
      ORG_A,
      CAMPAIGN,
      CANDIDATE,
      "https://empresa.example",
      '{"classe":"site-ok"}',
    ]);
  });

  it("bloqueia geração concorrente na mesma organização/candidato e libera o lock no fim", async () => {
    let held = false;
    const calls: string[] = [];
    const pool = {
      connect: vi.fn(async () => ({
        query: vi.fn(async (sql: string) => {
          calls.push(sql);
          if (sql.includes("pg_try_advisory_lock")) {
            if (held) return { rows: [{ locked: false }] };
            held = true;
            return { rows: [{ locked: true }] };
          }
          if (sql.includes("pg_advisory_unlock")) {
            held = false;
            return { rows: [{ pg_advisory_unlock: true }] };
          }
          return { rows: [] };
        }),
        release: vi.fn(),
      })),
    };
    let resolveFirst!: () => void;
    const firstGate = new Promise<void>((resolve) => { resolveFirst = resolve; });
    const first = withPreviewCandidateLock(pool as never, ORG_A, CANDIDATE, async () => {
      await firstGate;
      return "first";
    });
    await Promise.resolve();
    await expect(withPreviewCandidateLock(pool as never, ORG_A, CANDIDATE, async () => "second"))
      .rejects.toBeInstanceOf(ProspectingError);
    resolveFirst();
    await expect(first).resolves.toBe("first");
    expect(held).toBe(false);
    expect(calls.some((sql) => sql.includes("pg_advisory_unlock"))).toBe(true);
  });
});
