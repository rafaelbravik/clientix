import {
  request as httpRequest,
  type ClientRequest,
  type IncomingHttpHeaders,
  type IncomingMessage,
} from "node:http";
import { request as httpsRequest, type RequestOptions as HttpsRequestOptions } from "node:https";
import { lookup } from "node:dns/promises";
import { isIPv4, isIPv6 } from "node:net";
import { z } from "zod";
import { env } from "@/lib/env";
import { ipInternoAutorizadoPelaInstalacao } from "@/lib/automation/destinos-internos-autorizados";
import { ipEhEspecial } from "@/lib/automation/outbound-ip";
import { ProspectingError } from "./provider";
import { assertProspectingSourceAllowed } from "./source-policy";
import type { SearchProvider, SearchRun } from "./dispatcher";
import type { SearchInput } from "./schema";

export const LOCAL_HTTP_LIMITS = {
  healthTimeoutMs: 3_000,
  startTimeoutMs: 10_000,
  readTimeoutMs: 5_000,
  resultsTimeoutMs: 10_000,
  maxResponseBytes: 1_048_576,
  maxHeadersBytes: 16_384,
} as const;

type ResolvedAddress = { address: string; family: number };
type Resolve = (hostname: string) => Promise<ResolvedAddress[]>;
type RequestJson = (
  base: URL,
  address: ResolvedAddress,
  method: "GET" | "POST",
  path: string,
  body: unknown,
  timeoutMs: number,
) => Promise<unknown>;

function timeoutError(method: "GET" | "POST"): ProspectingError {
  return new ProspectingError(
    "O engine local não respondeu dentro do limite.",
    502,
    "campanha",
    "engine_unavailable",
    method === "POST",
  );
}

function withinDeadline<T>(promise: Promise<T>, deadline: number, method: "GET" | "POST"): Promise<T> {
  const remaining = deadline - Date.now();
  if (remaining <= 0) return Promise.reject(timeoutError(method));
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(timeoutError(method)), remaining);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

const privateV4 = (ip: string) =>
  /^10\./.test(ip) || /^192\.168\./.test(ip) || /^172\.(1[6-9]|2\d|3[01])\./.test(ip);

function categoryFor(addresses: readonly ResolvedAddress[]): "public" | "private" {
  if (!addresses.length) throw new Error("dns_empty");
  let category: "public" | "private" | undefined;
  for (const { address } of addresses) {
    const current = privateV4(address) ? "private" : "public";
    if (ipEhEspecial(address) && current !== "private") throw new Error("blocked_ip");
    if (category && category !== current) throw new Error("mixed_dns");
    category = current;
  }
  return category!;
}

export async function validateLocalHttpTarget(
  raw: string,
  options: { resolve?: Resolve; internalIpAllowed?: (ip: string) => Promise<boolean> } = {},
): Promise<{ base: URL; pinnedAddress: ResolvedAddress }> {
  let base: URL;
  try {
    base = new URL(raw);
  } catch {
    throw new ProspectingError("A URL do engine local está inválida.", 422, "campanha", "invalid_engine_url");
  }
  if (
    (base.protocol !== "http:" && base.protocol !== "https:") ||
    base.username ||
    base.password ||
    base.pathname !== "/" ||
    base.search ||
    base.hash ||
    !base.hostname ||
    isIPv6(base.hostname.replace(/^\[|\]$/g, ""))
  ) {
    throw new ProspectingError("A URL do engine local não atende ao contrato de rede.", 422, "campanha", "invalid_engine_url");
  }

  const hostname = base.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (hostname === "localhost" || hostname.endsWith(".localhost"))
    throw new ProspectingError("O engine local precisa usar um host interno administrado, não loopback.", 422, "campanha", "unsafe_engine_target");

  let addresses: ResolvedAddress[];
  try {
    if (isIPv4(hostname)) addresses = [{ address: hostname, family: 4 }];
    else addresses = await (options.resolve ?? resolveAll)(hostname);
  } catch {
    throw new ProspectingError("Não foi possível resolver o host do engine local.", 422, "campanha", "unsafe_engine_target");
  }
  if (!addresses.length || addresses.some((entry) => !isIPv4(entry.address) && !isIPv6(entry.address)))
    throw new ProspectingError("O host do engine local não resolveu para endereços válidos.", 422, "campanha", "unsafe_engine_target");

  let category: "public" | "private";
  try {
    category = categoryFor(addresses);
  } catch {
    throw new ProspectingError("O destino do engine local não é permitido pela política de rede.", 422, "campanha", "unsafe_engine_target");
  }
  if (category === "private") {
    for (const entry of addresses) {
      if (!privateV4(entry.address) || !(await (options.internalIpAllowed ?? ipInternoAutorizadoPelaInstalacao)(entry.address)))
        throw new ProspectingError("O destino interno do engine não foi autorizado pela instalação.", 422, "campanha", "unsafe_engine_target");
    }
  } else if (base.protocol !== "https:") {
    throw new ProspectingError("Destinos remotos do engine exigem HTTPS.", 422, "campanha", "engine_https_required");
  }

  if (base.protocol === "http:" && category !== "private")
    throw new ProspectingError("HTTP só é permitido na rede privada autorizada da instalação.", 422, "campanha", "engine_https_required");
  return { base, pinnedAddress: addresses[0]! };
}

