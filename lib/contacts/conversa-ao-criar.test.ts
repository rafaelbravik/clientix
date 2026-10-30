import { afterEach, describe, expect, it, vi } from "vitest";

import { PROVIDERS_DE_MENSAGEM, PROVIDERS_DE_TELEFONE } from "@/lib/channels/capabilities";
import { logger } from "@/lib/logger";
import {
  abrirConversaDoContatoNovo,
  abreConversaAoCriar,
  type PortaDaCriacao,
} from "./conversa-ao-criar";

const ORG = "11111111-1111-4111-8111-111111111111";
const OUTRA_ORG = "22222222-2222-4222-8222-222222222222";
const CONTATO = "33333333-3333-4333-8333-333333333333";
const CONVERSA = "44444444-4444-4444-8444-444444444444";
const TELEFONE = "+5511999998888";
type Linha = Record<string, unknown>;

const PROVIDER_SOCIAL = PROVIDERS_DE_MENSAGEM.find(
  (provider) => !(PROVIDERS_DE_TELEFONE as readonly string[]).includes(provider),
)!;

function bancoDeMentira(
  sessoes: Linha[],
  options: { erroDaRpc?: unknown; erroDaSessao?: { code?: string; message?: string } } = {},
) {
  const leituras: string[] = [];
  const consultas: Array<{ filtros: Array<[string, string, unknown]> }> = [];
  const rpcs: Array<{ nome: string; args: Record<string, unknown> }> = [];
  const from = (tabela: string) => {
    leituras.push(tabela);
    let atual = [...sessoes];
    let maximo: number | null = null;
    const filtros: Array<[string, string, unknown]> = [];
    const query = {
      select: () => query,
      eq: (coluna: string, valor: unknown) => {
        filtros.push(["eq", coluna, valor]);
        atual = atual.filter((linha) => linha[coluna] === valor);
        return query;
      },
      is: (coluna: string, valor: unknown) => {
        filtros.push(["is", coluna, valor]);
        atual = atual.filter((linha) => (linha[coluna] ?? null) === valor);
        return query;
      },
      in: (coluna: string, valores: unknown[]) => {
        filtros.push(["in", coluna, valores]);
        atual = atual.filter((linha) => valores.includes(linha[coluna]));
        return query;
      },
      order: (coluna: string) => {
        atual.sort((a, b) => String(a[coluna] ?? "").localeCompare(String(b[coluna] ?? "")));
        return query;
      },
      limit: (valor: number) => {
        maximo = valor;
        return query;
      },
      then: (resolve: (result: { data: Linha[] | null; error: unknown }) => unknown) => {
        consultas.push({ filtros });
        const erro = tabela === "channel_sessions" ? options.erroDaSessao ?? null : null;
        return resolve({ data: erro ? null : maximo === null ? atual : atual.slice(0, maximo), error: erro });
      },
    };
    return query;
  };
  const rpc = async (nome: string, args: Record<string, unknown> = {}) => {
    rpcs.push({ nome, args });
    if (nome === "fn_service_begin" && options.erroDaRpc) return { data: null, error: options.erroDaRpc };
    if (nome !== "fn_service_begin") return { data: null, error: null };
    return {
      data: {
        organization_id: ORG,
        contact_id: CONTATO,
        conversation_id: CONVERSA,
        service_revision: 1,
        demanda_id: null,
        demanda_revision: null,
        status: "open",
        demanda_fechada_em: null,
      },
      error: null,
    };
  };
  return { db: { from, rpc } as never, from, leituras, consultas, rpcs };
}

const sessaoTelefone: Linha = {
  id: "sessao-telefone",
  organization_id: ORG,
  provider: PROVIDERS_DE_TELEFONE[0],
  status: "WORKING",
  archived_at: null,
  created_at: "2026-03-01T00:00:00Z",
};
const sessaoSocial: Linha = {
  id: "sessao-social",
  organization_id: ORG,
  provider: PROVIDER_SOCIAL,
  status: "WORKING",
  archived_at: null,
  created_at: "2025-01-01T00:00:00Z",
};

function abrir(porta: PortaDaCriacao, db: ReturnType<typeof bancoDeMentira>, phoneNumber: string | null = TELEFONE) {
  return abrirConversaDoContatoNovo(db.db, {
    porta,
    organizationId: ORG,
    contactId: CONTATO,
    phoneNumber,
    requestId: "req-wave-8q",
  });
}

afterEach(() => vi.restoreAllMocks());

