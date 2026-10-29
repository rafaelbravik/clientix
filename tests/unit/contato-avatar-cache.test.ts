import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Cache do redirect da foto de perfil — GET /api/v1/contacts/{id}/avatar.
 *
 * A rota é chamada uma vez por contato COM foto a cada render da lista de
 * conversas, e cada chamada custa autenticação + resolução de tenant + SELECT
 * em `contacts` + `createSignedUrl`. Sem `Cache-Control` o browser não guarda nada
 * e a cadeia inteira se repete a cada refresh — medido em ~73ms de servidor por
 * foto, ~3s por carga numa instalação com 39 contatos com foto.
 *
 * O que se prova aqui:
 *  - o 307 carrega `Cache-Control` com `private` e um `max-age` positivo;
 *  - `max-age` é MENOR que a vida da assinatura (senão o browser reusa um
 *    redirect que aponta pra URL vencida e a foto some);
 *  - `private` está presente — a autorização é por organização autenticada
 *    pela sessão ou pelo token, e um cache compartilhado serviria o rosto de
 *    um contato a outro tenant;
 *  - o 404 de "sem foto"/anonimizado NÃO é cacheado: anonimização é irreversível
 *    por contrato e não pode ficar presa num cache que a antecede.
 *
 * O client é falsificado; o handler roda de verdade.
 */

const SIGNED_URL = "https://storage.example/assinada?token=abc";
const CONTACT_ID = "11111111-1111-4111-8111-111111111111";

let contatoRow: { avatar_storage_path: string | null; is_anonimizado: boolean } | null = null;
let contatoOrganizationId = "org-1";
let orgAtiva: { orgId: string; org_status: string } | null = { orgId: "org-1", org_status: "active" };
let erroDeAssinatura: { message: string } | null = null;
let bucketSolicitado: string | null = null;
let filtrosContato: Array<[string, unknown]> = [];

// A assinatura tipada importa: o teste do TTL lê o 2º argumento que o handler
// passou, e com `vi.fn(async () => ...)` esse índice não existe no tipo.
const createSignedUrl = vi.fn(async (_caminho: string, _ttlSegundos: number) =>
  erroDeAssinatura
    ? { data: null, error: erroDeAssinatura }
    : { data: { signedUrl: SIGNED_URL }, error: null },
);

/** Imita o query builder do PostgREST: encadeável, resolve no `maybeSingle()`. */
function chain(): Record<string, unknown> {
  const proxy: Record<string, unknown> = new Proxy(
    {},
    {
      get(_t, prop) {
        if (prop === "maybeSingle" || prop === "single") {
          return async () => {
            const filtroId = filtrosContato.find(([coluna]) => coluna === "id")?.[1];
            const filtroOrg = filtrosContato.find(([coluna]) => coluna === "organization_id")?.[1];
            const corresponde = filtroId === CONTACT_ID && filtroOrg === contatoOrganizationId;
            return {
              data: contatoRow && corresponde
                ? {
                    avatar_storage_path: contatoRow.avatar_storage_path,
                    is_anonymized: contatoRow.is_anonimizado,
                  }
                : null,
              error: null,
            };
          };
        }
        if (prop === "eq") {
          return (coluna: string, valor: unknown) => {
            filtrosContato.push([coluna, valor]);
            return proxy;
          };
        }
        return () => proxy;
      },
    },
  ) as Record<string, unknown>;
  return proxy;
}

vi.mock("@/lib/auth/server", () => ({
  mfaEmDivida: vi.fn(async () => false),
  loadAuthUser: vi.fn(async () => ({ id: "user-1" })),
  orgAtivaSemPortao: async () => orgAtiva,
}));

vi.mock("@/lib/api/auth-dual", () => ({ resolveAuthDual: vi.fn() }));

vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => ({
    from: () => ({ select: () => chain() }),
    storage: { from: (bucket: string) => {
      bucketSolicitado = bucket;
      return { createSignedUrl };
    } },
  }),
}));

const { GET } = await import("@/app/api/v1/contacts/[id]/avatar/route");
const { resolveAuthDual } = await import("@/lib/api/auth-dual");
const { loadAuthUser } = await import("@/lib/auth/server");
const { createAdminClient } = await import("@/lib/supabase/admin");

function chamar(id = CONTACT_ID, headers?: HeadersInit, query = "") {
  const req = new Request(`http://localhost/api/v1/contacts/${id}/avatar${query}`, { headers });
  return GET(req as never, { params: Promise.resolve({ id }) });
}

