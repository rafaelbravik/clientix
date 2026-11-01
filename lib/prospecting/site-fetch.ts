import { lookup as lookupDns } from "node:dns/promises";
import { isIP } from "node:net";
import { Readable } from "node:stream";
import {
  request as httpRequest,
  type IncomingHttpHeaders,
  type IncomingMessage,
  type RequestOptions as HttpRequestOptions,
} from "node:http";
import { request as httpsRequest, type RequestOptions as HttpsRequestOptions } from "node:https";
import { ipEhEspecial } from "@/lib/automation/outbound-ip";
import {
  classifyMeasuredSite,
  extractSiteFacts,
  extractSiteSummary,
  siteWithoutFetch,
  type SiteAuditResult,
} from "./site-classify";
import { normalizedSiteUrl } from "./site-url";
import "server-only";

export const SITE_FETCH_LIMITS = {
  timeoutMs: 8_000,
  retries: 1,
  redirects: 5,
  maxBodyBytes: 200_000,
  maxHeaderBytes: 16_384,
  slowAfterMs: 5_000,
  maxSummaryChars: 1_200,
} as const;

const USER_AGENT = "Mozilla/5.0 (compatible; Clientix Site Audit/1.0)";
const MIN_HTML_BYTES = 800;
const REDIRECTS = new Set([301, 302, 303, 307, 308]);
const BLOCKED_MEASUREMENT_STATUS = new Set([401, 403, 406, 429, 451, 503]);
const TLS_ERROR_CODES = new Set([
  "CERT_HAS_EXPIRED",
  "CERT_NOT_YET_VALID",
  "CERT_REVOKED",
  "DEPTH_ZERO_SELF_SIGNED_CERT",
  "ERR_TLS_CERT_ALTNAME_INVALID",
  "SELF_SIGNED_CERT_IN_CHAIN",
  "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
  "CERT_SIGNATURE_FAILURE",
]);

export type SiteNetworkErrorCode =
  | "invalid_url"
  | "ssrf_blocked"
  | "dns_nxdomain"
  | "dns_uncertain"
  | "tls_invalid"
  | "timeout"
  | "network_error"
  | "redirect_limit"
  | "body_too_large"
  | "headers_too_large"
  | "unsupported_content_type"
  | "unsupported_content_encoding"
  | "http_error";

export class SiteNetworkError extends Error {
  constructor(
    public readonly code: SiteNetworkErrorCode,
    public readonly retryable = false,
  ) {
    super(code);
    this.name = "SiteNetworkError";
  }
}

export interface SiteResolvedAddress {
  address: string;
  family: 4 | 6;
}

export interface SiteHttpResponse {
  status: number;
  headers: IncomingHttpHeaders | Record<string, string | string[] | undefined>;
  headerBytes: number;
  readBody(maxBytes: number): Promise<Uint8Array>;
  close(): void;
}

export type SiteResolver = (hostname: string) => Promise<SiteResolvedAddress[]>;
export type PinnedSiteRequest = (
  url: URL,
  address: SiteResolvedAddress,
  timeoutMs: number,
) => Promise<SiteHttpResponse>;

function ip4Parts(value: string): number[] | null {
  const parts = value.split(".");
  if (parts.length !== 4 || parts.some((part) => !/^\d{1,3}$/.test(part))) return null;
  const numbers = parts.map(Number);
  return numbers.every((part) => part <= 255) ? numbers : null;
}

function isExtraReservedIpv4(value: string): boolean {
  const parts = ip4Parts(value);
  return !!parts && parts[0] === 192 && parts[1] === 88 && parts[2] === 99;
}

