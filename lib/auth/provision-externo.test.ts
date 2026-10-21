/**
 * `provisionExternalTenant`: o reencontro exige o MARCADOR, e o dono é achado
 * mesmo além da primeira página de contas.
 *
 * Slug é espaço compartilhado com o cadastro pela tela. Sem o marcador, uma
 * organização criada à mão com o slug certo viraria "replay" — e a rota
 * entregaria uma chave dela a um sistema de fora.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  org: null as Record<string, unknown> | null,
  erroDaOrg: null as { message: string } | null,
  /** Erro do INSERT da organização — a falha transitória do bloqueador 1. */
  erroDoInsertDaOrg: null as { code?: string; message: string } | null,
  membro: null as Record<string, unknown> | null,
  /** Vínculo vivo da conta candidata a órfã (null = órfã de verdade). */
  vinculoDaConta: null as Record<string, unknown> | null,
  /** Vínculo vivo do dono COM a organização reencontrada (null = replay incompleto). */
  vinculoDoDonoNaOrg: null as Record<string, unknown> | null,
  erroDoVinculo: null as { message: string } | null,
  /** Erro do INSERT em `user_organizations` — a falha transitória do 3º caso. */
  erroDoInsertDoVinculo: null as { code?: string; message: string } | null,
  filtrosDoMembro: [] as unknown[][],
  auditadas: [] as Record<string, unknown>[],
  inseridas: [] as Record<string, unknown>[],
  createUser: vi.fn(),
  listUsers: vi.fn(),
  rpc: vi.fn(),
}));

vi.mock("@/lib/audit", () => ({
  audit: (linha: Record<string, unknown>) => {
    h.auditadas.push(linha);
  },
}));
vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => ({
    auth: { admin: { createUser: h.createUser, listUsers: h.listUsers } },
    rpc: h.rpc,
    from: (tabela: string) => {
      // Filtros POR CONSULTA: as duas leituras de `user_organizations` têm
      // propósitos diferentes (o admin da org no replay; o vínculo da conta
      // candidata a órfã) e devolvem coisas diferentes. Um estado compartilhado
      // faria uma responder pela outra.
      const filtros: unknown[][] = [];
      const chain = {
        select: () => chain,
        eq: (...args: unknown[]) => {
          filtros.push(args);
          if (tabela === "user_organizations") h.filtrosDoMembro.push(args);
          return chain;
        },
        is: () => chain,
        order: () => chain,
        limit: () => chain,
        maybeSingle: async () => {
          if (tabela === "organizations") return { data: h.org, error: h.erroDaOrg };
          // Três consultas distintas em `user_organizations`, e cada uma
          // responde uma pergunta diferente. Separadas pelos FILTROS, que é o
          // que as distingue no banco:
          //   user_id + organization_id -> o replay está completo?
          //   user_id                   -> a conta recusada é órfã?
          //   organization_id + role    -> quem é o admin (findAdminMember)
          const porUsuario = filtros.some((f) => f[0] === "user_id");
          const porOrganizacao = filtros.some((f) => f[0] === "organization_id");
          if (porUsuario && porOrganizacao) {
            return { data: h.vinculoDoDonoNaOrg, error: h.erroDoVinculo };
          }
          if (porUsuario) return { data: h.vinculoDaConta, error: h.erroDoVinculo };
          return { data: h.membro, error: null };
        },
        insert: (linha: Record<string, unknown>) => {
          h.inseridas.push({ tabela, ...linha });
          return {
            select: () => ({
              single: async () =>
                h.erroDoInsertDaOrg
                  ? { data: null, error: h.erroDoInsertDaOrg }
                  : { data: { id: "org-nova" }, error: null },
            }),
            then: (ok: (v: unknown) => unknown) =>
              ok({ error: tabela === "user_organizations" ? h.erroDoInsertDoVinculo : null }),
          };
        },
      };
      return chain;
    },
  }),
}));
vi.mock("@/lib/licensing", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/licensing")>()),
  requireValidInstallationLicense: vi.fn().mockResolvedValue(null),
  getInstallationTenantLimit: vi.fn().mockResolvedValue({
    usable: true,
    installation_id: "inst_00000000-0000-4000-8000-000000000001",
    max_tenants: 4,
  }),
}));

