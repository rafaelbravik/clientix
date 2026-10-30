import { beforeEach, describe, expect, it, vi } from "vitest";

import type { HandlerCtx } from "@/lib/api/handlers/types";
import { createContactHandler } from "@/app/api/v1/contacts/_handler";
import { PROVIDERS_DE_MENSAGEM, PROVIDERS_DE_TELEFONE } from "@/lib/channels/capabilities";
import { logger } from "@/lib/logger";

vi.mock("@/lib/audit", () => ({ audit: vi.fn(async () => undefined) }));

const ORG = "11111111-1111-4111-8111-111111111111";
const USER = "22222222-2222-4222-8222-222222222222";
const CONTACT = "33333333-3333-4333-8333-333333333333";
const CONVERSATION = "44444444-4444-4444-8444-444444444444";
const PHONE = "+5511999998888";
type Linha = Record<string, unknown>;

const PHONE_SESSION: Linha = {
  id: "phone-session",
  organization_id: ORG,
  provider: PROVIDERS_DE_TELEFONE[0],
  status: "WORKING",
  archived_at: null,
  created_at: "2026-02-01T00:00:00Z",
};
const SOCIAL_SESSION: Linha = {
  id: "social-session",
  organization_id: ORG,
  provider: PROVIDERS_DE_MENSAGEM.find(
    (provider) => !(PROVIDERS_DE_TELEFONE as readonly string[]).includes(provider),
  ),
  status: "WORKING",
  archived_at: null,
  created_at: "2025-01-01T00:00:00Z",
};

function cliente(sessoes: Linha[], erroDaAbertura?: unknown) {
  const tabelas: string[] = [];
  const rpcs: Array<{ nome: string; args: Record<string, unknown> }> = [];
  const from = vi.fn((tabela: string) => {
    tabelas.push(tabela);
    let linhas = tabela === "channel_sessions" ? [...sessoes] : [];
    let limite: number | null = null;
    const query = {
      select: () => query,
      insert: () => query,
      eq: (coluna: string, valor: unknown) => {
        linhas = linhas.filter((linha) => linha[coluna] === valor);
        return query;
      },
      is: (coluna: string, valor: unknown) => {
        linhas = linhas.filter((linha) => (linha[coluna] ?? null) === valor);
        return query;
      },
      in: (coluna: string, valores: unknown[]) => {
        linhas = linhas.filter((linha) => valores.includes(linha[coluna]));
        return query;
      },
      order: (coluna: string) => {
        linhas.sort((a, b) => String(a[coluna] ?? "").localeCompare(String(b[coluna] ?? "")));
        return query;
      },
      limit: (n: number) => {
        limite = n;
        return query;
      },
      single: async () => ({
        data: tabela === "contacts"
          ? {
              id: CONTACT,
              organization_id: ORG,
              name: "Pessoa sintética",
              display_name: null,
              email: null,
              phone_number: PHONE,
              source: "manual",
              tags: [],
              consent: {},
              custom_fields: {},
            }
          : null,
        error: null,
      }),
      then: (resolve: (result: { data: Linha[]; error: null }) => unknown) =>
        resolve({ data: limite === null ? linhas : linhas.slice(0, limite), error: null }),
    };
    return query;
  });
  const rpc = vi.fn(async (nome: string, args: Record<string, unknown> = {}) => {
    rpcs.push({ nome, args });
    if (nome === "fn_service_begin" && erroDaAbertura) return { data: null, error: erroDaAbertura };
    if (nome !== "fn_service_begin") return { data: null, error: null };
    return {
      data: {
        organization_id: ORG,
        contact_id: CONTACT,
        conversation_id: CONVERSATION,
        service_revision: 1,
        demanda_id: null,
        demanda_revision: null,
        status: "open",
        demanda_fechada_em: null,
      },
      error: null,
    };
  });
  return { db: { from, rpc } as never, tabelas, rpcs };
}

const ctx: HandlerCtx = {
  organization_id: ORG,
  actor: { type: "user", id: USER },
  requestId: "request-8q",
};

beforeEach(() => vi.restoreAllMocks());

describe("createContactHandler — conversa best-effort por porta", () => {
  it("manual abre na sessão de telefone, preservando o evento contact.created", async () => {
    const db = cliente([SOCIAL_SESSION, PHONE_SESSION]);
    const result = await createContactHandler(db.db, ctx, {
      name: "Pessoa sintética",
      phone_number: PHONE,
      source: "manual",
    } as never, { porta: "manual" });

    expect(result.action).toBe("created");
    expect(db.rpcs.find(({ nome }) => nome === "fn_service_begin")?.args).toEqual({
      p_org: ORG,
      p_contact: CONTACT,
      p_session: PHONE_SESSION.id,
    });
    expect(db.rpcs.some(({ nome, args }) => nome === "emit_event" && args.p_event_type === "contact.created")).toBe(true);
  });

  it("falha ao abrir não desfaz contato nem bloqueia contact.created e gera log sem telefone", async () => {
    const aviso = vi.spyOn(logger, "warn").mockImplementation(() => undefined);
    const db = cliente([PHONE_SESSION], { code: "P0002", message: `falha para ${PHONE}` });
    const result = await createContactHandler(db.db, ctx, {
      name: "Pessoa sintética",
      phone_number: PHONE,
      source: "manual",
    } as never, { porta: "manual" });

    expect(result.action).toBe("created");
    expect(db.rpcs.some(({ nome, args }) => nome === "emit_event" && args.p_event_type === "contact.created")).toBe(true);
    expect(JSON.stringify(aviso.mock.calls)).not.toContain(PHONE);
  });

  it("prospecção usa o fluxo próprio e não dispara uma segunda abertura automática", async () => {
    const db = cliente([PHONE_SESSION]);
    await createContactHandler(db.db, ctx, {
      name: "Pessoa sintética",
      phone_number: PHONE,
      source: "prospecting",
    } as never, { porta: "prospeccao" });

    expect(db.tabelas).not.toContain("channel_sessions");
    expect(db.rpcs.filter(({ nome }) => nome === "fn_service_begin")).toHaveLength(0);
    expect(db.rpcs.some(({ nome, args }) => nome === "emit_event" && args.p_event_type === "contact.created")).toBe(true);
  });
});
