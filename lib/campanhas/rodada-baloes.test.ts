import { beforeEach, describe, expect, it, vi } from "vitest";

const mundo = vi.hoisted(() => ({
  tabelas: {} as Record<string, Record<string, unknown>[]>,
  enviados: [] as string[],
  ledger: [] as Date[],
  falharCorpo: null as string | null,
  deferirEntreBaloes: false,
  decisoesPacing: 0,
}));

vi.mock("@/lib/logger", () => ({ logger: { warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() } }));
vi.mock("@/lib/organizacao/operante", () => ({ idsDeOrgsParadas: vi.fn(async () => []), OrgNaoOperanteError: class {} }));
vi.mock("@/lib/tenant/plan-limits", () => ({ checkFeatureQuota: vi.fn(async () => ({ allowed: true })) }));
vi.mock("@/lib/atendimento/origem", () => ({
  beginServiceAtOrigin: vi.fn(async () => ({ conversation_id: "conversation-1" })),
}));
vi.mock("@/lib/contacts/rotulo-do-contato", () => ({ nomeDoContato: () => "QA" }));
vi.mock("@/lib/channels/capabilities", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/channels/capabilities")>()),
  capabilitiesOf: () => ({ minIntervalMs: 0 }),
}));
vi.mock("@/lib/agent-engine/db/request-pool", () => ({ getRequestPool: () => ({}) }));
vi.mock("@/lib/agent-engine/pacing/store", () => ({
  loadChannelKnobs: vi.fn(async () => ({
    knobs: {
      throttleMs: 0,
      jitterMaxMs: 0,
      atrasoNotarMs: 0,
      msPorCaractere: 0,
      atrasoMinimoMs: 0,
      atrasoMaximoMs: 0,
      windowStartHour: 0,
      windowEndHour: 24,
      respostaStartHour: 0,
      respostaEndHour: 24,
      allowSunday: true,
      timezone: "UTC",
      warmupDailyCaps: [{ minAgeDays: 0, cap: null }],
    },
    numberActivatedAt: new Date("2020-01-01T00:00:00.000Z"),
  })),
  loadPacingState: vi.fn(async () => ({
    lastSentAt: mundo.ledger.at(-1) ?? null,
    sentToday: mundo.ledger.length,
    numberActivatedAt: new Date("2020-01-01T00:00:00.000Z"),
  })),
  recordSend: vi.fn(async (_pool: unknown, _org: string, _session: string, at: Date) => {
    mundo.ledger.push(at);
  }),
}));
vi.mock("@/lib/agent-engine/pacing/engine", () => ({
  dayStartInTz: (date: Date) => new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate())),
  decidePacing: vi.fn((input: { crmDailyLimit: number | null; state: { sentToday: number } }) => {
    mundo.decisoesPacing += 1;
    if (input.crmDailyLimit !== null && input.state.sentToday >= input.crmDailyLimit) {
      return {
        allow: false,
        code: "daily_cap",
        nextAllowedAt: new Date("2026-10-29T00:00:00.000Z"),
        reason: "daily limit",
      };
    }
    return { allow: true, waitMs: mundo.deferirEntreBaloes && mundo.decisoesPacing % 2 === 0 ? 11_000 : 0 };
  }),
}));
vi.mock("@/app/api/v1/messages/_handler", () => ({
  sendMessageHandler: vi.fn(async (_admin: unknown, contexto: Record<string, unknown>, mensagem: Record<string, unknown>) => {
    const body = String(mensagem.body);
    mundo.enviados.push(body);
    const status = body === mundo.falharCorpo ? "failed" : "sent";
    const row = {
      id: contexto.internalMessageId,
      organization_id: "org-1",
      channel_session_id: "session-1",
      direction: "outbound",
      status,
      sent_at: status === "sent" ? new Date().toISOString() : null,
      delivered_at: null,
      read_at: null,
      metadata: mensagem.metadata,
    };
    mundo.tabelas.messages!.push(row);
    return row;
  }),
}));

import { rodarUmaRodadaDeCampanha } from "./rodada";

type Linha = Record<string, unknown>;
type Criterio = (linha: Linha) => boolean;

