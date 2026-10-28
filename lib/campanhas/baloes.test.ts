import { describe, expect, it, vi } from "vitest";

import {
  chaveDaBolha,
  enviarBaloesEmSequencia,
  idDaMensagemDaBolha,
  separarMensagemDeCampanha,
} from "./baloes";

describe("balões de campanha", () => {
  it("mantém o corpo byte a byte quando desligado e nunca divide outro canal", () => {
    const body = "  Olá.\r\n\r\nTudo bem?  ";
    expect(separarMensagemDeCampanha(body, false, "whatsapp")).toEqual([body]);
    expect(separarMensagemDeCampanha(body, true, "telegram")).toEqual([body]);
    expect(separarMensagemDeCampanha(body, true, "email")).toEqual([body]);
  });

  it("usa o splitter canônico para parágrafos, preserva ordem e une excedente na terceira bolha", () => {
    expect(separarMensagemDeCampanha("um", true, "whatsapp")).toEqual(["um"]);
    expect(separarMensagemDeCampanha("um\n\ndois", true, "whatsapp")).toEqual(["um", "dois"]);
    const body = "um\n\ndois\n\ntres\n\nquatro";
    const baloes = separarMensagemDeCampanha(body, true, "whatsapp");
    expect(baloes).toEqual(["um", "dois", "tres\n\nquatro"]);
    expect(baloes).toHaveLength(3);
    expect(baloes.join("\n\n")).toBe(body);
  });

  it("gera identidade estável por campanha, destinatário e índice", () => {
    expect(idDaMensagemDaBolha("c", "r", 0)).toBe(idDaMensagemDaBolha("c", "r", 0));
    expect(idDaMensagemDaBolha("c", "r", 0)).not.toBe(idDaMensagemDaBolha("c", "r", 1));
    expect(idDaMensagemDaBolha("c", "r", 0)).not.toBe(idDaMensagemDaBolha("c2", "r", 0));
    expect(idDaMensagemDaBolha("c", "r", 0)).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
    expect(chaveDaBolha("c", "r", 1)).toBe("campaign:c:recipient:r:bubble:2");
  });

  it("envia em ordem, espera apenas entre balões e interrompe no primeiro erro", async () => {
    const enviar = vi.fn(async (_body: string, index: number) => ({ status: index === 1 ? "failed" : "sent" }));
    const esperar = vi.fn(async () => {});

    const resultado = await enviarBaloesEmSequencia(["um", "dois", "tres"], enviar, esperar);

    expect(enviar.mock.calls.map(([body]) => body)).toEqual(["um", "dois"]);
    expect(esperar).toHaveBeenCalledTimes(1);
    expect(resultado).toMatchObject({ completa: false, enviados: 1, ultimo: { status: "failed" } });
  });

  it("não envia o próximo balão enquanto o anterior estiver apenas na fila", async () => {
    const enviar = vi.fn(async () => ({ status: "queued" }));
    const esperar = vi.fn(async () => {});

    const resultado = await enviarBaloesEmSequencia(["um", "dois"], enviar, esperar);

    expect(enviar).toHaveBeenCalledOnce();
    expect(esperar).not.toHaveBeenCalled();
    expect(resultado).toMatchObject({ completa: false, enviados: 0, ultimo: { status: "queued" } });
  });
});