function isForbiddenAddress(value: string): boolean {
  if (isIP(value) === 0) return true;
  if (ipEhEspecial(value) || isExtraReservedIpv4(value)) return true;
  if (isIP(value) === 4) return false;
  const groups = expandIpv6(value);
  if (!groups) return true;
  // Only globally routed IPv6 unicast space is allowed. This conservatively
  // rejects ULA, link-local, multicast, transition, documentation and reserved ranges.
  if (groups[0]! < 0x2000 || groups[0]! > 0x3fff) return true;
  if (groups[0] === 0x2001 && groups[1]! <= 0x01ff) return true;
  if (groups[0] === 0x3fff && (groups[1]! & 0xfff0) === 0) return true;
  if (groups[0] === 0x2002) return true;
  return false;
}

function expandIpv6(value: string): number[] | null {
  let source = value.toLowerCase();
  const dotted = /:(\d{1,3}(?:\.\d{1,3}){3})$/.exec(source);
  if (dotted?.[1]) {
    const parts = ip4Parts(dotted[1]);
    if (!parts) return null;
    source = source.slice(0, dotted.index) + `:${((parts[0]! << 8) | parts[1]!).toString(16)}:${((parts[2]! << 8) | parts[3]!).toString(16)}`;
  }
  const sides = source.split("::");
  if (sides.length > 2) return null;
  const left = sides[0] ? sides[0]!.split(":") : [];
  const right = sides.length === 2 && sides[1] ? sides[1]!.split(":") : [];
  if ([...left, ...right].some((part) => !/^[0-9a-f]{1,4}$/.test(part))) return null;
  const missing = 8 - left.length - right.length;
  if ((sides.length === 1 && missing !== 0) || (sides.length === 2 && missing < 1)) return null;
  return [...left, ...Array<string>(missing).fill("0"), ...right].map((part) => Number.parseInt(part, 16));
}

function isPrivateHostname(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, "").replace(/\.$/, "");
  return (
    host === "localhost" ||
    host.endsWith(".localhost") ||
    host.endsWith(".local") ||
    host.endsWith(".internal") ||
    host === "home.arpa"
  );
}

function nodeResolver(): SiteResolver {
  return async (hostname) => {
    const clean = hostname.replace(/^\[|\]$/g, "");
    const family = isIP(clean);
    if (family) return [{ address: clean, family: family as 4 | 6 }];
    const records = await lookupDns(clean, { all: true, verbatim: true });
    return records.map((entry) => ({ address: entry.address, family: entry.family as 4 | 6 }));
  };
}

function codeOf(error: unknown): string | undefined {
  if (!error || typeof error !== "object") return undefined;
  const record = error as { code?: unknown; cause?: { code?: unknown } };
  return typeof record.code === "string" ? record.code : typeof record.cause?.code === "string" ? record.cause.code : undefined;
}

function mapNetworkError(error: unknown): SiteNetworkError {
  if (error instanceof SiteNetworkError) return error;
  const code = codeOf(error);
  if (code && TLS_ERROR_CODES.has(code)) return new SiteNetworkError("tls_invalid");
  if (code === "ENOTFOUND") return new SiteNetworkError("dns_nxdomain");
  if (code === "EAI_AGAIN") return new SiteNetworkError("dns_uncertain", true);
  if (code === "ETIMEOUT" || code === "ETIMEDOUT") return new SiteNetworkError("timeout", true);
  if (code === "ECONNRESET" || code === "ECONNREFUSED") return new SiteNetworkError("network_error", true);
  if (error instanceof Error && /timed? ?out/i.test(error.message)) return new SiteNetworkError("timeout", true);
  return new SiteNetworkError("network_error", false);
}

function pinnedLookup(address: SiteResolvedAddress): NonNullable<HttpsRequestOptions["lookup"]> {
  return ((_: string, options: { all?: boolean }, callback: (...args: unknown[]) => void) => {
    if (options?.all) callback(null, [{ address: address.address, family: address.family }]);
    else callback(null, address.address, address.family);
  }) as NonNullable<HttpsRequestOptions["lookup"]>;
}

export function createPinnedLookup(address: SiteResolvedAddress): NonNullable<HttpsRequestOptions["lookup"]> {
  return pinnedLookup(address);
}