async function resolveAll(hostname: string): Promise<ResolvedAddress[]> {
  return (await lookup(hostname, { all: true, verbatim: true })).map(({ address, family }) => ({ address, family }));
}

export function parseLocalHttpJsonResponse(
  statusCode: number,
  rawHeaders: readonly string[],
  headers: IncomingHttpHeaders,
  body: Uint8Array,
  method: "GET" | "POST",
): unknown {
  const uncertain = method === "POST";
  const headerBytes = rawHeaders.reduce((total, value) => total + Buffer.byteLength(value), 0);
  if (headerBytes > LOCAL_HTTP_LIMITS.maxHeadersBytes)
    throw new ProspectingError("O engine enviou headers acima do limite permitido.", 502, "campanha", "engine_response_too_large", uncertain);
  if (statusCode >= 300 && statusCode < 400)
    throw new ProspectingError("O engine tentou redirecionar a chamada; a operação foi recusada.", 502, "campanha", "engine_redirect_blocked", uncertain);
  if (statusCode < 200 || statusCode >= 300)
    throw new ProspectingError(`O engine respondeu HTTP ${statusCode}.`, 502, "campanha", "engine_http_error", uncertain && statusCode >= 500);
  const encoding = headers["content-encoding"];
  if (encoding && encoding !== "identity")
    throw new ProspectingError("O engine enviou uma resposta comprimida fora do contrato de tamanho.", 502, "campanha", "engine_response_encoding", uncertain);
  const rawLength = headers["content-length"];
  if (rawLength !== undefined && (!/^\d+$/.test(String(rawLength)) || Number(rawLength) > LOCAL_HTTP_LIMITS.maxResponseBytes))
    throw new ProspectingError("A resposta do engine excedeu 1 MiB.", 502, "campanha", "engine_response_too_large", uncertain);
  if (body.byteLength > LOCAL_HTTP_LIMITS.maxResponseBytes)
    throw new ProspectingError("A resposta do engine excedeu 1 MiB.", 502, "campanha", "engine_response_too_large", uncertain);
  const contentType = headers["content-type"] ?? "";
  if (!/^application\/(?:[a-z0-9.+-]*\+)?json(?:\s*;|$)/i.test(String(contentType)))
    throw new ProspectingError("O engine não respondeu com JSON.", 502, "campanha", "engine_invalid_response", uncertain);
  try {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(body)) as unknown;
  } catch {
    throw new ProspectingError("O engine respondeu com JSON inválido.", 502, "campanha", "engine_invalid_json", uncertain);
  }
}