describe("regra central de abertura de conversa de contato novo", () => {
  it("manual abre; CSV e prospecção mantêm seus fluxos separados", () => {
    expect(abreConversaAoCriar("manual")).toBe(true);
    expect(abreConversaAoCriar("importacao_csv")).toBe(false);
    expect(abreConversaAoCriar("prospeccao")).toBe(false);
  });

  it("CSV retorna antes de qualquer leitura ou RPC", async () => {
    const db = bancoDeMentira([sessaoTelefone]);
    expect(await abrir("importacao_csv", db)).toEqual({ aberta: false, motivo: "porta_nao_abre" });
    expect(db.leituras).toEqual([]);
    expect(db.rpcs).toEqual([]);
  });

  it("prospecção não abre pelo handler genérico nem consulta sessões", async () => {
    const db = bancoDeMentira([sessaoTelefone]);
    expect(await abrir("prospeccao", db)).toEqual({ aberta: false, motivo: "fluxo_proprio" });
    expect(db.leituras).toEqual([]);
    expect(db.rpcs).toEqual([]);
  });

  it("contato manual sem telefone não consulta sessões nem abre conversa", async () => {
    const db = bancoDeMentira([sessaoTelefone]);
    expect(await abrir("manual", db, null)).toEqual({ aberta: false, motivo: "sem_telefone" });
    expect(db.leituras).toEqual([]);
    expect(db.rpcs).toEqual([]);
  });

  it("prefere telefone à sessão social mais antiga e mantém isolamento/status/archive", async () => {
    const db = bancoDeMentira([
      sessaoSocial,
      sessaoTelefone,
      { ...sessaoTelefone, id: "outro-tenant", organization_id: OUTRA_ORG, created_at: "2020-01-01" },
      { ...sessaoTelefone, id: "arquivada", archived_at: "2026-01-01", created_at: "2021-01-01" },
      { ...sessaoTelefone, id: "parada", status: "STOPPED", created_at: "2022-01-01" },
    ]);

    expect(await abrir("manual", db)).toEqual({ aberta: true, conversationId: CONVERSA });
    expect(db.rpcs).toEqual([{
      nome: "fn_service_begin",
      args: { p_org: ORG, p_contact: CONTATO, p_session: "sessao-telefone" },
    }]);
    const sessionQuery = db.consultas[0]?.filtros ?? [];
    expect(sessionQuery).toContainEqual(["eq", "organization_id", ORG]);
    expect(sessionQuery).toContainEqual(["eq", "status", "WORKING"]);
    expect(sessionQuery).toContainEqual(["is", "archived_at", null]);
    expect(sessionQuery.some(([op, column, value]) => op === "in" && column === "provider" && (value as unknown[]).includes(PROVIDERS_DE_TELEFONE[0]))).toBe(true);
  });

  it("sem sessão adequada não chama fn_service_begin", async () => {
    const db = bancoDeMentira([
      { ...sessaoTelefone, id: "arquivada", archived_at: "2026-01-01" },
      { ...sessaoTelefone, id: "outro-tenant", organization_id: OUTRA_ORG },
    ]);
    expect(await abrir("manual", db)).toEqual({ aberta: false, motivo: "sem_sessao" });
    expect(db.rpcs).toEqual([]);
  });

  it("falha da RPC é best-effort, extrai error.message e não registra telefone", async () => {
    const aviso = vi.spyOn(logger, "warn").mockImplementation(() => undefined);
    const db = bancoDeMentira([sessaoTelefone], {
      erroDaRpc: { code: "P0002", message: `fn_service_begin falhou para ${TELEFONE}` },
    });

    expect(await abrir("manual", db)).toEqual({ aberta: false, motivo: "falhou" });
    expect(aviso).toHaveBeenCalledExactlyOnceWith(
      expect.stringContaining("a conversa não abriu"),
      expect.objectContaining({
        organization_id: ORG,
        contact_id: CONTATO,
        porta: "manual",
        request_id: "req-wave-8q",
        detail: expect.stringContaining("fn_service_begin falhou"),
      }),
    );
    expect(JSON.stringify(aviso.mock.calls[0])).not.toContain(TELEFONE);
    expect(JSON.stringify(aviso.mock.calls[0])).not.toContain("[object Object]");
  });

  it("erro da leitura de sessão também deixa warning técnico sanitizado", async () => {
    const aviso = vi.spyOn(logger, "warn").mockImplementation(() => undefined);
    const db = bancoDeMentira([], {
      erroDaSessao: { code: "08006", message: `conexão recusada para ${TELEFONE}` },
    });
    expect(await abrir("manual", db)).toEqual({ aberta: false, motivo: "falhou" });
    expect(aviso).toHaveBeenCalledOnce();
    expect(JSON.stringify(aviso.mock.calls[0])).not.toContain(TELEFONE);
    expect(JSON.stringify(aviso.mock.calls[0])).toContain("[telefone]");
  });

  it("erro desconhecido não vira [object Object] no log", async () => {
    const aviso = vi.spyOn(logger, "warn").mockImplementation(() => undefined);
    const db = bancoDeMentira([sessaoTelefone], { erroDaRpc: { code: "P0002" } });
    expect(await abrir("manual", db)).toEqual({ aberta: false, motivo: "falhou" });
    expect(JSON.stringify(aviso.mock.calls[0])).not.toContain("[object Object]");
    expect(JSON.stringify(aviso.mock.calls[0])).toContain("erro_desconhecido");
  });
});