export async function readLimitedSiteBody(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  maxBytes: number = SITE_FETCH_LIMITS.maxBodyBytes,
): Promise<Uint8Array> {
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value) continue;
    bytes += value.byteLength;
    if (bytes > maxBytes) {
      await reader.cancel().catch(() => undefined);
      throw new SiteNetworkError("body_too_large");
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks.map((chunk) => Buffer.from(chunk)), bytes);
}

function requestPinned(url: URL, address: SiteResolvedAddress, timeoutMs: number): Promise<SiteHttpResponse> {
  return new Promise((resolve, reject) => {
    let response: IncomingMessage | undefined;
    let headersSettled = false;
    let timedOut = false;
    const requestFn = url.protocol === "https:" ? httpsRequest : httpRequest;
    const options: HttpRequestOptions = {
      method: "GET",
      agent: false,
      lookup: pinnedLookup(address),
      maxHeaderSize: SITE_FETCH_LIMITS.maxHeaderBytes,
      headers: {
        Accept: "text/html,application/xhtml+xml;q=0.9",
        "Accept-Encoding": "identity",
        "User-Agent": USER_AGENT,
        Connection: "close",
      },
    };
    const req = requestFn(url, options, (res) => {
      response = res;
      headersSettled = true;
      const headerBytes = res.rawHeaders.reduce((sum, part) => sum + Buffer.byteLength(part), 0);
      let reader: ReadableStreamDefaultReader<Uint8Array> | null = null;
      resolve({
        status: res.statusCode ?? 0,
        headers: res.headers,
        headerBytes,
        readBody: async (maxBytes) => {
          reader = reader ?? Readable.toWeb(res).getReader();
          try {
            const body = await readLimitedSiteBody(reader, maxBytes);
            if (timedOut) throw new SiteNetworkError("timeout", true);
            return body;
          } catch (error) {
            if (error instanceof SiteNetworkError) throw error;
            if (timedOut) throw new SiteNetworkError("timeout", true);
            throw mapNetworkError(error);
          } finally {
            clearTimeout(timer);
          }
        },
        close: () => {
          clearTimeout(timer);
          if (reader) void reader.cancel().catch(() => undefined);
          else res.destroy();
        },
      });
    });
    const timer = setTimeout(() => {
      timedOut = true;
      const error = new SiteNetworkError("timeout", true);
      response?.destroy(error);
      req.destroy(error);
      if (!headersSettled) reject(error);
    }, Math.max(1, timeoutMs));
    req.on("error", (error) => {
      clearTimeout(timer);
      if (!headersSettled) reject(mapNetworkError(error));
    });
    req.end();
  });
}

