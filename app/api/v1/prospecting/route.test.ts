import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  requireRole: vi.fn(),
  requireSupportWrite: vi.fn(),
  audit: vi.fn(),
  checkRateLimit: vi.fn(),
  getRequestPool: vi.fn(),
  createAdminClient: vi.fn(),
  withPreviewCandidateLock: vi.fn(),
  loadCandidate: vi.fn(),
  savePreview: vi.fn(),
  generatePreview: vi.fn(),
  strategy: vi.fn(),
  previewCurrent: vi.fn(),
  prepareCandidate: vi.fn(),
}));

vi.mock("@/lib/auth/require-role", () => ({ requireRole: mocks.requireRole }));
vi.mock("@/lib/impersonate/support", () => ({ requireSupportWrite: mocks.requireSupportWrite }));
vi.mock("@/lib/audit", () => ({ audit: mocks.audit }));
vi.mock("@/lib/ai/dispatcher/rate-limit", () => ({ checkRateLimit: mocks.checkRateLimit }));
vi.mock("@/lib/agent-engine/db/request-pool", () => ({ getRequestPool: mocks.getRequestPool }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: mocks.createAdminClient }));
vi.mock("@/lib/env", () => ({ env: { PROSPECTING_LOCAL_HTTP_URL: "" } }));
vi.mock("@/lib/prospecting/dispatcher", () => ({
  providerStatus: vi.fn(),
  providerNameForOrganization: vi.fn(),
  updateProspectingProvider: vi.fn(),
}));
vi.mock("@/lib/prospecting/store", () => ({
  activateCampaign: vi.fn(),
  configureCredential: vi.fn(),
  createSearch: vi.fn(),
  removeCredential: vi.fn(),
  validateConfig: vi.fn(),
  withProspectingLock: vi.fn(),
}));
vi.mock("@/lib/prospecting/site-store", () => ({ reanalyzeCandidateSite: vi.fn() }));
vi.mock("@/lib/prospecting/estrategia-site", () => ({ estrategiaDoCandidato: mocks.strategy }));
vi.mock("@/lib/prospecting/previa", () => ({ previaAtual: mocks.previewCurrent }));
vi.mock("@/lib/prospecting/previa-gerar", () => ({
  gerarPreviaDoCandidato: mocks.generatePreview,
}));
vi.mock("@/lib/prospecting/previa-store", () => ({
  carregarCandidatoParaPrevia: mocks.loadCandidate,
  salvarPreviaDoCandidato: mocks.savePreview,
  withPreviewCandidateLock: mocks.withPreviewCandidateLock,
}));
vi.mock("@/lib/prospecting/preparo", () => ({ prepararCandidato: mocks.prepareCandidate }));

const ORG_A = "10000000-0000-4000-8000-000000000011";
const ORG_B = "10000000-0000-4000-8000-000000000012";
const USER = "20000000-0000-4000-8000-000000000011";
const CANDIDATE = "30000000-0000-4000-8000-000000000011";
const AGENT = "50000000-0000-4000-8000-000000000011";
const VERSION = "60000000-0000-4000-8000-000000000011";
const pool = { query: vi.fn() };
const generated = {
  previa: {
    ver: 1,
    texto: "Prévia sintética de revisão.",
    site_fingerprint: "a".repeat(64),
    gerada_em: "2026-11-01T12:00:00.000Z",
    agente_id: AGENT,
    agente_versao_id: VERSION,
    provider: "openai-assinatura",
    model: "gpt-synthetic",
  },
  estrategia: { cenario: "Site medido", classe: "site-ok", angulo: "Sem reparo." },
};
function request(body: unknown) {
  return new Request("http://localhost/api/v1/prospecting", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("POST /api/v1/prospecting gerar_previa", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.requireSupportWrite.mockResolvedValue(null);
    mocks.requireRole.mockResolvedValue({
      ok: true,
      org: { orgId: ORG_A, name: "Org A", role: "admin" },
      user: { id: USER },
    });
    mocks.audit.mockResolvedValue(undefined);
    mocks.checkRateLimit.mockResolvedValue({ allowed: true });
    mocks.getRequestPool.mockReturnValue(pool);
    mocks.strategy.mockReturnValue(generated.estrategia);
    mocks.previewCurrent.mockReturnValue(null);
    mocks.prepareCandidate.mockResolvedValue({
      site: { classe: "site-ok", provisorio: false },
      strategy: generated.estrategia,
      preview: generated.previa,
      previewStatus: "ready",
      siteAttempted: false,
      previewAttempted: true,
    });
  });

  it("usa a organização da sessão em leitura, runtime, gravação e audit; não audita o texto", async () => {
    const { POST } = await import("./route");
    const response = await POST(request({ action: "gerar_previa", candidate_id: CANDIDATE }));
    expect(response.status).toBe(200);
    expect(mocks.requireRole).toHaveBeenCalledWith(
      "admin",
      expect.objectContaining({ resource: "prospecting" }),
    );
    expect(mocks.prepareCandidate).toHaveBeenCalledWith(pool, ORG_A, CANDIDATE, {
      mode: "preview",
    });
    expect(mocks.checkRateLimit.mock.calls.map(([key]) => key)).toEqual([
      `prospecting:preview:${ORG_A}:${CANDIDATE}`,
      `prospecting:preview-org:${ORG_A}`,
    ]);
    expect(mocks.audit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "prospecting.changed",
        organizationId: ORG_A,
        actorUserId: USER,
        resourceId: CANDIDATE,
        metadata: expect.objectContaining({
          operation: "gerar_previa",
          agent_id: AGENT,
          status: "generated",
        }),
      }),
    );
    const auditArgs = JSON.stringify(mocks.audit.mock.calls[0]?.[0]);
    expect(auditArgs).not.toContain(generated.previa.texto);
    expect(JSON.stringify(await response.json())).toContain(generated.previa.texto);
  });

  it("rejeita organization_id enviado pelo cliente antes de ler ou gravar candidato", async () => {
    const { POST } = await import("./route");
    const response = await POST(
      request({
        action: "gerar_previa",
        candidate_id: CANDIDATE,
        organization_id: ORG_B,
      }),
    );
    expect(response.status).toBe(422);
    expect(mocks.prepareCandidate).not.toHaveBeenCalled();
  });

  it("bloqueia role sem acesso antes de tocar no candidato", async () => {
    mocks.requireRole.mockResolvedValueOnce({
      ok: false,
      response: new Response(null, { status: 403 }),
    });
    const { POST } = await import("./route");
    const response = await POST(request({ action: "gerar_previa", candidate_id: CANDIDATE }));
    expect(response.status).toBe(403);
    expect(mocks.prepareCandidate).not.toHaveBeenCalled();
  });

  it("não revela payload do provider se a geração falhar", async () => {
    mocks.prepareCandidate.mockRejectedValueOnce(new Error("Bearer synthetic-secret"));
    const { POST } = await import("./route");
    const response = await POST(request({ action: "gerar_previa", candidate_id: CANDIDATE }));
    const body = await response.text();
    expect(response.status).toBe(500);
    expect(body).not.toContain("synthetic-secret");
  });
});
