import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  rpc: vi.fn(),
  createUser: vi.fn(),
  deleteUser: vi.fn(),
  maybeSingle: vi.fn(),
  client: {} as Record<string, unknown>,
}));

vi.mock("@/lib/env", () => ({ env: { CLIENTIX_BOOTSTRAP_TOKEN: "a".repeat(64) } }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: () => mocks.client }));

const TOKEN = "a".repeat(64);

function payload(overrides: Record<string, unknown> = {}) {
  return {
    bootstrap_token: TOKEN,
    full_name: "Rafael Exemplo",
    email: "rafael@example.test",
    phone: "",
    password: "senha-segura-123",
    password_confirmation: "senha-segura-123",
    platform_name: "Clientix",
    ...overrides,
  };
}

function request(body: unknown = payload(), origin = "https://crm.example.test") {
  return new Request("https://crm.example.test/api/setup/initialize", {
    method: "POST",
    headers: {
      origin,
      "content-type": "application/json",
      "x-real-ip": "192.0.2.12",
      "sec-fetch-site": "same-origin",
    },
    body: JSON.stringify(body),
  });
}

function setRpcResults(...results: unknown[]) {
  mocks.rpc.mockImplementation(async (name: string) => {
    const result = results.shift();
    if (
      name === "fn_platform_initialized" ||
      name === "fn_consume_platform_setup_rate_limit" ||
      name === "fn_reserve_platform_setup" ||
      name === "fn_finalize_platform_setup" ||
      name === "fn_release_platform_setup"
    ) {
      return result ?? { data: null, error: null };
    }
    throw new Error("unexpected RPC " + name);
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.createUser.mockResolvedValue({
    data: { user: { id: "11111111-1111-4111-8111-111111111111" } },
    error: null,
  });
  mocks.deleteUser.mockResolvedValue({ error: null });
  mocks.maybeSingle.mockResolvedValue({ data: null, error: null });
  mocks.client = {
    rpc: mocks.rpc,
    auth: { admin: { createUser: mocks.createUser, deleteUser: mocks.deleteUser } },
    from: (table: string) => {
      if (table !== "platform_admins") throw new Error("unexpected table " + table);
      const builder = {
        select: () => builder,
        eq: () => builder,
        is: () => builder,
        maybeSingle: mocks.maybeSingle,
      };
      return builder;
    },
  };
});

describe("POST /api/setup/initialize", () => {
  it("creates one Auth user and finalizes the owner only after the database reservation", async () => {
    setRpcResults(
      { data: false, error: null },
      { data: true, error: null },
      { data: true, error: null },
      { data: true, error: null },
    );
    const { POST } = await import("./route");
    const response = await POST(request());
    expect(response.status).toBe(201);
    const responseBody = await response.json();
    expect(responseBody).toEqual({ data: { initialized: true } });
    expect(mocks.createUser).toHaveBeenCalledWith(
      expect.objectContaining({
        email: "rafael@example.test",
        email_confirm: true,
        user_metadata: expect.objectContaining({ full_name: "Rafael Exemplo" }),
      }),
    );
    expect(mocks.rpc.mock.calls.map(([name]) => name)).toEqual([
      "fn_platform_initialized",
      "fn_consume_platform_setup_rate_limit",
      "fn_reserve_platform_setup",
      "fn_finalize_platform_setup",
    ]);
    const body = JSON.stringify(responseBody);
    expect(body).not.toContain(TOKEN);
    expect(body).not.toContain("senha-segura-123");
  });

  it("rejects a wrong token without creating an Auth user", async () => {
    setRpcResults({ data: false, error: null }, { data: true, error: null });
    const { POST } = await import("./route");
    const response = await POST(request(payload({ bootstrap_token: "b".repeat(64) })));
    expect(response.status).toBe(403);
    expect(mocks.createUser).not.toHaveBeenCalled();
  });

  it("blocks setup after initialization before Auth or reservation calls", async () => {
    setRpcResults({ data: true, error: null });
    const { POST } = await import("./route");
    const response = await POST(request());
    expect(response.status).toBe(409);
    expect(mocks.createUser).not.toHaveBeenCalled();
    expect(mocks.rpc).toHaveBeenCalledTimes(1);
  });

  it("rate limits failed bootstrap attempts and fails closed if the limiter is unavailable", async () => {
    const { POST } = await import("./route");
    setRpcResults({ data: false, error: null }, { data: false, error: null });
    const limited = await POST(request());
    expect(limited.status).toBe(429);
    expect(mocks.createUser).not.toHaveBeenCalled();

    vi.clearAllMocks();
    mocks.client = {
      rpc: vi.fn()
        .mockResolvedValueOnce({ data: false, error: null })
        .mockResolvedValueOnce({ data: null, error: { code: "PGRST000" } }),
      auth: { admin: { createUser: mocks.createUser, deleteUser: mocks.deleteUser } },
      from: mocks.client.from,
    };
    const unavailable = await POST(request());
    expect(unavailable.status).toBe(503);
    expect(mocks.createUser).not.toHaveBeenCalled();
  });

  it("rejects cross-origin requests before touching the database", async () => {
    const { POST } = await import("./route");
    const response = await POST(request(payload(), "https://attacker.example"));
    expect(response.status).toBe(403);
    expect(mocks.rpc).not.toHaveBeenCalled();
  });

  it("compensates an Auth user when finalization fails and remains uninitialized", async () => {
    setRpcResults(
      { data: false, error: null },
      { data: true, error: null },
      { data: true, error: null },
      { data: null, error: { code: "23514" } },
      { data: false, error: null },
      { data: null, error: null },
    );
    const { POST } = await import("./route");
    const response = await POST(request());
    expect(response.status).toBe(503);
    expect(mocks.deleteUser).toHaveBeenCalledWith("11111111-1111-4111-8111-111111111111");
    expect(mocks.rpc.mock.calls.at(-1)?.[0]).toBe("fn_release_platform_setup");
  });
});
