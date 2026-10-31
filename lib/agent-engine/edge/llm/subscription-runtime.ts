import { CHATGPT_SUBSCRIPTION_PROVIDER } from "@/lib/ai/credenciais/chatgpt-siwc";

export { CHATGPT_SUBSCRIPTION_PROVIDER };

export type ChatGPTSubscriptionRuntimeErrorCode =
  | "subscription_feature_disabled"
  | "subscription_not_connected"
  | "subscription_credential_unavailable"
  | "subscription_token_refresh_failed"
  | "subscription_unauthorized"
  | "subscription_usage_limit"
  | "subscription_rate_limited"
  | "subscription_unavailable"
  | "subscription_invalid_request"
  | "subscription_model_not_available"
  | "subscription_stream_incomplete"
  | "subscription_provider_error";

const MENSAGENS_SEGURAS: Record<ChatGPTSubscriptionRuntimeErrorCode, string> = {
  subscription_feature_disabled: "O uso da assinatura do ChatGPT está desativado nesta instalação.",
  subscription_not_connected: "Conecte a assinatura do ChatGPT em IA › Credenciais.",
  subscription_credential_unavailable: "A credencial da assinatura do ChatGPT não pôde ser lida com segurança.",
  subscription_token_refresh_failed: "Não foi possível renovar a autenticação da assinatura do ChatGPT.",
  subscription_unauthorized: "A OpenAI recusou a autenticação da assinatura do ChatGPT.",
  subscription_usage_limit: "A assinatura do ChatGPT atingiu um limite de uso.",
  subscription_rate_limited: "A assinatura do ChatGPT está temporariamente limitando chamadas.",
  subscription_unavailable: "A API da assinatura do ChatGPT está temporariamente indisponível.",
  subscription_invalid_request: "A API da assinatura do ChatGPT recusou os parâmetros da chamada.",
  subscription_model_not_available: "O modelo não está disponível na assinatura conectada desta organização.",
  subscription_stream_incomplete: "A resposta da assinatura do ChatGPT terminou sem um evento final válido.",
  subscription_provider_error: "A chamada à assinatura do ChatGPT falhou.",
};

export class ChatGPTSubscriptionRuntimeError extends Error {
  override readonly name = "chatgpt_subscription_runtime";

  constructor(
    readonly code: ChatGPTSubscriptionRuntimeErrorCode,
    readonly statusCode: number | null = null,
  ) {
    super(MENSAGENS_SEGURAS[code]);
  }
}

function registro(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : null;
}

export function statusHttpDoErro(error: unknown): number | null {
  const vistos = new Set<unknown>();
  const fila: unknown[] = [error];
  while (fila.length > 0) {
    const atual = fila.shift();
    if (!atual || vistos.has(atual)) continue;
    vistos.add(atual);
    const value = registro(atual);
    const response = registro(value?.response);
    const status = value?.statusCode ?? value?.status ?? response?.status;
    if (typeof status === "number" && Number.isInteger(status)) return status;
    for (const nested of [value?.cause, value?.lastError, value?.error, value?.response]) {
      if (nested && !vistos.has(nested)) fila.push(nested);
    }
  }
  return null;
}

function textoPrivadoParaClassificar(error: unknown): string {
  const vistos = new Set<unknown>();
  const fila: unknown[] = [error];
  const parts: string[] = [];
  while (fila.length > 0) {
    const atual = fila.shift();
    if (!atual || vistos.has(atual)) continue;
    vistos.add(atual);
    const value = registro(atual);
    if (atual instanceof Error) parts.push(atual.message);
    if (typeof value?.responseBody === "string") parts.push(value.responseBody);
    if (typeof value?.body === "string") parts.push(value.body);
    for (const nested of [value?.cause, value?.lastError, value?.error]) {
      if (nested && !vistos.has(nested)) fila.push(nested);
    }
  }
  return parts.join(" ").toLowerCase();
}

