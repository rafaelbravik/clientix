import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  requireRole: vi.fn(),
  requireSupportWrite: vi.fn(),
  audit: vi.fn(),
  updateProvider: vi.fn(),
  configureCredential: vi.fn(),
  removeCredential: vi.fn(),
  pool: { query: vi.fn(), connect: vi.fn() },
}));

vi.mock("@/lib/auth/require-role", () => ({ requireRole: mocks.requireRole }));
vi.mock("@/lib/impersonate/support", () => ({ requireSupportWrite: mocks.requireSupportWrite }));
vi.mock("@/lib/audit", () => ({ audit: mocks.audit }));
vi.mock("@/lib/agent-engine/db/request-pool", () => ({ getRequestPool: () => mocks.pool }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: () => ({}) }));
vi.mock("@/lib/prospecting/dispatcher", () => ({
  providerStatus: () => "apify_missing_credential",
  providerNameForOrganization: vi.fn(),
  updateProspectingProvider: mocks.updateProvider,
}));
vi.mock("@/lib/prospecting/store", () => ({
  activateCampaign: vi.fn(),
  configureCredential: mocks.configureCredential,
  createSearch: vi.fn(),
  removeCredential: mocks.removeCredential,
  validateConfig: vi.fn(),
  withProspectingLock: vi.fn(),
}));

import { POST } from "@/app/api/v1/prospecting/route";

const ORG_A = "11111111-1111-4111-8111-111111111111";
const ORG_B = "22222222-2222-4222-8222-222222222222";

function request(body: unknown) {
  return new Request("http://localhost/api/v1/prospecting", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.requireSupportWrite.mockResolvedValue(null);
  mocks.requireRole.mockResolvedValue({
    ok: true,
    user: { id: "actor-a" },
    org: { orgId: ORG_A },
  });
  mocks.audit.mockResolvedValue(undefined);
  mocks.updateProvider.mockResolvedValue(undefined);
  mocks.configureCredential.mockResolvedValue(undefined);
  mocks.removeCredential.mockResolvedValue(undefined);
});

describe("POST /api/v1/prospecting provider boundary", () => {
  it("uses the authenticated organization when persisting a provider selection", async () => {
    const response = await POST(request({ action: "select_provider", provider: "apify" }));
    expect(response.status).toBe(200);
    expect(mocks.updateProvider).toHaveBeenCalledWith(mocks.pool, ORG_A, "apify");
    expect(mocks.audit).toHaveBeenCalledWith(
      expect.objectContaining({
        organizationId: ORG_A,
        actorUserId: "actor-a",
        metadata: { operation: "select_provider" },
      }),
    );
  });

  it.each([
    { action: "select_provider", provider: "google" },
    { action: "select_provider", provider: "apify", organization_id: ORG_B },
  ])("rejects unknown providers or tenant-controlled selection payloads: %j", async (body) => {
    const response = await POST(request(body));
    expect(response.status).toBe(422);
    expect(mocks.updateProvider).not.toHaveBeenCalled();
    expect(mocks.audit).not.toHaveBeenCalled();
  });

  it("keeps configured credential out of response, audit, and caller-supplied tenant scope", async () => {
    const token = "synthetic-apify-secret-token";
    const response = await POST(request({ action: "configure", api_key: token }));
    expect(response.status).toBe(200);
    expect(mocks.configureCredential).toHaveBeenCalledWith(mocks.pool, {}, ORG_A, token);
    expect(await response.text()).not.toContain(token);
    expect(JSON.stringify(mocks.audit.mock.calls)).not.toContain(token);

    const crossTenant = await POST(
      request({ action: "configure", api_key: token, organization_id: ORG_B }),
    );
    expect(crossTenant.status).toBe(422);
    expect(mocks.configureCredential).toHaveBeenCalledTimes(1);
  });

  it("removes the credential using the session organization only", async () => {
    const response = await POST(request({ action: "remove_credential" }));
    expect(response.status).toBe(200);
    expect(mocks.removeCredential).toHaveBeenCalledWith(mocks.pool, ORG_A);
  });
});
