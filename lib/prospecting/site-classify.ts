import { normalizedSiteUrl } from "./site-url";

export const SITE_CLASSES = [
  "agregador",
  "sem-site",
  "site-ok",
  "site-ruim",
  "ssl-invalido",
  "fora-do-ar",
  "nao-medido",
] as const;
export type SiteClass = (typeof SITE_CLASSES)[number];

export const AGGREGATOR_HOSTS = [
  "instagram.com",
  "facebook.com",
  "whatsapp.com",
  "linktr.ee",
  "linkr.bio",
  "linkbio.co",
  "lnk.bio",
  "bio.link",
  "bio.site",
  "beacons.ai",
  "msha.ke",
  "snipfeed.co",
  "linkpop.com",
  "allmylinks.com",
  "solo.to",
  "campsite.bio",
  "carrd.co",
  "forms.gle",
  "typeform.com",
  "jotform.com",
  "forms.office.com",
  "tally.so",
  "api.whatsapp.com",
  "wa.me",
] as const;

export interface SiteFacts {
  trust: "UNTRUSTED_EXTERNAL_CONTENT";
  title: string | null;
  description: string | null;
  headings: string[];
  visible_text_length: number;
}

export interface SiteAuditResult {
  ver: 1;
  classe: SiteClass;
  status: "checked" | "not_measured" | "no_site" | "aggregator";
  provisorio: boolean;
  citavel: boolean;
  /** Trust boundary for all externally derived `facts` and `resumo`. */
  external_content_trust: "UNTRUSTED_EXTERNAL_CONTENT" | null;
  verificado_em: string;
  url: string | null;
  final_url: string | null;
  http_status: number | null;
  tempo_ms: number;
  https_disponivel: boolean | null;
  tls_valido: boolean | null;
  mobile_hint: boolean | null;
  empty_hint: boolean | null;
  builder_hint: string | null;
  motivo: string | null;
  facts: SiteFacts | null;
  resumo: string | null;
  /** A transient recheck is retained separately from an earlier definitive verdict. */
  ultima_tentativa?: Omit<SiteAuditResult, "ultima_tentativa">;
}

function hostFrom(raw: string | null | undefined): string | null {
  if (!raw?.trim()) return null;
  try {
    const value = raw.trim();
    const url = new URL(/^[a-z][a-z\d+.-]*:/i.test(value) ? value : `https://${value}`);
    if ((url.protocol !== "http:" && url.protocol !== "https:") || url.username || url.password)
      return null;
    return url.hostname.toLowerCase().replace(/^www\./, "");
  } catch {
    return null;
  }
}

export function isGoogleMapsUrl(raw: string): boolean {
  try {
    const url = new URL(raw);
    const host = url.hostname.toLowerCase().replace(/^www\./, "");
    return (
      host === "maps.google.com" ||
      host === "maps.app.goo.gl" ||
      host === "goo.gl" && /(^|\/)maps(?:\/|$)/i.test(url.pathname) ||
      /^google\.[a-z.]+$/.test(host) && /(^|\/)maps(?:\/|$)/i.test(url.pathname) ||
      host === "google.com" && /(^|\/)maps(?:\/|$)/i.test(url.pathname)
    );
  } catch {
    return false;
  }
}

export function isSiteAggregator(raw: string | null | undefined): boolean {
  if (!raw?.trim()) return false;
  if (isGoogleMapsUrl(raw)) return true;
  const host = hostFrom(raw);
  return !host || AGGREGATOR_HOSTS.some((domain) => host === domain || host.endsWith(`.${domain}`));
}

function baseResult(classe: SiteClass, status: SiteAuditResult["status"], at: string, url: string | null): SiteAuditResult {
  return {
    ver: 1,
    classe,
    status,
    provisorio: false,
    citavel: classe !== "nao-medido",
    external_content_trust: null,
    verificado_em: at,
    url,
    final_url: null,
    http_status: null,
    tempo_ms: 0,
    https_disponivel: null,
    tls_valido: null,
    mobile_hint: null,
    empty_hint: null,
    builder_hint: null,
    motivo: null,
    facts: null,
    resumo: null,
  };
}

export function siteWithoutFetch(raw: string | null | undefined, at: string): SiteAuditResult | null {
  if (!raw?.trim()) {
    const result = baseResult("sem-site", "no_site", at, null);
    result.motivo = "website_absent";
    return result;
  }
  const url = normalizedSiteUrl(raw);
  if (!url) {
    const result = baseResult("nao-medido", "not_measured", at, null);
    result.provisorio = true;
    result.citavel = false;
    result.motivo = "invalid_url";
    return result;
  }
  if (isSiteAggregator(url)) {
    const result = baseResult("agregador", "aggregator", at, url);
    result.motivo = isGoogleMapsUrl(url) ? "google_maps_is_not_business_website" : "known_aggregator";
    return result;
  }
  return null;
}

function decodeEntities(value: string): string {
  const named: Record<string, string> = {
    amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", copy: "©", reg: "®",
  };
  return value.replace(/&(#x[\da-f]+|#\d+|[a-z]+);/gi, (match, entity: string) => {
    if (entity[0] === "#") {
      const hex = entity[1]?.toLowerCase() === "x";
      const number = Number.parseInt(entity.slice(hex ? 2 : 1), hex ? 16 : 10);
      return Number.isFinite(number) && number > 0 && number <= 0x10ffff ? String.fromCodePoint(number) : "";
    }
    return named[entity.toLowerCase()] ?? match;
  });
}