export function classificarErroDaAssinatura(error: unknown): ChatGPTSubscriptionRuntimeError {
  const erroTipado = erroTipadoAninhado(error);
  if (erroTipado) return erroTipado;

  const status = statusHttpDoErro(error);
  const texto = textoPrivadoParaClassificar(error);
  const limiteDeUso = /subscription.{0,60}usage limit|usage limit.{0,60}subscription|reached.{0,30}usage limit/i.test(texto);

  if ((status === 400 || status === 402 || status === 429) && limiteDeUso) {
    return new ChatGPTSubscriptionRuntimeError("subscription_usage_limit", status);
  }
  if (status === 401 || status === 403) {
    return new ChatGPTSubscriptionRuntimeError("subscription_unauthorized", status);
  }
  if (status === 429) return new ChatGPTSubscriptionRuntimeError("subscription_rate_limited", status);
  if (status === 400) return new ChatGPTSubscriptionRuntimeError("subscription_invalid_request", status);
  if (status !== null && status >= 500) return new ChatGPTSubscriptionRuntimeError("subscription_unavailable", status);
  if (status === 402) return new ChatGPTSubscriptionRuntimeError("subscription_provider_error", status);

  const name = registro(error)?.name;
  if (name === "TimeoutError" || name === "AbortError" || name === "TypeError") {
    return new ChatGPTSubscriptionRuntimeError("subscription_unavailable", status);
  }
  return new ChatGPTSubscriptionRuntimeError("subscription_provider_error", status);
}

export function eh401DaAssinatura(error: unknown): boolean {
  return statusHttpDoErro(error) === 401;
}

function erroTipadoAninhado(error: unknown): ChatGPTSubscriptionRuntimeError | null {
  const vistos = new Set<unknown>();
  let atual: unknown = error;
  while (atual && !vistos.has(atual)) {
    vistos.add(atual);
    if (atual instanceof ChatGPTSubscriptionRuntimeError) return atual;
    atual = registro(atual)?.cause;
  }
  return null;
}

/**
 * Repassa o SSE sem armazená-lo e invalida o stream se a Responses API não
 * concluir com `response.completed` e `response.status=completed`.
 */
export function exigirResponseCompleted(response: Response): Response {
  if (!response.ok) return response;

  const contentType = response.headers.get("content-type")?.toLowerCase() ?? "";
  if (!contentType.includes("text/event-stream") || response.body === null) {
    throw new ChatGPTSubscriptionRuntimeError("subscription_provider_error", response.status);
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let pendente = "";
  let concluida = false;

  const inspecionarFrame = (frame: string) => {
    const data = frame
      .split(/\r?\n/)
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).trimStart())
      .join("\n");
    if (!data || data === "[DONE]") return;

    try {
      const event = JSON.parse(data) as unknown;
      const root = registro(event);
      const payload = registro(root?.response);
      if (root?.type === "response.completed" && payload?.status === "completed") concluida = true;
    } catch {
      // Frames incompletos ou desconhecidos não contam como conclusão.
    }
  };

  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      let chunk: ReadableStreamReadResult<Uint8Array>;
      try {
        chunk = await reader.read();
      } catch {
        controller.error(new ChatGPTSubscriptionRuntimeError("subscription_unavailable", response.status));
        return;
      }

      if (chunk.done) {
        pendente += decoder.decode();
        if (pendente.length > 0) inspecionarFrame(pendente);
        if (!concluida) {
          controller.error(new ChatGPTSubscriptionRuntimeError("subscription_stream_incomplete", response.status));
          return;
        }
        controller.close();
        return;
      }

      pendente += decoder.decode(chunk.value, { stream: true });
      let separator: RegExpExecArray | null;
      const delimitador = /\r?\n\r?\n/g;
      while ((separator = delimitador.exec(pendente)) !== null) {
        const frame = pendente.slice(0, separator.index);
        pendente = pendente.slice(separator.index + separator[0].length);
        delimitador.lastIndex = 0;
        inspecionarFrame(frame);
      }
      controller.enqueue(chunk.value);
    },
    async cancel(reason) {
      await reader.cancel(reason);
    },
  });

  return new Response(body, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });
}
