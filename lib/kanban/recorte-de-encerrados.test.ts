import { describe, expect, it } from "vitest";

import {
  DIAS_MAXIMO_DO_RECORTE,
  diasDeRecorte,
  recortaEncerradosAntigos,
} from "@/lib/kanban/recorte-de-encerrados";

const AGORA = new Date("2026-10-27T12:00:00.000Z");
const DIA = 24 * 60 * 60 * 1000;
const ha = (dias: number) => new Date(AGORA.getTime() - dias * DIA).toISOString();
const lead = (id: string, over: Record<string, unknown> = {}) =>
  ({ id, status: "open", closed_at: null, ...over }) as {
    id: string;
    status: "open" | "won" | "lost";
    closed_at: string | null;
  };

describe("diasDeRecorte", () => {
  it("usa somente inteiro entre 1 e dez anos; ausência, zero e settings inválido desligam", () => {
    expect(diasDeRecorte({ ocultar_encerrados_dias: 30 })).toBe(30);
    expect(diasDeRecorte({})).toBeNull();
    expect(diasDeRecorte({ ocultar_encerrados_dias: 0 })).toBeNull();
    expect(diasDeRecorte({ ocultar_encerrados_dias: -1 })).toBeNull();
    expect(diasDeRecorte({ ocultar_encerrados_dias: 1.5 })).toBeNull();
    expect(diasDeRecorte({ ocultar_encerrados_dias: "30" })).toBeNull();
    expect(diasDeRecorte({ ocultar_encerrados_dias: DIAS_MAXIMO_DO_RECORTE + 1 })).toBeNull();
  });
});

describe("recortaEncerradosAntigos — corte de exibição do Kanban", () => {
  const leads = [
    lead("ganho-40", { status: "won", closed_at: ha(40) }),
    lead("ganho-2", { status: "won", closed_at: ha(2) }),
    lead("perdido-90", { status: "lost", closed_at: ha(90) }),
    lead("aberto-90", { status: "open", closed_at: ha(90) }),
    lead("status-desconhecido-90", { status: "archived", closed_at: ha(90) }),
    lead("sem-data", { status: "lost", closed_at: null }),
    lead("data-inválida", { status: "won", closed_at: "ontem" }),
  ];

  it("esconde ganho/perda com closed_at anterior ao corte; aberto e data ausente ficam", () => {
    expect(recortaEncerradosAntigos(leads, 30, AGORA).map((item) => item.id)).toEqual([
      "ganho-2",
      "aberto-90",
      "status-desconhecido-90",
      "sem-data",
      "data-inválida",
    ]);
  });

  it("o dia exato do corte ainda fica visível; só data mais antiga é escondida", () => {
    const noCorte = lead("no-corte", { status: "lost", closed_at: ha(30) });
    expect(recortaEncerradosAntigos([noCorte], 30, AGORA)).toEqual([noCorte]);
  });

  it("config ausente/zero preserva o conjunto e ordem; o lead pedido por link continua acessível", () => {
    expect(recortaEncerradosAntigos(leads, null, AGORA)).toEqual(leads);
    expect(recortaEncerradosAntigos(leads, 0, AGORA)).toEqual(leads);
    expect(recortaEncerradosAntigos(leads, 30, AGORA, "perdido-90").map((item) => item.id)).toContain(
      "perdido-90",
    );
  });
});