function stripUnsafeBlocks(html: string): string {
  return html
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<(script|style|noscript|iframe|svg|template)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, " ")
    .replace(/<(script|style|noscript|iframe|svg|template)\b[^>]*\/?\s*>/gi, " ")
    .replace(/\s+on[a-z][\w:-]*\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/gi, " ")
    .replace(/\s+(?:src|href)\s*=\s*(["'])\s*(?:javascript|data):[\s\S]*?\1/gi, " ");
}

function plainText(html: string): string {
  return decodeEntities(stripUnsafeBlocks(html).replace(/<[^>]*>/g, " "))
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function attribute(tag: string, name: string): string | null {
  const pattern = new RegExp(`\\b${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, "i");
  const match = pattern.exec(tag);
  return decodeEntities(match?.[1] ?? match?.[2] ?? match?.[3] ?? "").trim() || null;
}

function metaContent(html: string, name: string): string | null {
  for (const match of html.matchAll(/<meta\b[^>]*>/gi)) {
    const tag = match[0];
    const key = attribute(tag, "name") ?? attribute(tag, "property");
    if (key?.toLowerCase() === name.toLowerCase()) return attribute(tag, "content")?.slice(0, 300) ?? null;
  }
  return null;
}

const BUILDERS: ReadonlyArray<readonly [string, RegExp]> = [
  ["Wix", /wixsite\.com|static\.wixstatic\.com|static\.parastorage\.com|generator["']?\s+content=["']wix/i],
  ["Google Sites", /sites\.google\.com/i],
  ["WordPress.com", /wordpress\.com/i],
  ["Canva", /canva\.site|websitebuilder/i],
  ["Webnode", /webnode\.(?:page|com\.br)/i],
];

export function extractSiteFacts(html: string, urlFinal: string): SiteFacts {
  void urlFinal;
  const safeSource = stripUnsafeBlocks(html);
  const titleTag = /<title\b[^>]*>([\s\S]*?)<\/title\s*>/i.exec(safeSource)?.[1] ?? "";
  const title = plainText(titleTag).slice(0, 200) || null;
  const description = metaContent(safeSource, "description");
  const headings = [...safeSource.matchAll(/<h[12]\b[^>]*>([\s\S]*?)<\/h[12]\s*>/gi)]
    .slice(0, 6)
    .map((match) => plainText(match[1] ?? "").slice(0, 160))
    .filter(Boolean);
  const visibleTextLength = plainText(safeSource).length;
  return {
    trust: "UNTRUSTED_EXTERNAL_CONTENT",
    title,
    description,
    headings,
    visible_text_length: visibleTextLength,
  };
}

export function extractSiteSummary(html: string): string | null {
  return plainText(stripUnsafeBlocks(html)).slice(0, 1_200) || null;
}

export function builderHint(urlFinal: string, html: string): string | null {
  return BUILDERS.find(([, signature]) => signature.test(urlFinal) || signature.test(html))?.[0] ?? null;
}

export function classifyMeasuredSite(input: {
  status: number;
  urlFinal: string;
  elapsedMs: number;
  html: string;
  facts: SiteFacts;
  httpsAvailable?: boolean | null;
  minimumHtmlBytes?: number;
}): { classe: SiteClass; motivo: string | null; mobileHint: boolean; emptyHint: boolean; builder: string | null } {
  const blocked = new Set([401, 403, 406, 429, 451, 503]);
  if (blocked.has(input.status))
    return { classe: "nao-medido", motivo: `measurement_blocked_http_${input.status}`, mobileHint: false, emptyHint: false, builder: null };
  if (input.status >= 400)
    return { classe: "site-ruim", motivo: `http_${input.status}`, mobileHint: false, emptyHint: false, builder: null };
  const mobileHint = /<meta\b[^>]*name\s*=\s*(["'])viewport\1/i.test(stripUnsafeBlocks(input.html));
  const emptyHint = input.html.trim().length < (input.minimumHtmlBytes ?? 800);
  const builder = builderHint(input.urlFinal, input.html);
  const mixedContent = /\s(?:src|href)\s*=\s*(["'])http:\/\//i.test(stripUnsafeBlocks(input.html));
  const issues = [
    !input.urlFinal.toLowerCase().startsWith("https:")
      ? input.httpsAvailable === true
        ? "http_no_redirect"
        : input.httpsAvailable === false
          ? "https_unavailable"
          : "https_measurement_incomplete"
      : null,
    !mobileHint ? "viewport_missing" : null,
    emptyHint ? "page_almost_empty" : null,
    input.elapsedMs > 5000 ? "slow_response" : null,
    builder ? "site_builder_detected" : null,
    mixedContent ? "mixed_content" : null,
  ].filter(Boolean);
  return {
    classe: issues.length ? "site-ruim" : "site-ok",
    motivo: issues[0] ?? null,
    mobileHint,
    emptyHint,
    builder,
  };
}
