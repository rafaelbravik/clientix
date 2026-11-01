import { afterEach, describe, expect, it, vi } from "vitest";

const secrets = vi.hoisted(() => ({
  decrypt: vi.fn(async (_admin: unknown, ciphertext: string) =>
    ciphertext === Buffer.from("cipher-a").toString("hex")
      ? "token-A"
      : ciphertext === Buffer.from("cipher-b").toString("hex")
        ? "token-B"
        : null,
  ),
  encrypt: vi.fn(async (_admin: unknown, plaintext: string) => `cipher-${plaintext}`),
}));
vi.mock("@/lib/webhooks/secrets", () => ({
  decryptWebhookSecret: secrets.decrypt,
  encryptWebhookSecret: secrets.encrypt,
}));

import {
  configureCredential,
  createSearch,
  credential,
  removeCredential,
} from "@/lib/prospecting/store";
import type { SearchInput } from "@/lib/prospecting/schema";

const search: SearchInput = {
  name: "Clínicas · São Paulo",
  niche: "clínicas",
  location: "São Paulo, SP",
  limit: 20,
  budget_usd: 1,
  enrich: true,
  avaliar_site: true,
};

function databaseFor(org: string, provider: "apify" | "local-http", cipher?: Buffer) {
  const campaign = {
    id: `campaign-${org}`,
    organization_id: org,
    request_id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    name: search.name,
    search,
    config: null,
    status: "draft",
    search_status: "starting",
    run_id: null,
    dataset_id: null,
    next_send_at: new Date("2026-10-31T12:00:00.000Z"),
    created_at: new Date("2026-10-31T12:00:00.000Z"),
    error: null,
  };
  const client = {
    query: vi.fn(async (sql: string) => {
      if (sql.includes("pg_try_advisory_lock")) return { rows: [{ locked: true }] };
      if (sql.includes("pg_advisory_unlock")) return { rows: [] };
      if (sql.includes("from prospecting_campaigns where organization_id=$1 and request_id=$2"))
        return { rows: [] };
      if (sql.includes("select settings from organizations where id=$1"))
        return { rows: [{ settings: { prospecting: { provider } } }] };
      if (
        sql.includes(
          "select credential_encrypted from prospecting_settings where organization_id=$1",
        )
      )
        return { rows: cipher ? [{ credential_encrypted: cipher }] : [] };
      if (sql.startsWith("insert into prospecting_campaigns")) return { rows: [campaign] };
      if (sql.startsWith("select * from prospecting_campaigns where organization_id=$1 and id=$2"))
        return { rows: [{ ...campaign, search_status: "running", run_id: "remote-run" }] };
      return { rows: [] };
    }),
    release: vi.fn(),
  };
  const pool = { connect: vi.fn().mockResolvedValue(client), query: vi.fn() };
  return { pool, client, campaign };
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe("prospecting provider storage and dispatch", () => {
  it("reads only the encrypted credential belonging to the requested organization", async () => {
    const a = {
      query: vi
        .fn()
        .mockResolvedValue({ rows: [{ credential_encrypted: Buffer.from("cipher-a") }] }),
    };
    const b = {
      query: vi
        .fn()
        .mockResolvedValue({ rows: [{ credential_encrypted: Buffer.from("cipher-b") }] }),
    };
    const admin = {} as never;
    const [tokenA, tokenB] = await Promise.all([
      credential(a as never, admin, "org-a"),
      credential(b as never, admin, "org-b"),
    ]);
    expect(tokenA).toBe("token-A");
    expect(tokenB).toBe("token-B");
    expect(a.query.mock.calls[0]?.[1]).toEqual(["org-a"]);
    expect(b.query.mock.calls[0]?.[1]).toEqual(["org-b"]);
  });

  it("fails before creating a campaign or sending a request when Apify credentials are absent", async () => {
    const db = databaseFor("org-a", "apify");
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    await expect(
      createSearch(
        db.pool as never,
        {} as never,
        "org-a",
        "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        search,
      ),
    ).rejects.toMatchObject({
      code: "apify_credential_missing",
      status: 409,
    });
    expect(
      db.client.query.mock.calls.some(([sql]) =>
        String(sql).startsWith("insert into prospecting_campaigns"),
      ),
    ).toBe(false);
    expect(fetch).not.toHaveBeenCalled();
    expect(db.client.release).toHaveBeenCalledOnce();
  });

  it("uses each organization's own Apify bearer during concurrent synthetic searches", async () => {
    const a = databaseFor("org-a", "apify", Buffer.from("cipher-a"));
    const b = databaseFor("org-b", "apify", Buffer.from("cipher-b"));
    const fetch = vi.fn(
      async (_input: RequestInfo | URL, _init?: RequestInit) =>
        new Response(JSON.stringify({ data: { id: "run", status: "RUNNING" } }), { status: 200 }),
    );
    vi.stubGlobal("fetch", fetch);
    const admin = {} as never;
    await Promise.all([
      createSearch(a.pool as never, admin, "org-a", "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", search),
      createSearch(b.pool as never, admin, "org-b", "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", search),
    ]);
    const authHeaders = fetch.mock.calls
      .map(([, init]) => (init?.headers as Record<string, string>).Authorization)
      .sort();
    expect(authHeaders).toEqual(["Bearer token-A", "Bearer token-B"]);
    expect(
      fetch.mock.calls.every(([url]) =>
        String(url).startsWith("https://api.apify.com/v2/acts/compass~crawler-google-places/runs?"),
      ),
    ).toBe(true);
    expect(
      fetch.mock.calls.every(
        ([url]) => !String(url).includes("token-A") && !String(url).includes("token-B"),
      ),
    ).toBe(true);
  });

  it("does not route an unavailable local-http provider to Apify or create a paid run", async () => {
    const db = databaseFor("org-a", "local-http", Buffer.from("cipher-a"));
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    await expect(
      createSearch(
        db.pool as never,
        {} as never,
        "org-a",
        "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        search,
      ),
    ).rejects.toMatchObject({ code: "local_http_unavailable" });
    expect(
      db.client.query.mock.calls.some(([sql]) =>
        String(sql).startsWith("insert into prospecting_campaigns"),
      ),
    ).toBe(false);
    expect(fetch).not.toHaveBeenCalled();
    expect(secrets.decrypt).not.toHaveBeenCalled();
  });

  it("stores only ciphertext under the authorized tenant and removes only that tenant's credential", async () => {
    const pool = { query: vi.fn().mockResolvedValue({ rows: [], rowCount: 1 }) };
    const fetch = vi.fn(
      async () => new Response(JSON.stringify({ data: { id: "user" } }), { status: 200 }),
    );
    vi.stubGlobal("fetch", fetch);
    const admin = {} as never;
    await configureCredential(pool as never, admin, "org-a", "synthetic-apify-token");
    const save = pool.query.mock.calls[0]!;
    expect(save[0]).toContain(
      "insert into prospecting_settings(organization_id,credential_encrypted)",
    );
    expect(save[1]?.[0]).toBe("org-a");
    expect(save[1]).not.toContain("synthetic-apify-token");
    expect(secrets.encrypt).toHaveBeenCalledWith(admin, "synthetic-apify-token");
    await removeCredential(pool as never, "org-a");
    expect(pool.query.mock.calls[1]).toEqual([
      "delete from prospecting_settings where organization_id=$1",
      ["org-a"],
    ]);
  });
});
