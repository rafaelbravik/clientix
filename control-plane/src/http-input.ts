/** Reject cross-origin browser writes to vendor Control Plane routes. */
export function hasSameOrigin(request: Request): boolean {
  const origin = request.headers.get("origin");
  if (!origin) return false;

  // Read dynamically: Next.js freezes direct NEXT_PUBLIC_* references at build time,
  // while this server guard must use the origin configured for the running install.
  const configuredOrigin = process.env["NEXT_PUBLIC_ADMIN_URL"]?.trim();
  if (!configuredOrigin && process.env.NODE_ENV === "production") return false;

  try {
    const expectedOrigin = configuredOrigin || new URL(request.url).origin;
    return new URL(origin).origin === new URL(expectedOrigin).origin;
  } catch {
    return false;
  }
}

export async function readBodyBytesLimited(
  request: Request,
  maxBytes: number,
): Promise<Uint8Array> {
  const contentLength = Number(request.headers.get("content-length"));
  if (Number.isFinite(contentLength) && contentLength > maxBytes)
    throw new Error("REQUEST_BODY_TOO_LARGE");
  if (!request.body) throw new Error("REQUEST_BODY_EMPTY");

  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      totalBytes += value.byteLength;
      if (totalBytes > maxBytes) {
        await reader.cancel();
        throw new Error("REQUEST_BODY_TOO_LARGE");
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  const bytes = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

export async function readJsonBodyLimited(request: Request, maxBytes: number): Promise<unknown> {
  const bytes = await readBodyBytesLimited(request, maxBytes);
  return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as unknown;
}
