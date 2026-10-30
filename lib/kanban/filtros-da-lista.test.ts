import { describe, expect, it } from "vitest";

import {
  filtrosDaLista,
  filtrosForaDaLista,
  lerFiltrosDaLista,
  paramsDosFiltrosDaLista,
} from "./filtros-da-lista";

const USUARIO = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const AGENTE = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

describe("filtros-da-lista", () => {
  it("recorta owner/status e mantém any/all como ausência", () => {
    expect(filtrosDaLista({ owner: "any", status: "all" })).toEqual({});
    expect(filtrosDaLista({ owner: USUARIO, status: "won" })).toEqual({
      owner: USUARIO,
      status: "won",
    });
  });

  it("gera query string determinística com owner antes de status", () => {
    const filtros = { status: "won" as const, owner: `agent:${AGENTE}` };
    expect(paramsDosFiltrosDaLista(filtros)).toBe(`owner=agent%3A${AGENTE}&status=won`);
    expect(paramsDosFiltrosDaLista({ owner: `agent:${AGENTE}`, status: "won" })).toBe(
      paramsDosFiltrosDaLista(filtros),
    );
  });

  it.each([
    [`owner=${USUARIO}`, { owner: USUARIO }],
    [`owner=agent%3A${AGENTE}`, { owner: `agent:${AGENTE}` }],
    ["owner=unassigned", { owner: "unassigned" }],
    ["owner=any", {}],
    ["status=open", { status: "open" }],
    ["status=won", { status: "won" }],
    ["status=lost", { status: "lost" }],
    ["status=all", {}],
  ])("valida %s", (query, filtros) => {
    expect(lerFiltrosDaLista(new URLSearchParams(query))).toEqual({ ok: true, filtros });
  });

  it.each([
    ["owner=vania", "owner"],
    ["owner=agent%3Axyz", "owner"],
    ["owner=", "owner"],
    [`owner=%20${USUARIO}%20`, "owner"],
    ["owner=any&owner=unassigned", "owner"],
    ["status=ganho", "status"],
    ["status=%20won%20", "status"],
    ["status=archived", "status"],
    ["status=all&status=won", "status"],
  ])("recusa valor ambíguo ou inválido %s", (query, campo) => {
    expect(lerFiltrosDaLista(new URLSearchParams(query))).toEqual({ ok: false, campo });
  });

  it("marca só os filtros que a Lista ainda não aplica", () => {
    expect(filtrosForaDaLista({ owner: USUARIO, status: "won" })).toEqual([]);
    expect(
      filtrosForaDaLista({
        search: " cliente ",
        tag: "vip",
        overdueOnly: true,
        lostReason: "sem retorno",
        lostCategory: "comercial",
      }),
    ).toEqual(["busca", "etiqueta", "atrasados", "motivo", "categoria"]);
  });
});