describe("GET /api/v1/contacts/{id}/avatar — cache do redirect", () => {
  beforeEach(() => {
    contatoRow = { avatar_storage_path: "org-1/avatars/contato-1.jpg", is_anonimizado: false };
    contatoOrganizationId = "org-1";
    orgAtiva = { orgId: "org-1", org_status: "active" };
    erroDeAssinatura = null;
    bucketSolicitado = null;
    filtrosContato = [];
    createSignedUrl.mockClear();
    vi.mocked(resolveAuthDual).mockResolvedValue({
      ok: true,
      organizationId: "org-token",
      actor: { type: "api_token", id: "token-id", role: "agent" },
      supabase: createAdminClient(),
      via: "token",
      scopes: ["contacts:read"],
      apiTokenId: "token-id",
    } as never);
  });

  it("responde 307 para a URL assinada", async () => {
    const res = await chamar();
    expect(res.status).toBe(307);
    expect(res.headers.get("Location")).toBe(SIGNED_URL);
    expect(filtrosContato).toContainEqual(["organization_id", "org-1"]);
    expect(loadAuthUser).toHaveBeenCalledOnce();
    expect(resolveAuthDual).not.toHaveBeenCalled();
  });

  it("aceita integration token pelo auth-dual com scope contacts:read", async () => {
    contatoOrganizationId = "org-token";
    const res = await chamar(CONTACT_ID, { authorization: "Bearer dsk_synthetic" });

    expect(res.status).toBe(307);
    expect(resolveAuthDual).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      role: "viewer",
      scope: "contacts:read",
      rejectMalformedAuthorizationHeader: true,
    }));
    expect(filtrosContato).toContainEqual(["organization_id", "org-token"]);
  });

  it("não permite que token de outro tenant acesse o contato", async () => {
    contatoOrganizationId = "org-1";
    const res = await chamar(CONTACT_ID, { authorization: "Bearer dsk_synthetic" });

    expect(res.status).toBe(404);
    expect(createSignedUrl).not.toHaveBeenCalled();
    expect(filtrosContato).toContainEqual(["organization_id", "org-token"]);
  });

  it("preserva o 404 da sessão ao consultar contato de outro tenant", async () => {
    contatoOrganizationId = "org-outro";
    const res = await chamar();

    expect(res.status).toBe(404);
    expect(createSignedUrl).not.toHaveBeenCalled();
    expect(filtrosContato).toContainEqual(["organization_id", "org-1"]);
  });

  it("não aceita organization_id da query como autoridade de tenant", async () => {
    contatoOrganizationId = "org-1";
    const res = await chamar(CONTACT_ID, { authorization: "Bearer dsk_synthetic" }, "?organization_id=org-1");

    expect(res.status).toBe(404);
    expect(filtrosContato).toContainEqual(["organization_id", "org-token"]);
  });

  it("rejeita Authorization inválido sem usar a sessão", async () => {
    const negado = new Response(JSON.stringify({ error: { code: "unauthenticated" } }), { status: 401 });
    vi.mocked(resolveAuthDual).mockResolvedValue({ ok: false, response: negado });

    const res = await chamar(CONTACT_ID, { authorization: "Basic opaque" });

    expect(res.status).toBe(401);
    expect(filtrosContato).toHaveLength(0);
  });

  it("manda Cache-Control — sem isso a lista refaz a rota inteira por foto a cada render", async () => {
    const res = await chamar();
    const cc = res.headers.get("Cache-Control");

    expect(cc, "o 307 precisa de Cache-Control ou o browser não guarda nada").toBeTruthy();
    expect(cc).toMatch(/max-age=\d+/);
    expect(Number(/max-age=(\d+)/.exec(cc ?? "")?.[1])).toBeGreaterThan(0);
  });

  it("marca o cache como private — a autorização é por organização autenticada", async () => {
    const res = await chamar();
    const cc = res.headers.get("Cache-Control") ?? "";

    expect(cc, "cache compartilhado serviria a foto de um tenant a outro").toContain("private");
    expect(cc).not.toContain("public");
  });

  it("expira o cache ANTES da assinatura, senão o redirect guardado aponta pra URL vencida", async () => {
    const res = await chamar();
    const maxAge = Number(/max-age=(\d+)/.exec(res.headers.get("Cache-Control") ?? "")?.[1]);

    // A vida da assinatura é o argumento passado ao createSignedUrl pelo próprio
    // handler — lido dele, não copiado, para o teste não descolar da constante.
    const ttlAssinatura = createSignedUrl.mock.calls[0]?.[1];

    expect(ttlAssinatura, "o handler precisa ter assinado a URL").toBeDefined();
    expect(ttlAssinatura).toBe(300);
    expect(maxAge).toBe(240);
    expect(maxAge).toBeLessThan(ttlAssinatura ?? 0);
  });

  it("não cacheia o 404 de contato sem foto", async () => {
    contatoRow = { avatar_storage_path: null, is_anonimizado: false };
    const res = await chamar();

    expect(res.status).toBe(404);
    expect(res.headers.get("Cache-Control") ?? "").not.toMatch(/max-age=[1-9]/);
  });

  it("não cacheia o 404 de contato anonimizado — anonimização é irreversível", async () => {
    contatoRow = { avatar_storage_path: "org-1/avatars/contato-1.jpg", is_anonimizado: true };
    const res = await chamar();

    expect(res.status).toBe(404);
    expect(res.headers.get("Cache-Control") ?? "").not.toMatch(/max-age=[1-9]/);
  });

  it("não cacheia quando a assinatura falha", async () => {
    erroDeAssinatura = { message: "storage indisponível" };
    const res = await chamar();

    expect(res.status).toBe(404);
    expect(res.headers.get("Cache-Control") ?? "").not.toMatch(/max-age=[1-9]/);
  });

  it("mantém bucket privado e não devolve o integration token", async () => {
    const token = "dsk_synthetic";
    contatoOrganizationId = "org-token";
    contatoRow = { avatar_storage_path: "org-token/avatars/contato-1.jpg", is_anonimizado: false };
    const res = await chamar(CONTACT_ID, { authorization: `Bearer ${token}` });

    expect(res.status).toBe(307);
    expect(bucketSolicitado).toBe("whatsapp-media");
    expect(res.headers.get("Location") ?? "").not.toContain(token);
    expect(await res.text()).not.toContain(token);
    expect(res.headers.get("Cache-Control")).toContain("private");
  });

  it("recusa ID que não é UUID", async () => {
    const res = await chamar("not-a-uuid");

    expect(res.status).toBe(422);
    expect(filtrosContato).toHaveLength(0);
  });
});