function header(headers: SiteHttpResponse["headers"], name: string): string | null {
  const value = (headers as Record<string, string | string[] | undefined>)[name];
  return Array.isArray(value) ? value[0] ?? null : value ?? null;
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => {
        timer = setTimeout(() => reject(new SiteNetworkError("timeout", true)), Math.max(1, timeoutMs));
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function resolvePublicAddress(
  url: URL,
  resolve: SiteResolver,
  remainingMs: number,
): Promise<SiteResolvedAddress> {
  if (isPrivateHostname(url.hostname)) throw new SiteNetworkError("ssrf_blocked");
  let addresses: SiteResolvedAddress[];
  const literal = url.hostname.replace(/^\[|\]$/g, "");
  const literalFamily = isIP(literal);
  if (literalFamily) {
    addresses = [{ address: literal, family: literalFamily as 4 | 6 }];
  } else {
    try {
      addresses = await withTimeout(resolve(url.hostname), remainingMs);
    } catch (error) {
      const mapped = mapNetworkError(error);
      if (mapped.code === "dns_nxdomain") throw mapped;
      if (mapped.code === "timeout" || mapped.code === "dns_uncertain") throw new SiteNetworkError("dns_uncertain", true);
      throw mapped;
    }
  }
  if (!addresses.length || addresses.some((entry) => isIP(entry.address) !== entry.family || isForbiddenAddress(entry.address)))
    throw new SiteNetworkError("ssrf_blocked");
  return addresses[0]!;
}

interface FetchedPage {
  url: string;
  finalUrl: string;
  status: number;
  elapsedMs: number;
  html: string | null;
  contentTypeOk: boolean;
  encodingOk: boolean;
}

async function fetchPage(
  raw: string,
  dependencies: { resolve: SiteResolver; request: PinnedSiteRequest; now: () => number },
): Promise<FetchedPage> {
  const normalized = normalizedSiteUrl(raw);
  if (!normalized) throw new SiteNetworkError("invalid_url");
  let current: URL;
  try {
    current = new URL(normalized);
  } catch {
    throw new SiteNetworkError("invalid_url");
  }
  const startedAt = dependencies.now();
  const deadline = startedAt + SITE_FETCH_LIMITS.timeoutMs;
  let redirects = 0;
  for (;;) {
    if (current.protocol !== "http:" && current.protocol !== "https:") throw new SiteNetworkError("invalid_url");
    if (current.username || current.password || !current.hostname) throw new SiteNetworkError("invalid_url");
    const remainingMs = deadline - dependencies.now();
    if (remainingMs <= 0) throw new SiteNetworkError("timeout", true);
    const pinned = await resolvePublicAddress(current, dependencies.resolve, remainingMs);
    let response: SiteHttpResponse;
    try {
      response = await dependencies.request(current, pinned, deadline - dependencies.now());
    } catch (error) {
      throw mapNetworkError(error);
    }
    if (response.headerBytes > SITE_FETCH_LIMITS.maxHeaderBytes) {
      response.close();
      throw new SiteNetworkError("headers_too_large");
    }
    if (REDIRECTS.has(response.status)) {
      const location = header(response.headers, "location");
      response.close();
      if (!location) throw new SiteNetworkError("http_error");
      if (redirects >= SITE_FETCH_LIMITS.redirects) throw new SiteNetworkError("redirect_limit");
      try {
        current = new URL(location, current);
      } catch {
        throw new SiteNetworkError("invalid_url");
      }
      current.hash = "";
      if (
        (current.protocol !== "http:" && current.protocol !== "https:") ||
        current.username ||
        current.password ||
        !current.hostname ||
        current.href.length > 2000
      )
        throw new SiteNetworkError("invalid_url");
      redirects++;
      continue;
    }
    const elapsedMs = dependencies.now() - startedAt;
    if (response.status < 200 || response.status >= 300) {
      response.close();
      return {
        url: normalized,
        finalUrl: current.href,
        status: response.status,
        elapsedMs,
        html: null,
        contentTypeOk: false,
        encodingOk: true,
      };
    }
    const contentType = header(response.headers, "content-type")?.split(";", 1)[0]?.trim().toLowerCase();
    const contentTypeOk = contentType === "text/html" || contentType === "application/xhtml+xml";
    const contentEncoding = header(response.headers, "content-encoding")?.trim().toLowerCase();
    const encodingOk = !contentEncoding || contentEncoding === "identity";
    const contentLength = header(response.headers, "content-length");
    if (contentLength && /^\d+$/.test(contentLength) && Number(contentLength) > SITE_FETCH_LIMITS.maxBodyBytes) {
      response.close();
      throw new SiteNetworkError("body_too_large");
    }
    if (!contentTypeOk || !encodingOk) {
      response.close();
      return {
        url: normalized,
        finalUrl: current.href,
        status: response.status,
        elapsedMs,
        html: null,
        contentTypeOk,
        encodingOk,
      };
    }
    const bytes = await response.readBody(SITE_FETCH_LIMITS.maxBodyBytes);
    const charset = /charset\s*=\s*["']?([^;"'\s]+)/i.exec(header(response.headers, "content-type") ?? "")?.[1] ?? "utf-8";
    let html: string;
    try {
      html = new TextDecoder(charset, { fatal: false }).decode(bytes);
    } catch {
      html = new TextDecoder("utf-8", { fatal: false }).decode(bytes);
    }
    return {
      url: normalized,
      finalUrl: current.href,
      status: response.status,
      elapsedMs: dependencies.now() - startedAt,
      html,
      contentTypeOk,
      encodingOk,
    };
  }
}

async function probeHttps(
  finalHttpUrl: string,
  dependencies: { resolve: SiteResolver; request: PinnedSiteRequest; now: () => number },
): Promise<{ available: boolean | null; tlsValid: boolean | null }> {
  const target = new URL(finalHttpUrl);
  target.protocol = "https:";
  target.hash = "";
  try {
    const page = await fetchPage(target.href, dependencies);
    if (BLOCKED_MEASUREMENT_STATUS.has(page.status)) return { available: null, tlsValid: true };
    return {
      available: page.status >= 200 && page.status < 400 && page.finalUrl.startsWith("https:"),
      tlsValid: true,
    };
  } catch (error) {
    const fault = mapNetworkError(error);
    if (fault.code === "ssrf_blocked" || fault.code === "invalid_url") throw fault;
    if (fault.code === "tls_invalid" || fault.code === "redirect_limit")
      return { available: false, tlsValid: fault.code === "tls_invalid" ? false : null };
    // A primary HTTP response is evidence about that URL. A transient secure
    // probe cannot prove whether HTTPS is available for the same host.
    return { available: null, tlsValid: null };
  }
}

function notMeasured(url: string | null, at: string, reason: string, elapsedMs: number, provisional: boolean): SiteAuditResult {
  return {
    ver: 1,
    classe: "nao-medido",
    status: "not_measured",
    provisorio: provisional,
    citavel: false,
    external_content_trust: null,
    verificado_em: at,
    url,
    final_url: null,
    http_status: null,
    tempo_ms: elapsedMs,
    https_disponivel: null,
    tls_valido: null,
    mobile_hint: null,
    empty_hint: null,
    builder_hint: null,
    motivo: reason,
    facts: null,
    resumo: null,
  };
}

export async function auditWebsite(
  raw: string | null | undefined,
  at = new Date().toISOString(),
  options: {
    resolve?: SiteResolver;
    request?: PinnedSiteRequest;
    now?: () => number;
    wait?: (ms: number) => Promise<void>;
  } = {},
): Promise<SiteAuditResult> {
  const normalized = typeof raw === "string" ? normalizedSiteUrl(raw) : null;
  const noNetwork = siteWithoutFetch(raw, at);
  if (noNetwork) return noNetwork;
  if (!normalized) return notMeasured(null, at, "invalid_url", 0, false);
  const deps = {
    resolve: options.resolve ?? nodeResolver(),
    request: options.request ?? requestPinned,
    now: options.now ?? Date.now,
  };
  const startedAt = deps.now();
  let attempt = 0;
  for (;;) {
    try {
      const fetched = await fetchPage(raw!, deps);
      if (BLOCKED_MEASUREMENT_STATUS.has(fetched.status))
        return notMeasured(normalized, at, `measurement_blocked_http_${fetched.status}`, deps.now() - startedAt, true);
      if (fetched.status >= 400) {
        const result = notMeasured(normalized, at, `http_${fetched.status}`, deps.now() - startedAt, false);
        result.classe = "site-ruim";
        result.status = "checked";
        result.citavel = true;
        result.final_url = fetched.finalUrl;
        result.http_status = fetched.status;
        result.https_disponivel = fetched.finalUrl.startsWith("https:") ? true : null;
        result.tls_valido = fetched.finalUrl.startsWith("https:") ? true : null;
        return result;
      }
      if (!fetched.contentTypeOk || !fetched.encodingOk || fetched.html === null)
        return notMeasured(
          normalized,
          at,
          fetched.contentTypeOk ? "unsupported_content_encoding" : "unsupported_content_type",
          deps.now() - startedAt,
          true,
        );
      const facts = extractSiteFacts(fetched.html, fetched.finalUrl);
      const summary = extractSiteSummary(fetched.html);
      const secureProbe = fetched.finalUrl.startsWith("https:")
        ? { available: true, tlsValid: true }
        : await probeHttps(fetched.finalUrl, deps);
      if (secureProbe.tlsValid === false) {
        return {
          ver: 1,
          classe: "ssl-invalido",
          status: "checked",
          provisorio: false,
          citavel: true,
          external_content_trust: "UNTRUSTED_EXTERNAL_CONTENT",
          verificado_em: at,
          url: normalized,
          final_url: fetched.finalUrl,
          http_status: fetched.status,
          tempo_ms: fetched.elapsedMs,
          https_disponivel: false,
          tls_valido: false,
          mobile_hint: null,
          empty_hint: null,
          builder_hint: null,
          motivo: "tls_certificate_invalid",
          facts,
          resumo: summary?.slice(0, SITE_FETCH_LIMITS.maxSummaryChars) ?? null,
        };
      }
      const classified = classifyMeasuredSite({
        status: fetched.status,
        urlFinal: fetched.finalUrl,
        elapsedMs: fetched.elapsedMs,
        html: fetched.html,
        facts,
        httpsAvailable: secureProbe.available,
        minimumHtmlBytes: MIN_HTML_BYTES,
      });
      const result: SiteAuditResult = {
        ver: 1,
        classe: classified.classe,
        status: "checked",
        provisorio: false,
        citavel: classified.classe !== "nao-medido",
        external_content_trust: "UNTRUSTED_EXTERNAL_CONTENT",
        verificado_em: at,
        url: normalized,
        final_url: fetched.finalUrl,
        http_status: fetched.status,
        tempo_ms: fetched.elapsedMs,
        https_disponivel: secureProbe.available,
        tls_valido: secureProbe.tlsValid,
        mobile_hint: classified.mobileHint,
        empty_hint: classified.emptyHint,
        builder_hint: classified.builder,
        motivo: classified.motivo,
        facts,
        resumo: summary?.slice(0, SITE_FETCH_LIMITS.maxSummaryChars) ?? null,
      };
      return result;
    } catch (error) {
      const fault = mapNetworkError(error);
      const elapsed = deps.now() - startedAt;
      if (fault.code === "ssrf_blocked") return notMeasured(normalized, at, "unsafe_target_blocked", elapsed, true);
      if (fault.code === "invalid_url") return notMeasured(normalized, at, "invalid_url", elapsed, true);
      if (fault.code === "dns_nxdomain") {
        const result = notMeasured(normalized, at, "dns_nxdomain", elapsed, false);
        result.classe = "fora-do-ar";
        result.status = "checked";
        result.citavel = true;
        return result;
      }
      if (fault.code === "tls_invalid") {
        const result = notMeasured(normalized, at, "tls_certificate_invalid", elapsed, false);
        result.classe = "ssl-invalido";
        result.status = "checked";
        result.citavel = true;
        result.tls_valido = false;
        return result;
      }
      if (fault.code === "redirect_limit") {
        const result = notMeasured(normalized, at, "too_many_redirects", elapsed, false);
        result.classe = "site-ruim";
        result.status = "checked";
        result.citavel = true;
        return result;
      }
      if (fault.code === "body_too_large") return notMeasured(normalized, at, "body_limit_exceeded", elapsed, true);
      if (fault.code === "headers_too_large") return notMeasured(normalized, at, "response_headers_too_large", elapsed, true);
      if (fault.code === "unsupported_content_type" || fault.code === "unsupported_content_encoding")
        return notMeasured(normalized, at, fault.code, elapsed, true);
      if (fault.retryable && attempt < SITE_FETCH_LIMITS.retries) {
        attempt++;
        await (options.wait ?? ((ms: number) => new Promise((resolve) => setTimeout(resolve, ms))))(1000);
        continue;
      }
      return notMeasured(normalized, at, fault.code, elapsed, true);
    }
  }
}
