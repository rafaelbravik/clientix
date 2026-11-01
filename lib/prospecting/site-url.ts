/** URL helpers that are safe to share with the browser; DNS checks stay server-side. */
function ipv4Octets(value: string): number[] | null {
  const parts = value.split(".");
  if (parts.length !== 4) return null;
  const octets = parts.map((part) => (/^\d{1,3}$/.test(part) ? Number(part) : Number.NaN));
  return octets.every((part) => Number.isInteger(part) && part >= 0 && part <= 255)
    ? octets
    : null;
}

function ipv4IsPublic(value: string): boolean {
  const octets = ipv4Octets(value);
  if (!octets) return false;
  const [a, b, c] = octets as [number, number, number, number];
  if (a === 0 || a === 10 || a === 127 || a >= 224) return false;
  if (a === 100 && b >= 64 && b <= 127) return false;
  if (a === 169 && b === 254) return false;
  if (a === 172 && b >= 16 && b <= 31) return false;
  if (a === 192 && (b === 0 || b === 168)) return false;
  if (a === 192 && b === 88 && c === 99) return false;
  if (a === 198 && (b === 18 || b === 19 || b === 51)) return false;
  if (a === 203 && b === 0 && c === 113) return false;
  return true;
}

function expandIpv6(value: string): number[] | null {
  let source = value.toLowerCase();
  const mappedTail = /:(\d{1,3}(?:\.\d{1,3}){3})$/.exec(source);
  if (mappedTail?.[1]) {
    const octets = ipv4Octets(mappedTail[1]);
    if (!octets) return null;
    const first = ((octets[0]! << 8) | octets[1]!).toString(16);
    const second = ((octets[2]! << 8) | octets[3]!).toString(16);
    source = source.slice(0, mappedTail.index) + `:${first}:${second}`;
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

function ipv6IsPublic(value: string): boolean {
  const groups = expandIpv6(value);
  if (!groups) return false;
  if (groups.slice(0, 5).every((part) => part === 0) && groups[5] === 0xffff) {
    const v4 = `${groups[6]! >> 8}.${groups[6]! & 255}.${groups[7]! >> 8}.${groups[7]! & 255}`;
    return ipv4IsPublic(v4);
  }
  // Only global-unicast 2000::/3 is eligible for an external link. This also
  // rejects loopback, ULA, link-local, multicast, unspecified and reserved space.
  if (groups[0]! < 0x2000 || groups[0]! > 0x3fff) return false;
  if (groups[0] === 0x2001 && groups[1]! <= 0x01ff) return false; // IETF special-purpose range
  if (groups[0] === 0x2001 && groups[1] === 0x0db8) return false; // documentation
  if (groups[0] === 0x2002) return false; // 6to4 embeds an arbitrary IPv4 destination
  return true;
}

/** Blocks private/special IP literals without performing a network lookup. */
export function isPublicIpLiteral(hostname: string): boolean {
  const host = hostname.replace(/^\[|\]$/g, "");
  if (ipv4Octets(host)) return ipv4IsPublic(host);
  if (host.includes(":")) return ipv6IsPublic(host);
  // WHATWG URL canonicalizes abbreviated, octal and hexadecimal IPv4 forms.
  return true;
}

/** Normalize a candidate URL without deciding DNS reachability; the server fetcher does that. */
export function normalizedSiteUrl(raw: string): string | null {
  const value = raw.trim();
  if (!value) return null;
  try {
    const url = new URL(/^[a-z][a-z\d+.-]*:/i.test(value) ? value : `https://${value}`);
    if ((url.protocol !== "http:" && url.protocol !== "https:") || url.username || url.password || !url.hostname)
      return null;
    url.hash = "";
    return url.href.length <= 2000 ? url.href : null;
  } catch {
    return null;
  }
}

export function parsePublicWebsiteUrl(raw: string): URL | null {
  try {
    const normalized = normalizedSiteUrl(raw);
    if (!normalized) return null;
    const url = new URL(normalized);
    if (
      (url.protocol !== "http:" && url.protocol !== "https:") ||
      url.username ||
      url.password ||
      !url.hostname ||
      url.hostname.length > 253 ||
      (url.hostname.includes(":") || ipv4Octets(url.hostname)) && !isPublicIpLiteral(url.hostname)
    )
      return null;
    return url;
  } catch {
    return null;
  }
}