/** Supabase em memória com CAS real para os filtros usados pela rodada. */
function adminSintetico() {
  return {
    from(tabela: string) {
      const estado: {
        acao: "select" | "update";
        patch?: Linha;
        criterios: Criterio[];
        ordenacao?: { coluna: string; ascending: boolean };
        limite?: number;
        count: boolean;
        head: boolean;
        retorna: boolean;
      } = { acao: "select", criterios: [], count: false, head: false, retorna: false };
      const builder: Record<string, (...args: never[]) => unknown> = {};
      const aplicar = (): { data: Linha[] | null; count: number | null; error: null } => {
        const linhas = mundo.tabelas[tabela] ?? [];
        let resultado = linhas.filter((linha) => estado.criterios.every((criterio) => criterio(linha)));
        if (estado.ordenacao) {
          const { coluna, ascending } = estado.ordenacao;
          resultado = [...resultado].sort((a, b) => {
            const av = a[coluna];
            const bv = b[coluna];
            const cmp = av === bv ? 0 : av == null ? -1 : bv == null ? 1 : String(av).localeCompare(String(bv));
            return ascending ? cmp : -cmp;
          });
        }
        if (estado.limite !== undefined) resultado = resultado.slice(0, estado.limite);
        if (estado.acao === "update") {
          for (const linha of resultado) Object.assign(linha, estado.patch);
          return { data: estado.retorna ? resultado.map((linha) => ({ id: linha.id })) : null, count: null, error: null };
        }
        return {
          data: estado.head ? null : resultado,
          count: estado.count ? resultado.length : null,
          error: null,
        };
      };
      Object.assign(builder, {
        select(_colunas?: string, opcoes?: { count?: string; head?: boolean }) {
          estado.retorna = estado.acao === "update";
          estado.count = opcoes?.count === "exact";
          estado.head = opcoes?.head === true;
          return builder;
        },
        update(patch: Linha) {
          estado.acao = "update";
          estado.patch = patch;
          return builder;
        },
        eq(coluna: string, valor: unknown) {
          estado.criterios.push((linha) => linha[coluna] === valor);
          return builder;
        },
        neq(coluna: string, valor: unknown) {
          estado.criterios.push((linha) => linha[coluna] !== valor);
          return builder;
        },
        in(coluna: string, valores: unknown[]) {
          estado.criterios.push((linha) => valores.includes(linha[coluna]));
          return builder;
        },
        not(coluna: string, operador: string, valor: unknown) {
          if (operador === "is" && valor === null) estado.criterios.push((linha) => linha[coluna] != null);
          if (operador === "in") {
            const proibidos = String(valor).replace(/[()]/g, "").split(",");
            estado.criterios.push((linha) => !proibidos.includes(String(linha[coluna])));
          }
          return builder;
        },
        or(expressao: string) {
          if (expressao.startsWith("next_attempt_at.is.null")) {
            const limite = expressao.match(/next_attempt_at\.lte\.([^,)]+)/)?.[1];
            estado.criterios.push((linha) =>
              linha.next_attempt_at == null || (limite !== undefined && String(linha.next_attempt_at) <= limite),
            );
          } else if (expressao.includes("split_bubble_count.eq.")) {
            estado.criterios.push((linha) => {
              const total = Number(linha.split_bubble_count);
              return (total === 2 || total === 3) && Number(linha.next_bubble_index) < total;
            });
          }
          return builder;
        },
        contains(coluna: string, valor: Linha) {
          estado.criterios.push((linha) =>
            Object.entries(valor).every(([chave, esperado]) => (linha[coluna] as Linha | undefined)?.[chave] === esperado),
          );
          return builder;
        },
        gte(coluna: string, valor: string) {
          estado.criterios.push((linha) => String(linha[coluna] ?? "") >= valor);
          return builder;
        },
        lte(coluna: string, valor: string) {
          estado.criterios.push((linha) => String(linha[coluna] ?? "") <= valor);
          return builder;
        },
        order(coluna: string, opcoes?: { ascending?: boolean }) {
          estado.ordenacao = { coluna, ascending: opcoes?.ascending !== false };
          return builder;
        },
        limit(valor: number) {
          estado.limite = valor;
          return builder;
        },
        maybeSingle() {
          const result = aplicar();
          return Promise.resolve({ ...result, data: result.data?.[0] ?? null });
        },
        single() {
          const result = aplicar();
          return Promise.resolve({ ...result, data: result.data?.[0] ?? null });
        },
        then(resolve: (value: unknown) => unknown, reject?: (reason: unknown) => unknown) {
          return Promise.resolve(aplicar()).then(resolve, reject);
        },
      });
      return builder;
    },
  } as never;
}

function preparar(options?: { split?: boolean; dailyLimit?: number; body?: string }) {
  const org = "org-1";
  const campaign = "campaign-1";
  const contact = {
    id: "contact-1",
    organization_id: org,
    name: "Contato QA",
    display_name: null,
    phone_number: "+15555550100",
    email: null,
    social_identity: null,
    is_blocked: false,
    is_anonymized: false,
    consent: {},
  };
  mundo.tabelas = {
    campaigns: [
      {
        id: campaign,
        organization_id: org,
        channel: "whatsapp",
        email_subject: null,
        channel_session_id: "session-1",
        name: "QA — campanha de balões",
        message_body: options?.body ?? "Primeiro\n\nSegundo\n\nTerceiro",
        content_version: 1,
        intervalo_segundos: null,
        janela_inicio_hora: null,
        janela_fim_hora: null,
        teto_diario: null,
        teto_horario: null,
        split_messages: options?.split ?? true,
        status: "running",
        started_at: "2026-10-28T12:00:00.000Z",
      },
    ],
    campaign_recipients: [
      {
        id: "recipient-1",
        campaign_id: campaign,
        organization_id: org,
        contact_id: contact.id,
        recipient_address: contact.phone_number,
        rendered_body: null,
        channel: "whatsapp",
        status: "pending",
        eligibility_status: "eligible",
        channel_session_id: null,
        message_id: null,
        next_attempt_at: null,
        next_bubble_index: 0,
        split_bubble_count: null,
        contacts: contact,
        created_at: "2026-10-28T12:00:00.000Z",
      },
    ],
    contacts: [contact],
    channel_sessions: [
      { id: "session-1", organization_id: org, status: "WORKING", daily_message_limit: options?.dailyLimit ?? 100 },
    ],
    campaign_channel_sessions: [],
    campaign_suppressions: [],
    conversations: [],
    messages: [],
  };
  mundo.enviados = [];
  mundo.ledger = [];
  mundo.falharCorpo = null;
  mundo.deferirEntreBaloes = false;
  mundo.decisoesPacing = 0;
  return adminSintetico();
}

