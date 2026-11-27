const TELEGRAM_AUTH_ERROR_CODES = new Set([
  "API_ID_INVALID",
  "AUTH_KEY_DUPLICATED",
  "AUTH_KEY_INVALID",
  "AUTH_KEY_UNREGISTERED",
  "AUTH_RESTART",
  "CONNECTION_API_ID_INVALID",
  "PASSWORD_HASH_INVALID",
  "PHONE_CODE_EMPTY",
  "PHONE_CODE_EXPIRED",
  "PHONE_CODE_HASH_EMPTY",
  "PHONE_CODE_HASH_INVALID",
  "PHONE_CODE_INVALID",
  "PHONE_NUMBER_BANNED",
  "PHONE_NUMBER_INVALID",
  "PHONE_NUMBER_UNOCCUPIED",
  "SESSION_PASSWORD_NEEDED",
]);

export type TelegramAuthErrorResult = {
  code: string;
  message: string;
  status: number;
};

export type TelegramAuthErrorDiagnostic = {
  errorType: string;
  telegramCode: string | null;
};

function errorRecord(error: unknown): Record<string, unknown> | null {
  return error && typeof error === "object" ? (error as Record<string, unknown>) : null;
}

function safeErrorType(error: unknown): string {
  if (!(error instanceof Error)) return "UnknownError";
  return /^[A-Za-z][A-Za-z0-9]{0,63}$/.test(error.name) ? error.name : "UnknownError";
}

function findTelegramCode(error: unknown): string | null {
  const record = errorRecord(error);
  if (!record) return null;

  const retryCode = record.code === "FLOOD_WAIT" ? "FLOOD_WAIT" : null;
  if (retryCode) return retryCode;

  const candidates = [record.errorMessage, record.message, record.name].filter(
    (value): value is string => typeof value === "string",
  );

  for (const candidate of candidates) {
    const tokens = candidate.match(/\b[A-Z][A-Z0-9_]{1,79}\b/gi) ?? [];
    for (const token of tokens) {
      const normalized = token.toUpperCase();
      if (/^FLOOD(?:_PREMIUM)?_WAIT(?:_\d+)?$/.test(normalized)) return normalized;
      if (TELEGRAM_AUTH_ERROR_CODES.has(normalized)) return normalized;
    }

    const className = candidate
      .replace(/Error$/, "")
      .replace(/([a-z\d])([A-Z])/g, "$1_$2")
      .toUpperCase();
    if (TELEGRAM_AUTH_ERROR_CODES.has(className)) return className;
  }

  return null;
}

export function diagnosticoErroTelegram(error: unknown): TelegramAuthErrorDiagnostic {
  return {
    errorType: safeErrorType(error),
    telegramCode: findTelegramCode(error),
  };
}

/** Teleproto pode minificar o nome da classe; o código RPC permanece estável. */
export function exigeSenhaDeDuasEtapas(error: unknown): boolean {
  if (error instanceof Error && error.name === "SessionPasswordNeededError") return true;
  return findTelegramCode(error) === "SESSION_PASSWORD_NEEDED";
}

export function mensagemErroTelegram(error: unknown): TelegramAuthErrorResult {
  const record = errorRecord(error);
  const telegramCode = findTelegramCode(error);
  const retryAfter = Number(record?.retryAfterSeconds);
  const floodMatch = telegramCode?.match(/^FLOOD(?:_PREMIUM)?_WAIT(?:_(\d+))?$/);
  const retrySeconds =
    Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter : Number(floodMatch?.[1]);

  if (telegramCode === "FLOOD_WAIT" || (Number.isFinite(retrySeconds) && retrySeconds > 0)) {
    return {
      code: "rate_limited",
      message:
        Number.isFinite(retrySeconds) && retrySeconds > 0
          ? `O Telegram pediu uma pausa. Tente novamente em ${retrySeconds} segundos.`
          : "O Telegram pediu uma pausa. Tente novamente mais tarde.",
      status: 429,
    };
  }

  if (telegramCode === "PHONE_CODE_INVALID") {
    return {
      code: "bad_request",
      message:
        "O código informado não foi aceito. Confira o código mais recente enviado pelo Telegram.",
      status: 400,
    };
  }

  if (
    telegramCode === "PHONE_CODE_EMPTY" ||
    telegramCode === "PHONE_CODE_EXPIRED" ||
    telegramCode === "PHONE_CODE_HASH_EMPTY" ||
    telegramCode === "PHONE_CODE_HASH_INVALID" ||
    telegramCode === "AUTH_RESTART" ||
    telegramCode === "AUTH_KEY_DUPLICATED" ||
    telegramCode === "AUTH_KEY_INVALID" ||
    telegramCode === "AUTH_KEY_UNREGISTERED"
  ) {
    return {
      code: "invalid_state",
      message:
        "Esta tentativa de verificação expirou. Cancele o formulário, solicite um novo código e use o mais recente.",
      status: 409,
    };
  }

  if (telegramCode === "API_ID_INVALID" || telegramCode === "CONNECTION_API_ID_INVALID") {
    return {
      code: "integration_unavailable",
      message:
        "O Telegram recusou as credenciais da aplicação. O Dono da instalação precisa conferir o API ID e o API Hash configurados.",
      status: 503,
    };
  }

  if (telegramCode === "PASSWORD_HASH_INVALID") {
    return {
      code: "bad_request",
      message: "A senha de duas etapas do Telegram está incorreta.",
      status: 400,
    };
  }

  if (telegramCode === "SESSION_PASSWORD_NEEDED") {
    return {
      code: "invalid_state",
      message: "Esta conta exige a senha de duas etapas do Telegram. Continue pela etapa de senha.",
      status: 409,
    };
  }

  if (telegramCode === "PHONE_NUMBER_INVALID") {
    return {
      code: "bad_request",
      message: "Confira o telefone e use o formato internacional, como +5511999998888.",
      status: 400,
    };
  }

  if (telegramCode === "PHONE_NUMBER_BANNED") {
    return {
      code: "bad_request",
      message:
        "O Telegram não permite autenticar esta conta por esse número. Confira o estado da conta no aplicativo oficial.",
      status: 400,
    };
  }

  if (telegramCode === "PHONE_NUMBER_UNOCCUPIED") {
    return {
      code: "bad_request",
      message: "Não há uma conta do Telegram registrada para esse número.",
      status: 400,
    };
  }

  return {
    code: "bad_gateway",
    message:
      "O Telegram não concluiu a autenticação. Confira os dados e tente novamente. Se persistir, solicite outro código e informe o suporte.",
    status: 502,
  };
}