const { provisionExternalTenant, slugDoProvisionamento, ProvisionConflictError, EmailJaTemContaError } =
  await import(
  "./provision"
);

const ENTRADA = {
  integration: "clinicfx",
  externalId: "clinica-42",
  organizationName: "Clínica Sorriso",
  ownerEmail: "Dona@Clinica.test",
  ownerName: "Dona",
};

/** O marcador que o provisionamento grava na conta que ele mesmo cria. */
const MARCADOR = { integration: "clinicfx", external_id: "clinica-42" };
const EMAIL_JA_EXISTE = {
  data: { user: null },
  error: { code: "email_exists", status: 422, message: "email exists" },
};

beforeEach(() => {
  vi.clearAllMocks();
  h.org = null;
  h.erroDaOrg = null;
  h.erroDoInsertDaOrg = null;
  h.membro = null;
  h.vinculoDaConta = null;
  // Default do replay: estado ÍNTEGRO (o dono já é admin vivo da org). Assim,
  // todo teste de replay que não diz o contrário exercita o caminho normal.
  h.vinculoDoDonoNaOrg = { organization_id: "org-1", role: "admin" };
  h.erroDoVinculo = null;
  h.erroDoInsertDoVinculo = null;
  h.filtrosDoMembro = [];
  h.auditadas = [];
  h.inseridas = [];
  h.createUser.mockResolvedValue({ data: { user: { id: "user-novo" } }, error: null });
  h.listUsers.mockResolvedValue({ data: { users: [] }, error: null });
  h.rpc.mockImplementation(async (_name: string, args: Record<string, unknown>) => ({
    data: {
      organization_id: "org-nova",
      owner_id: String(args.p_owner),
      created: true,
    },
    error: h.erroDoInsertDaOrg ?? h.erroDoInsertDoVinculo,
  }));
});

describe("o reencontro exige o marcador", () => {
  it("organização com o slug e o marcador certo é replay", async () => {
    h.org = {
      id: "org-1",
      created_by: "user-1",
      settings: { provisioning: { integration: "clinicfx", external_id: "clinica-42" } },
    };
    expect(await provisionExternalTenant(ENTRADA)).toEqual({
      organizationId: "org-1",
      ownerId: "user-1",
      replay: true,
    });
    expect(h.createUser).not.toHaveBeenCalled();
  });

  it("organização com o slug e SEM o marcador é conflito, não replay", async () => {
    h.org = { id: "org-alheia", created_by: "user-x", settings: {} };
    await expect(provisionExternalTenant(ENTRADA)).rejects.toBeInstanceOf(ProvisionConflictError);
  });

  it("marcador de outro id externo também é conflito", async () => {
    h.org = {
      id: "org-1",
      created_by: "user-1",
      settings: { provisioning: { integration: "clinicfx", external_id: "outra" } },
    };
    await expect(provisionExternalTenant(ENTRADA)).rejects.toBeInstanceOf(ProvisionConflictError);
  });

  it("organização nova grava o marcador que o reencontro vai conferir", async () => {
    await provisionExternalTenant(ENTRADA);
    expect(h.rpc).toHaveBeenCalledWith("fn_provision_external_tenant_limited", expect.objectContaining({
      p_slug: slugDoProvisionamento("clinicfx", "clinica-42"),
      p_integration: "clinicfx",
      p_external_id: "clinica-42",
      p_installation_id: "inst_00000000-0000-4000-8000-000000000001",
      p_max_tenants: 4,
    }));
    expect(h.inseridas).toEqual([]);
  });

  it("ids externos diferentes nunca dividem o slug, nem os longos de prefixo igual", () => {
    const longo = "x".repeat(40);
    expect(slugDoProvisionamento("clinicfx", `${longo}-1`)).not.toBe(
      slugDoProvisionamento("clinicfx", `${longo}-2`),
    );
  });
});