function nodeRequestJson(
  base: URL,
  pinned: ResolvedAddress,
  method: "GET" | "POST",
  path: string,
  body: unknown,
  timeoutMs: number,
): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let settled = false;
    let response: IncomingMessage | undefined;
    const requestState: { current?: ClientRequest } = {};
    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn();
    };
    const fail = (error: ProspectingError) =>
      finish(() => {
        response?.destroy();
        requestState.current?.destroy();
        reject(error);
      });
    const timer = setTimeout(() => fail(timeoutError(method)), timeoutMs);
    const url = new URL(path, base);
    const requestFn = url.protocol === "https:" ? httpsRequest : httpRequest;
    const lookupPinned = ((_: string, options: { all?: boolean }, callback: (...args: unknown[]) => void) => {
      if (options?.all) callback(null, [{ address: pinned.address, family: pinned.family }]);
      else callback(null, pinned.address, pinned.family);
    }) as NonNullable<HttpsRequestOptions["lookup"]>;
    const payload = body === undefined ? undefined : JSON.stringify(body);
    const req = requestFn(
      url,
      {
        method,
        agent: false,
        lookup: lookupPinned,
        maxHeaderSize: LOCAL_HTTP_LIMITS.maxHeadersBytes,
        headers: {
          Accept: "application/json",
          "Accept-Encoding": "identity",
          Connection: "close",
          ...(payload === undefined ? {} : { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(payload) }),
        },
      },
      (res) => {
        response = res;
        const headerBytes = res.rawHeaders.reduce((total, value) => total + Buffer.byteLength(value), 0);
        if (headerBytes > LOCAL_HTTP_LIMITS.maxHeadersBytes) {
          fail(new ProspectingError("O engine enviou headers acima do limite permitido.", 502, "campanha", "engine_response_too_large"));
          return;
        }
        if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400) {
          fail(new ProspectingError("O engine tentou redirecionar a chamada; a operação foi recusada.", 502, "campanha", "engine_redirect_blocked", method === "POST"));
          return;
        }
        if (!res.statusCode || res.statusCode < 200 || res.statusCode >= 300) {
          fail(new ProspectingError(`O engine respondeu HTTP ${res.statusCode ?? 0}.`, 502, "campanha", "engine_http_error", method === "POST" && (res.statusCode ?? 500) >= 500));
          return;
        }
        const encoding = res.headers["content-encoding"];
        if (encoding && encoding !== "identity") {
          fail(new ProspectingError("O engine enviou uma resposta comprimida fora do contrato de tamanho.", 502, "campanha", "engine_response_encoding"));
          return;
        }
        const length = Number(res.headers["content-length"] ?? 0);
        if (Number.isFinite(length) && length > LOCAL_HTTP_LIMITS.maxResponseBytes) {
          fail(new ProspectingError("A resposta do engine excedeu 1 MiB.", 502, "campanha", "engine_response_too_large", method === "POST"));
          return;
        }
        const chunks: Buffer[] = [];
        let bytes = 0;
        res.on("data", (chunk: Buffer | string) => {
          if (settled) return;
          const data = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
          bytes += data.byteLength;
          if (bytes > LOCAL_HTTP_LIMITS.maxResponseBytes) {
            fail(new ProspectingError("A resposta do engine excedeu 1 MiB.", 502, "campanha", "engine_response_too_large", method === "POST"));
            return;
          }
          chunks.push(data);
        });
        res.on("error", () => fail(new ProspectingError("Falha ao ler a resposta do engine.", 502, "campanha", "engine_read_failed", method === "POST")));
        res.on("end", () => {
          if (settled) return;
          try {
            const parsed = parseLocalHttpJsonResponse(
              res.statusCode ?? 0,
              res.rawHeaders,
              res.headers,
              Buffer.concat(chunks),
              method,
            );
            finish(() => resolve(parsed));
          } catch (error) {
            fail(error instanceof ProspectingError ? error : new ProspectingError("O engine respondeu com dados inválidos.", 502));
          }
        });
      },
    );
    requestState.current = req;
    req.on("error", () => fail(timeoutError(method)));
    if (payload !== undefined) req.write(payload);
    req.end();
  });
}

const jobSchema = z.object({
  job_id: z.string().min(1).max(200),
  status: z.enum(["pending", "running", "scheduled", "retryable", "available", "completed", "failed", "cancelled", "discarded"]),
  results: z.array(z.unknown()).max(20_000).optional(),
});

function statusForEngine(status: string): SearchRun["status"] {
  if (status === "completed") return "SUCCEEDED";
  if (["pending", "running", "scheduled", "retryable", "available"].includes(status)) return "RUNNING";
  if (["failed", "cancelled", "discarded"].includes(status)) return "FAILED";
  throw new ProspectingError("O engine retornou um estado não reconhecido.", 502, "campanha", "engine_unknown_state");
}

function publicUrl(value: unknown): string | null {
  if (typeof value !== "string" || value.length > 500) return null;
  try {
    const url = new URL(value);
    if ((url.protocol !== "https:" && url.protocol !== "http:") || url.username || url.password) return null;
    return url.href;
  } catch {
    return null;
  }
}

/** Projeta somente os campos comerciais permitidos; nenhum payload bruto é persistido. */
export function projectLocalHttpResult(item: unknown): Record<string, unknown> | null {
  if (!item || typeof item !== "object" || Array.isArray(item)) return null;
  const source = item as Record<string, unknown>;
  if (source.permanentlyClosed === true || source.temporarilyClosed === true) return null;
  const pickString = (...values: unknown[]) => values.find((value): value is string => typeof value === "string" && value.trim().length > 0)?.trim().slice(0, 500);
  const title = pickString(source.title);
  const placeId = pickString(source.placeId, source.place_id);
  if (!title || !placeId) return null;
  const rating = typeof source.totalScore === "number" && Number.isFinite(source.totalScore) ? source.totalScore : null;
  const reviews = typeof source.reviewsCount === "number" && Number.isSafeInteger(source.reviewsCount) && source.reviewsCount >= 0 ? source.reviewsCount : null;
  return {
    title: title.slice(0, 200),
    placeId: placeId.slice(0, 200),
    phone: pickString(source.phoneUnformatted, source.phone),
    website: publicUrl(source.website),
    categoryName: pickString(source.categoryName),
    address: pickString(source.address),
    url: publicUrl(source.url),
    totalScore: rating,
    reviewsCount: reviews,
  };
}

