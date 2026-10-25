import { beforeEach, describe, expect, it, vi } from "vitest";

const deps = vi.hoisted(() => ({
  serviceRoleConfigured: vi.fn(),
  createAdminClient: vi.fn(),
}));

vi.mock("@/lib/audit", () => ({ isServiceRoleConfigured: deps.serviceRoleConfigured }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: deps.createAdminClient }));

import { validarResponsavelDaTarefa, nomesDosResponsaveisDaTarefa } from "./responsaveis";

const ORG_A = "22222222-2222-4222-8222-222222222222";
const ORG_B = "33333333-3333-4333-8333-333333333333";
const USUARIO_ATOR = "11111111-1111-4111-8111-111111111111";
const USUARIO_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const USUARIO_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

function queryDaMembership(resultado: { data: unknown; error: unknown }) {
  const query = {
    select: vi.fn().mockReturnThis(),
    eq: vi.fn().mockReturnThis(),
    in: vi.fn().mockReturnThis(),
    is: vi.fn().mockReturnThis(),
    maybeSingle: vi.fn().mockResolvedValue(resultado),
    then: (resolve: (value: unknown) => unknown, reject?: (reason: unknown) => unknown) =>
      Promise.resolve(resultado).then(resolve, reject),
  };
  return query;
}

beforeEach(() => {
  vi.clearAllMocks();
  deps.serviceRoleConfigured.mockReturnValue(true);
});

describe("responsável de tarefa", () => {
  it("reconhece o próprio usuário pela sessão, sem confiar em ID de cliente", async () => {
    deps.serviceRoleConfigured.mockReturnValue(false);

    await expect(validarResponsavelDaTarefa(ORG_A, USUARIO_ATOR, USUARIO_ATOR)).resolves.toBe("valido");
    expect(deps.createAdminClient).not.toHaveBeenCalled();
  });

  it("valida outro responsável com membership ativa da organização confiável", async () => {
    const query = queryDaMembership({ data: { user_id: USUARIO_A }, error: null });
    deps.createAdminClient.mockReturnValue({ from: vi.fn(() => query) });

    await expect(validarResponsavelDaTarefa(ORG_A, USUARIO_A, USUARIO_ATOR)).resolves.toBe("valido");
    expect(query.eq).toHaveBeenCalledWith("organization_id", ORG_A);
    expect(query.eq).toHaveBeenCalledWith("user_id", USUARIO_A);
    expect(query.is).toHaveBeenCalledWith("revoked_at", null);
    expect(query.eq).not.toHaveBeenCalledWith("organization_id", ORG_B);
  });

  it("nega usuário sem membership ativa, inclusive de outro tenant", async () => {
    const query = queryDaMembership({ data: null, error: null });
    deps.createAdminClient.mockReturnValue({ from: vi.fn(() => query) });

    await expect(validarResponsavelDaTarefa(ORG_A, USUARIO_B, USUARIO_ATOR)).resolves.toBe(
      "membro_inexistente",
    );
    expect(query.eq).toHaveBeenCalledWith("organization_id", ORG_A);
    expect(query.eq).toHaveBeenCalledWith("user_id", USUARIO_B);
  });

  it("falha fechada se não consegue consultar membership de terceiros", async () => {
    deps.serviceRoleConfigured.mockReturnValue(false);

    await expect(validarResponsavelDaTarefa(ORG_A, USUARIO_A, USUARIO_ATOR)).resolves.toBe(
      "indisponivel",
    );
  });

  it("só devolve nome de usuário ativo do tenant e nunca devolve email ou ID de outro tenant", async () => {
    const query = queryDaMembership({ data: [{ user_id: USUARIO_A }], error: null });
    const getUserById = vi.fn(async () => ({
      data: { user: { user_metadata: { full_name: "Ana Equipe" }, email: "privado@example.com" } },
    }));
    deps.createAdminClient.mockReturnValue({
      from: vi.fn(() => query),
      auth: { admin: { getUserById } },
    });

    const nomes = await nomesDosResponsaveisDaTarefa(ORG_A, [USUARIO_A, USUARIO_B, null], {
      id: USUARIO_ATOR,
      fullName: "Rafael",
    });

    expect(query.eq).toHaveBeenCalledWith("organization_id", ORG_A);
    expect(query.in).toHaveBeenCalledWith("user_id", [USUARIO_A, USUARIO_B]);
    expect(query.is).toHaveBeenCalledWith("revoked_at", null);
    expect(getUserById).toHaveBeenCalledTimes(1);
    expect(nomes).toEqual(new Map([[USUARIO_A, "Ana Equipe"]]));
  });
});