describe("o que a revisão de segurança pediu", () => {
  it("falha na busca da organização não vira 'não existe'", async () => {
    h.erroDaOrg = { message: "PostgREST fora" };
    await expect(provisionExternalTenant(ENTRADA)).rejects.toThrow(/busca da organização falhou/);
    expect(h.createUser).not.toHaveBeenCalled();
  });

  it("o replay sem created_by procura um ADMIN, não o primeiro vínculo qualquer", async () => {
    h.org = {
      id: "org-1",
      created_by: null,
      settings: { provisioning: { integration: "clinicfx", external_id: "clinica-42" } },
    };
    h.membro = { user_id: "admin-1" };
    const r = await provisionExternalTenant(ENTRADA);
    expect(r.ownerId).toBe("admin-1");
    expect(h.filtrosDoMembro).toContainEqual(["role", "admin"]);
  });

  it("a auditoria da criação credita a máquina e leva o requestId", async () => {
    await provisionExternalTenant({ ...ENTRADA, requestId: "req-9" });
    const criada = h.auditadas.find((a) => a.action === "tenant.created_by_provisioning");
    expect(criada?.actorUserId).toBeNull();
    expect(criada?.requestId).toBe("req-9");
    expect((criada?.metadata as { owner_user_id: string }).owner_user_id).toBe("user-novo");
  });
});

describe("o dono", () => {
  it("e-mail novo: cria a conta, sem varrer a lista", async () => {
    const r = await provisionExternalTenant(ENTRADA);
    expect(r.ownerId).toBe("user-novo");
    expect(h.createUser).toHaveBeenCalledWith(expect.objectContaining({ email: "dona@clinica.test" }));
    expect(h.listUsers).not.toHaveBeenCalled();
  });

  // ⚠️ CONTROLE NEGATIVO do conserto do retry (abaixo). Sem ele, "a repetição
  // reaproveita a conta órfã" pode ter virado "aceita qualquer e-mail que já
  // existe" — que é exatamente a recusa do item 8 desfeita.
  it("e-mail de PESSOA REAL que já tem conta é RECUSADO, e nada é criado (decisão do dono, 19/09)", async () => {
    // Reaproveitar fazia de uma pessoa que já usa a instalação admin de uma
    // empresa nova, sem aceite, com o nome escolhido por um sistema de fora.
    h.createUser.mockResolvedValue(EMAIL_JA_EXISTE);
    // A conta existe no diretório e é de gente: nenhum marcador de
    // provisionamento em `app_metadata`.
    h.listUsers.mockResolvedValue({
      data: { users: [{ id: "pessoa-1", email: "dona@clinica.test", app_metadata: {} }] },
      error: null,
    });

    await expect(provisionExternalTenant(ENTRADA)).rejects.toBeInstanceOf(EmailJaTemContaError);
    expect(h.inseridas).toEqual([]);
  });

  it("a forma antiga do GoTrue (422 'already registered') também é recusa", async () => {
    h.createUser.mockResolvedValue({
      data: { user: null },
      error: { status: 422, message: "A user with this email address has already been registered" },
    });
    await expect(provisionExternalTenant(ENTRADA)).rejects.toBeInstanceOf(EmailJaTemContaError);
    expect(h.inseridas).toEqual([]);
  });

  it("erro que não é 'e-mail já existe' não vira recusa: falha", async () => {
    h.createUser.mockResolvedValue({
      data: { user: null },
      error: { code: "unexpected_failure", status: 500, message: "boom" },
    });
    await expect(provisionExternalTenant(ENTRADA)).rejects.toThrow(/criar dono falhou/);
    expect(h.listUsers).not.toHaveBeenCalled();
  });

  it("a conta criada leva o marcador em app_metadata, que é a prova do retry", async () => {
    await provisionExternalTenant(ENTRADA);
    expect(h.createUser).toHaveBeenCalledWith(
      expect.objectContaining({ app_metadata: { provisioning: MARCADOR } }),
    );
  });
});

