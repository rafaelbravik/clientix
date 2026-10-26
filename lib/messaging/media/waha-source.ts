/**
 * MediaSource do WAHA: baixa o binário hospedado pelo container WAHA.
 *
 * A URL anunciada no webhook NÃO é confiável nem correta: o HMAC é
 * best-effort (payload forjado é possível) e o WAHA anuncia seu endereço
 * INTERNO (ex.: localhost:3000 dentro do container, mapeado p/ 3030 no
 * host). Por isso o fetch é SEMPRE reconstruído sobre WAHA_API_BASE_URL,
 * aproveitando apenas path+query da URL anunciada — SSRF impossível por
 * construção (o host nunca vem do payload). A futura MetaMediaSource
 * implementa a mesma assinatura baixando via media_id + Graph API.
 */
import {
  MAX_MEDIA_BYTES,
  MediaTooLargeError,
  type FetchedMedia,
} from "@/lib/messaging/media/types";

const FETCH_TIMEOUT_MS = 30_000;

export async function fetchWahaMedia(
  mediaUrl: string,
  hintMime?: string | null,
): Promise<FetchedMedia> {
  const base = process.env.WAHA_API_BASE_URL;
  let url: URL;
  try {
    const advertised = new URL(mediaUrl);
    const baseUrl = new URL(base ?? "");
    const decodedPath = decodeURIComponent(advertised.pathname);
    // WAHA media must stay on its file endpoint. Restricting the path matters
    // because this request carries the configured API key to the WAHA origin.
    if (
      !["http:", "https:"].includes(baseUrl.protocol)
      || !decodedPath.startsWith("/api/files/")
      || /%2f|%5c/i.test(advertised.pathname)
      || decodedPath.split("/").some((segment) => segment === "." || segment === "..")
      || decodedPath.includes("\\")
      || advertised.username
      || advertised.password
    ) throw new Error("invalid media path");
    // Host is discarded; only a validated file path and its provider query
    // survive, resolved against the configured WAHA origin.
    url = new URL(advertised.pathname + advertised.search, baseUrl);
    if (url.origin !== baseUrl.origin) throw new Error("invalid media origin");
  } catch {
    throw new Error("waha_media_untrusted_host");
  }

  const apiKey = process.env.WAHA_API_KEY;
  const res = await fetch(url.toString(), {
    headers: apiKey ? { "X-Api-Key": apiKey } : {},
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    redirect: "error",
  });
  if (!res.ok) throw new Error(`waha_media_${res.status}`);

  const declared = Number(res.headers.get("content-length") ?? 0);
  if (declared > MAX_MEDIA_BYTES) throw new MediaTooLargeError();

  const buffer = Buffer.from(await res.arrayBuffer());
  if (buffer.byteLength > MAX_MEDIA_BYTES) throw new MediaTooLargeError();

  const mime = res.headers.get("content-type") || hintMime || "application/octet-stream";
  return { buffer, mime };
}
