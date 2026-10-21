import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";

import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { sql } from "./gov-helpers";

const h = vi.hoisted(() => ({
  actorId: "",
  actorEmail: "",
  installationId: "inst_00000000-0000-4000-8000-000000000001",
  maxTenants: 3,
  rpc: vi.fn(),
}));

vi.mock("@/lib/impersonate/support", () => ({
  requireSupportWrite: vi.fn().mockResolvedValue(null),
}));

vi.mock("@/lib/auth/requirePlatformAdmin", () => ({
  requirePlatformAdminEscrita: vi.fn(async () => ({
    user: {
      id: h.actorId,
      email: h.actorEmail,
      user_metadata: { full_name: "R2 API Test" },
    },
    platformAdmin: { user_id: h.actorId, scope: "full", mfa_required: false },
  })),
  falhaDaEscritaDePlatformAdmin: vi.fn(() => new Response("forbidden", { status: 403 })),
}));

vi.mock("@/lib/licensing", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/lib/licensing")>();
  return {
    ...original,
    requireValidInstallationLicense: vi.fn().mockResolvedValue(null),
    getInstallationTenantLimit: vi.fn(async () => ({
      usable: true,
      installation_id: h.installationId,
      max_tenants: h.maxTenants,
    })),
  };
});

vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => ({ rpc: h.rpc }),
}));

vi.mock("@/lib/audit", () => ({ audit: vi.fn().mockResolvedValue(undefined) }));
vi.mock("@/lib/auth/issue-invite", () => ({ issueInvite: vi.fn() }));

const { POST } = await import("@/app/api/v1/admin/tenants/route");

function literal(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

function executarRpcNoPostgres(args: Record<string, unknown>): Promise<string> {
  const container = process.env.TEST_DB_CONTAINER;
  if (!container) throw new Error("TEST_DB_CONTAINER ausente; rode via pnpm test:db");

  const request = JSON.stringify(args.p_request);
  const statement = [
    "begin;",
    "set local role service_role;",
    "select public.fn_create_tenant_with_owner_limited(",
    `  ${literal(String(args.p_actor))}::uuid,`,
    `  ${literal(String(args.p_key))}::uuid,`,
    `  ${literal(request)}::jsonb,`,
    `  ${literal(String(args.p_hash))},`,
    `  ${literal(String(args.p_installation_id))},`,
    `  ${String(args.p_max_tenants)}::bigint`,
    ");",
    "commit;",
  ].join("\n");

  return new Promise((resolve, reject) => {
    const child = spawn(
      "docker",
      [
        "exec",
        "-i",
        container,
        "psql",
        "-X",
        "-U",
        "postgres",
        "-d",
        "postgres",
        "-v",
        "ON_ERROR_STOP=1",
        "-q",
        "-tA",
        "-f",
        "-",
      ],
      { stdio: ["pipe", "pipe", "pipe"] },
    );
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (chunk: string) => (stdout += chunk));
    child.stderr.setEncoding("utf8").on("data", (chunk: string) => (stderr += chunk));
    child.once("error", reject);
    child.once("close", (code) => {
      if (code === 0) resolve(stdout.trim());
      else reject(Object.assign(new Error("runtime RPC failed"), { stderr, code }));
    });
    child.stdin.end(statement);
  });
}

beforeEach(() => {
  h.actorId = randomUUID();
  h.actorEmail = `r2-api-${h.actorId.slice(0, 8)}@invariant.test`;
  h.maxTenants = 3;
  h.rpc.mockImplementation(async (name: string, args: Record<string, unknown>) => {
    if (name !== "fn_create_tenant_with_owner_limited") {
      return { data: null, error: { code: "42883", message: "unexpected RPC" } };
    }
    try {
      return { data: JSON.parse(await executarRpcNoPostgres(args)), error: null };
    } catch (erro) {
      const stderr = String((erro as { stderr?: unknown }).stderr ?? "");
      return {
        data: null,
        error: stderr.includes("GLOBAL_TENANT_LIMIT_REACHED")
          ? { code: "P0001", message: "GLOBAL_TENANT_LIMIT_REACHED" }
          : { code: "XX000", message: "unexpected database failure" },
      };
    }
  });
});

describe("POST /api/v1/admin/tenants respeita max_tenants sob concorrência", () => {
  it("10 requisições autenticadas deixam exatamente uma criação no limite N", async () => {
    const slugPrefix = `r2-api-${randomUUID().slice(0, 8)}`;
    sql(`
      begin;
      insert into auth.users(id, email) values ('${h.actorId}', '${h.actorEmail}');
      insert into public.platform_admins(user_id, granted_by, scope, mfa_required, reason)
        values ('${h.actorId}', '${h.actorId}', 'full', false, 'R2 API integration test');
      insert into public.organizations(slug, display_name, legal_name, created_by)
      values
        ('${slugPrefix}-a', 'Existing A', 'Existing A', '${h.actorId}'),
        ('${slugPrefix}-b', 'Existing B', 'Existing B', '${h.actorId}');
      commit;
    `);

    const tentativas = await Promise.all(
      Array.from({ length: 10 }, (_, index) => {
        const request = new NextRequest("http://localhost/api/v1/admin/tenants", {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "Idempotency-Key": randomUUID(),
          },
          body: JSON.stringify({
            display_name: `R2 tenant ${index}`,
            slug: `${slugPrefix}-${index}`,
            plan: "standard",
            owner_email: h.actorEmail,
          }),
        });
        return POST(request);
      }),
    );

    const resultados = await Promise.all(
      tentativas.map(async (response) => ({ status: response.status, body: await response.json() })),
    );
    const criadas = resultados.filter((r) => r.status === 201);
    const negadas = resultados.filter((r) => r.status === 409);

    expect(criadas).toHaveLength(1);
    expect(negadas).toHaveLength(9);
    expect(negadas.every((r) => r.body.error?.code === "GLOBAL_TENANT_LIMIT_REACHED")).toBe(true);
    expect(h.rpc).toHaveBeenCalledTimes(10);
    expect(
      Number(sql(`select count(*) from public.organizations where slug like '${slugPrefix}-%';`)),
    ).toBe(3);
    expect(
      Number(sql(`select count(*) from public.organizations where slug like '${slugPrefix}-%' and created_by = '${h.actorId}';`)),
    ).toBe(3);
  }, 60_000);
});
