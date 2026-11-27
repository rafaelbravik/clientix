import { requirePlatformOwnerEscrita } from "@/lib/auth/requirePlatformAdmin";
import {
  EscritaDePlatformAdminNegada,
  type RecusaDeEscritaDeAdmin,
} from "@/lib/auth/recusa-de-escrita-de-admin";

/** Guard de escrita global restrito ao dono, com resposta segura para Server Actions. */
export async function escritaDeOwnerOuRecusa(): Promise<
  | { ok: true; ctx: Awaited<ReturnType<typeof requirePlatformOwnerEscrita>> }
  | RecusaDeEscritaDeAdmin
> {
  try {
    return { ok: true, ctx: await requirePlatformOwnerEscrita() };
  } catch (err) {
    if (err instanceof EscritaDePlatformAdminNegada) return { ok: false, error: err.code };
    throw err;
  }
}