/**
 * BLOQUEADOR 1: falha transitória entre a conta e a organização.
 *
 * A conta do dono nasce ANTES da organização e as duas escritas não são uma
 * transação. INSERT da organização morrendo com qualquer coisa que não seja
 * `23505` devolve 500 com a conta já criada — e a repetição do parceiro, que é
 * o caminho normal depois de um 500, batia em 409 `owner_email_ja_tem_conta`
 * para sempre, mandando "convide a pessoa pela tela da empresa" sobre uma
 * empresa que não existe.
 */
describe("a repetição depois de uma falha transitória PROVISIONA", () => {
  it("timeout do pooler no INSERT da organização → retry provisiona a mesma conta", async () => {
    // --- 1ª chamada: a conta nasce, a organização morre no pooler.
    h.erroDoInsertDaOrg = { code: "57014", message: "canceling statement due to statement timeout" };
    await expect(provisionExternalTenant(ENTRADA)).rejects.toThrow(/org insert failed/);
    const contaCriada = h.createUser.mock.calls[0]![0] as { app_metadata: unknown };
    expect(contaCriada.app_metadata).toEqual({ provisioning: MARCADOR });

    // --- 2ª chamada (retry do parceiro): o GoTrue recusa o e-mail, porque a
    // conta da 1ª chamada ficou lá. Ela está no diretório, com o marcador
    // DESTE provisionamento e sem vínculo nenhum.
    h.erroDoInsertDaOrg = null;
    h.inseridas = [];
    h.createUser.mockResolvedValue(EMAIL_JA_EXISTE);
    h.listUsers.mockResolvedValue({
      data: {
        users: [
          { id: "outra-pessoa", email: "alguem@outra.test", app_metadata: {} },
          {
            id: "user-orfao",
            email: "dona@clinica.test",
            app_metadata: { provisioning: MARCADOR },
          },
        ],
      },
      error: null,
    });
    h.vinculoDaConta = null;

    const r = await provisionExternalTenant(ENTRADA);

    expect(r).toEqual({ organizationId: "org-nova", ownerId: "user-orfao", replay: false });
    expect(h.rpc).toHaveBeenCalledWith("fn_provision_external_tenant_limited", expect.objectContaining({
      p_owner: "user-orfao",
      p_slug: slugDoProvisionamento("clinicfx", "clinica-42"),
    }));
  });

  it("marcador de OUTRO provisionamento não é órfã desta: recusa", async () => {
    h.createUser.mockResolvedValue(EMAIL_JA_EXISTE);
    h.listUsers.mockResolvedValue({
      data: {
        users: [
          {
            id: "user-de-outra",
            email: "dona@clinica.test",
            app_metadata: { provisioning: { integration: "clinicfx", external_id: "outra" } },
          },
        ],
      },
      error: null,
    });
    await expect(provisionExternalTenant(ENTRADA)).rejects.toBeInstanceOf(EmailJaTemContaError);
    expect(h.inseridas).toEqual([]);
  });

  it("conta com marcador MAS com vínculo vivo não é órfã: recusa", async () => {
    h.createUser.mockResolvedValue(EMAIL_JA_EXISTE);
    h.listUsers.mockResolvedValue({
      data: { users: [{ id: "user-com-org", email: "dona@clinica.test", app_metadata: { provisioning: MARCADOR } }] },
      error: null,
    });
    h.vinculoDaConta = { organization_id: "org-de-alguem" };

    await expect(provisionExternalTenant(ENTRADA)).rejects.toBeInstanceOf(EmailJaTemContaError);
    expect(h.inseridas).toEqual([]);
  });

  it("erro na varredura do diretório NÃO vira recusa terminal de 409", async () => {
    h.createUser.mockResolvedValue(EMAIL_JA_EXISTE);
    h.listUsers.mockResolvedValue({ data: { users: [] }, error: { message: "GoTrue 504" } });

    const erro = await provisionExternalTenant(ENTRADA).catch((e: unknown) => e);
    expect(erro).not.toBeInstanceOf(EmailJaTemContaError);
    expect(erro).toMatchObject({ message: expect.stringMatching(/busca da conta do dono falhou/) });
  });

  it("erro na busca do vínculo NÃO vira recusa terminal de 409", async () => {
    h.createUser.mockResolvedValue(EMAIL_JA_EXISTE);
    h.listUsers.mockResolvedValue({
      data: { users: [{ id: "user-orfao", email: "dona@clinica.test", app_metadata: { provisioning: MARCADOR } }] },
      error: null,
    });
    h.erroDoVinculo = { message: "PostgREST fora" };

    const erro = await provisionExternalTenant(ENTRADA).catch((e: unknown) => e);
    expect(erro).not.toBeInstanceOf(EmailJaTemContaError);
    expect(erro).toMatchObject({ message: expect.stringMatching(/busca do vínculo do dono falhou/) });
  });
});