export interface LocalHttpProviderOptions {
  source?: "google_maps" | "synthetic";
  getBaseUrl?: () => string;
  resolve?: Resolve;
  internalIpAllowed?: (ip: string) => Promise<boolean>;
  requestJson?: RequestJson;
}

export function createLocalHttpProvider(options: LocalHttpProviderOptions = {}): SearchProvider & { healthCheck(): Promise<void> } {
  const source = options.source ?? "google_maps";
  if (source === "synthetic" && (process.env.NODE_ENV !== "test" || !options.requestJson))
    throw new Error("O engine sintético só pode existir em testes com transporte falso.");
  const getBaseUrl = options.getBaseUrl ?? (() => env.PROSPECTING_LOCAL_HTTP_URL);
  const resolveTarget = async () => {
    const raw = getBaseUrl().trim();
    if (!raw) throw new ProspectingError("O engine local não está configurado nesta instalação.", 503, "campanha", "local_http_unavailable");
    return validateLocalHttpTarget(raw, options);
  };
  const request = options.requestJson ?? nodeRequestJson;
  const call = async (path: string, method: "GET" | "POST", body: unknown, timeout: number) => {
    const deadline = Date.now() + timeout;
    const target = await withinDeadline(resolveTarget(), deadline, method);
    const remaining = deadline - Date.now();
    return withinDeadline(
      request(target.base, target.pinnedAddress, method, path, body, remaining),
      deadline,
      method,
    );
  };
  const readJob = async (id: string, timeout: number) => {
    const body = await call(`/api/v1/jobs/${encodeURIComponent(id)}`, "GET", undefined, timeout);
    const parsed = jobSchema.safeParse(body);
    if (!parsed.success) throw new ProspectingError("O engine respondeu com um job inválido.", 502, "campanha", "engine_invalid_response");
    return parsed.data;
  };
  const requireSource = () => assertProspectingSourceAllowed(source);
  return {
    async healthCheck() {
      requireSource();
      const response = await call("/api/v1/health", "GET", undefined, LOCAL_HTTP_LIMITS.healthTimeoutMs);
      if (!response || typeof response !== "object" || (response as { status?: unknown }).status !== "ok")
        throw new ProspectingError("O engine não confirmou o health check.", 502, "campanha", "engine_health_failed");
    },
    async startSearch(_installationKey: string, input: SearchInput) {
      requireSource();
      const response = await call(
        "/api/v1/scrape",
        "POST",
        { keyword: `${input.niche} em ${input.location}`, lang: "pt-BR", max_depth: 1, timeout: 300 },
        LOCAL_HTTP_LIMITS.startTimeoutMs,
      );
      const parsed = jobSchema.safeParse(response);
      if (!parsed.success)
        throw new ProspectingError("O engine pode ter aceitado a busca, mas não confirmou o job.", 502, "campanha", "engine_start_unconfirmed", true);
      return { id: parsed.data.job_id, status: statusForEngine(parsed.data.status), defaultDatasetId: parsed.data.job_id, usageTotalUsd: 0 };
    },
    async readSearch(_installationKey: string, id: string) {
      requireSource();
      const job = await readJob(id, LOCAL_HTTP_LIMITS.readTimeoutMs);
      return { id: job.job_id, status: statusForEngine(job.status), defaultDatasetId: job.job_id, usageTotalUsd: 0 };
    },
    async readResults(_installationKey: string, id: string, limit: number) {
      requireSource();
      const job = await readJob(id, LOCAL_HTTP_LIMITS.resultsTimeoutMs);
      if (job.status !== "completed") throw new ProspectingError("O engine ainda não concluiu os resultados.", 502, "campanha", "engine_results_not_ready");
      return (job.results ?? []).slice(0, Math.max(0, Math.min(100, limit))).map(projectLocalHttpResult).filter((item): item is Record<string, unknown> => item !== null);
    },
  };
}

export const localHttpProvider = createLocalHttpProvider();