describe("worker da campanha com balões", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("envia no máximo três balões em ordem e registra cada mensagem no pacing", async () => {
    const admin = preparar({ body: "Primeiro\n\nSegundo\n\nTerceiro\n\nQuarto" });

    const result = await rodarUmaRodadaDeCampanha(admin, new Date("2026-10-28T12:00:00.000Z"));

    expect(result.enviadas).toBe(3);
    expect(mundo.enviados).toEqual(["Primeiro", "Segundo", "Terceiro\n\nQuarto"]);
    expect(mundo.ledger).toHaveLength(3);
    expect(mundo.tabelas.campaign_recipients?.[0]).toMatchObject({ status: "sent", next_bubble_index: 3, split_bubble_count: 3 });
  });

  it("não inicia o destinatário se o teto diário do canal não comporta a sequência inteira", async () => {
    const admin = preparar({ dailyLimit: 2 });

    const result = await rodarUmaRodadaDeCampanha(admin, new Date("2026-10-28T12:00:00.000Z"));

    expect(result.enviadas).toBe(0);
    expect(mundo.enviados).toEqual([]);
    expect(mundo.tabelas.campaign_recipients?.[0]).toMatchObject({ status: "pending", next_bubble_index: 0 });
  });

  it("retoma do cursor persistido depois do pacing e nunca reenvia o prefixo enviado", async () => {
    const admin = preparar();
    mundo.deferirEntreBaloes = true;
    const inicio = new Date("2026-10-28T12:00:00.000Z");

    const first = await rodarUmaRodadaDeCampanha(admin, inicio);
    expect(first.enviadas).toBe(1);
    expect(mundo.tabelas.campaign_recipients?.[0]).toMatchObject({ status: "pending", next_bubble_index: 1 });

    mundo.decisoesPacing = 0;
    const second = await rodarUmaRodadaDeCampanha(admin, new Date(inicio.getTime() + 12_000));
    expect(second.enviadas).toBe(1);
    expect(mundo.tabelas.campaign_recipients?.[0]).toMatchObject({ status: "pending", next_bubble_index: 2 });

    mundo.decisoesPacing = 0;
    const third = await rodarUmaRodadaDeCampanha(admin, new Date(inicio.getTime() + 24_000));
    expect(third.enviadas).toBe(1);
    expect(mundo.enviados).toEqual(["Primeiro", "Segundo", "Terceiro"]);
    expect(mundo.tabelas.campaign_recipients?.[0]).toMatchObject({ status: "sent", next_bubble_index: 3 });
  });

  it("interrompe após falha parcial sem reenviar o primeiro balão", async () => {
    const admin = preparar();
    mundo.falharCorpo = "Segundo";

    await rodarUmaRodadaDeCampanha(admin, new Date("2026-10-28T12:00:00.000Z"));
    await rodarUmaRodadaDeCampanha(admin, new Date("2026-10-28T12:01:00.000Z"));

    expect(mundo.enviados).toEqual(["Primeiro", "Segundo"]);
    expect(mundo.tabelas.campaign_recipients?.[0]).toMatchObject({ status: "failed", next_bubble_index: 1 });
  });

  it("dois workers concorrentes só reivindicam uma vez a mesma sequência", async () => {
    const admin = preparar({ body: "Primeiro\n\nSegundo" });
    const agora = new Date("2026-10-28T12:00:00.000Z");

    await Promise.all([
      rodarUmaRodadaDeCampanha(admin, agora),
      rodarUmaRodadaDeCampanha(admin, agora),
    ]);

    expect(mundo.enviados).toEqual(["Primeiro", "Segundo"]);
    expect(mundo.ledger).toHaveLength(2);
    expect(mundo.tabelas.campaign_recipients?.[0]).toMatchObject({ status: "sent", next_bubble_index: 2 });
  });

  it("mantém o envio legado de uma mensagem quando dividir está desligado", async () => {
    const body = "  Texto original\r\n\r\ncom parágrafos  ";
    const admin = preparar({ split: false, body });

    const result = await rodarUmaRodadaDeCampanha(admin, new Date("2026-10-28T12:00:00.000Z"));

    expect(result.enviadas).toBe(1);
    expect(mundo.enviados).toEqual([body]);
    expect(mundo.ledger).toHaveLength(1);
  });
});
