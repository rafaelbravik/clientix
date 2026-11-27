import { describe, expect, it } from "vitest";

import {
  diagnosticoErroTelegram,
  exigeSenhaDeDuasEtapas,
  mensagemErroTelegram,
} from "./auth-errors";

describe("erros de autenticação da conta Telegram", () => {
  it("lê o código RPC canônico da propriedade errorMessage do Teleproto", () => {
    const error = Object.assign(new Error("400: falha RPC"), {
      errorMessage: "PHONE_CODE_INVALID",
    });

    expect(mensagemErroTelegram(error)).toMatchObject({
      code: "bad_request",
      status: 400,
      message: expect.stringContaining("código informado não foi aceito"),
    });
    expect(diagnosticoErroTelegram(error)).toMatchObject({
      errorType: "Error",
      telegramCode: "PHONE_CODE_INVALID",
    });
  });

  it("recomenda reiniciar o fluxo quando o código ou a sessão temporária expirou", () => {
    for (const telegramCode of ["PHONE_CODE_EXPIRED", "PHONE_CODE_HASH_INVALID", "AUTH_RESTART"]) {
      const error = Object.assign(new Error("erro RPC"), { errorMessage: telegramCode });
      expect(mensagemErroTelegram(error)).toMatchObject({
        code: "invalid_state",
        status: 409,
        message: expect.stringContaining("solicite um novo código"),
      });
    }
  });

  it("aponta ao Dono quando as credenciais centrais da aplicação foram recusadas", () => {
    const error = Object.assign(new Error("400: API_ID_INVALID"), {
      errorMessage: "API_ID_INVALID",
    });

    expect(mensagemErroTelegram(error)).toMatchObject({
      code: "integration_unavailable",
      status: 503,
      message: expect.stringContaining("API ID e o API Hash"),
    });
  });

  it("detecta a senha 2FA pelo código RPC mesmo com classe Teleproto minificada", () => {
    const error = Object.assign(new Error("400: falha RPC"), {
      name: "cE",
      errorMessage: "SESSION_PASSWORD_NEEDED",
    });

    expect(exigeSenhaDeDuasEtapas(error)).toBe(true);
    expect(diagnosticoErroTelegram(error)).toMatchObject({
      errorType: "cE",
      telegramCode: "SESSION_PASSWORD_NEEDED",
    });
  });

  it("preserva o intervalo do FloodWait sem expor a mensagem bruta do erro", () => {
    const error = Object.assign(new Error("detalhe não deve aparecer"), {
      code: "FLOOD_WAIT",
      retryAfterSeconds: 47,
    });
    const result = mensagemErroTelegram(error);

    expect(result).toMatchObject({ code: "rate_limited", status: 429 });
    expect(result.message).toContain("47 segundos");
    expect(result.message).not.toContain("detalhe não deve aparecer");
  });

  it("mantém uma mensagem segura para erros desconhecidos e registra apenas metadados seguros", () => {
    const error = Object.assign(new Error("código privado 987654; sessão sensível"), {
      errorMessage: "UNKNOWN_TELEGRAM_FAILURE",
    });
    const result = mensagemErroTelegram(error);
    const diagnostic = diagnosticoErroTelegram(error);

    expect(result.code).toBe("bad_gateway");
    expect(result.message).not.toContain("987654");
    expect(JSON.stringify(diagnostic)).not.toContain("987654");
    expect(diagnostic.errorType).toBe("Error");
    expect(diagnostic.telegramCode).toBeNull();
  });
});