/**
 * Repara um registro incompleto legado. A RPC atual cria organização e vínculo
 * na mesma transação; a recuperação abaixo existe para instalações que já
 * possam carregar a linha parcial de uma versão anterior.
 */
describe("o replay repara um estado incompleto legado", () => {
  const ORG_ENCONTRADA = {
    id: "org-1",
    created_by: "user-1",
    settings: { provisioning: MARCADOR },
  };

  it("organização existente sem vínculo vivo recebe vínculo admin na repetição", async () => {
    h.org = ORG_ENCONTRADA;
    h.vinculoDoDonoNaOrg = null;

    const r = await provisionExternalTenant(ENTRADA);

    expect(r).toEqual({ organizationId: "org-1", ownerId: "user-1", replay: true });
    // O que faltava foi GRAVADO -- e como admin.
    expect(h.inseridas).toContainEqual(
      expect.objectContaining({
        tabela: "user_organizations",
        user_id: "user-1",
        organization_id: "org-1",
        role: "admin",
      }),
    );
    // E o conserto deixou rastro.
    const linha = h.auditadas.find((a) => a.action === "tenant.provisioning_completed");
    expect(linha?.actorUserId).toBeNull();
    expect((linha?.metadata as { owner_user_id: string }).owner_user_id).toBe("user-1");
  });

  // ⚠️ CONTROLE do conserto acima: sem ele, "completa o que falta" pode ter
  // virado "sempre reinsere", que e outro defeito -- escrita a cada replay.
  it("replay INTEGRO devolve replay sem refazer nada", async () => {
    h.org = ORG_ENCONTRADA;
    h.vinculoDoDonoNaOrg = { organization_id: "org-1", role: "admin" };

    const r = await provisionExternalTenant(ENTRADA);

    expect(r).toEqual({ organizationId: "org-1", ownerId: "user-1", replay: true });
    expect(h.inseridas).toEqual([]);
    expect(h.auditadas).toEqual([]);
  });

  it("vinculo REVOGADO por uma pessoa nao e ressuscitado pelo sistema de fora", async () => {
    // `unique (user_id, organization_id)` (baseline.sql:2441): a linha existe,
    // revogada, entao o INSERT volta 23505 e nada muda. O replay conclui, e o
    // acesso que o administrador da empresa tirou continua tirado.
    h.org = ORG_ENCONTRADA;
    h.vinculoDoDonoNaOrg = null;
    h.erroDoInsertDoVinculo = { code: "23505", message: "duplicate key value" };

    const r = await provisionExternalTenant(ENTRADA);

    expect(r.replay).toBe(true);
    // Nada mudou -> nada a auditar.
    expect(h.auditadas).toEqual([]);
  });

  it("falha ao completar o vinculo NAO vira replay bem-sucedido", async () => {
    h.org = ORG_ENCONTRADA;
    h.vinculoDoDonoNaOrg = null;
    h.erroDoInsertDoVinculo = { code: "57014", message: "timeout do pooler" };

    await expect(provisionExternalTenant(ENTRADA)).rejects.toThrow(
      /completar o vínculo do dono falhou/,
    );
    expect(h.auditadas).toEqual([]);
  });

  it("erro ao LER o vinculo nao vira 'esta completo' nem 'falta vinculo'", async () => {
    h.org = ORG_ENCONTRADA;
    h.erroDoVinculo = { message: "PostgREST fora" };

    await expect(provisionExternalTenant(ENTRADA)).rejects.toThrow(
      /busca do vínculo do dono falhou/,
    );
    expect(h.inseridas).toEqual([]);
  });
});
