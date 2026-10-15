/** Customer builds have no support context, so the read-only mode is unreachable. */
export function isSupportReadonly(_support: unknown): boolean {
  return false;
}

export function supportRole(_support: unknown): "admin" | "viewer" {
  return "viewer";
}
