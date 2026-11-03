import { beforeEach, describe, expect, it, vi } from "vitest";
import { createAdminClient } from "@/lib/supabase/admin";

vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: vi.fn() }));

describe("GET /api/setup/status", () => {
  beforeEach(() => vi.clearAllMocks());

  it("returns only the initialized bit", async () => {
    vi.mocked(createAdminClient).mockReturnValue({
      rpc: vi.fn().mockResolvedValue({ data: false, error: null }),
    } as never);
    const { GET } = await import("./route");
    const response = await GET();
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ data: { initialized: false } });
    expect(response.headers.get("cache-control")).toBe("no-store");
  });

  it("fails closed when the database cannot verify setup state", async () => {
    vi.mocked(createAdminClient).mockReturnValue({
      rpc: vi.fn().mockResolvedValue({ data: null, error: { code: "PGRST000" } }),
    } as never);
    const { GET } = await import("./route");
    const response = await GET();
    expect(response.status).toBe(503);
    expect(await response.json()).not.toHaveProperty("data");
  });
});
