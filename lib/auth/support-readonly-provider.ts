import type { SupportContext } from "./support-context";

/** Vendor build: every support mode other than full access is read-only. */
export function isSupportReadonly(support: SupportContext | null | undefined): boolean {
  return Boolean(support && support.access_mode !== "full");
}

export function supportRole(support: SupportContext): "admin" | "viewer" {
  return support.access_mode === "full" ? "admin" : "viewer";
}
