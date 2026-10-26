"use server";

import { headers } from "next/headers";

import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { audit, isServiceRoleConfigured } from "@/lib/audit";
import { sessionAal } from "@/lib/auth/server";
import { generateRecoveryCodes, hashRecoveryCode } from "@/lib/auth/recovery-codes";

export type RegenerateRecoveryCodesResult =
  | { ok: true; recovery_codes: string[] }
  | {
      ok: false;
      error: "unauthenticated" | "mfa_not_enrolled" | "mfa_required" | "service_unavailable" | "storage_failed";
    };

/**
 * Deletes existing user_recovery_codes for the current user and issues 10
 * fresh codes. Plaintext returned ONCE — never persisted.
 */
export async function regenerateRecoveryCodes(): Promise<RegenerateRecoveryCodesResult> {
  const supabase = await createClient();
  const hdrs = await headers();
  const requestId = hdrs.get("x-request-id");
  const ip = hdrs.get("x-forwarded-for")?.split(",")[0]?.trim() ?? null;
  const userAgent = hdrs.get("user-agent") ?? null;

  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { ok: false, error: "unauthenticated" };

  // Confirm user has a verified TOTP factor (regenerate is meaningless otherwise).
  const { data: factors } = await supabase.auth.mfa.listFactors();
  const hasFactor = factors?.totp?.some((f) => f.status === "verified");
  if (!hasFactor) return { ok: false, error: "mfa_not_enrolled" };

  // Cadastro do fator e prova do fator são condições diferentes. A troca dos
  // códigos invalida os anteriores, então a sessão precisa provar AAL2 agora.
  if ((await sessionAal()) !== "aal2") return { ok: false, error: "mfa_required" };

  // Recovery codes são segredos de autenticação. Eles só podem ser gravados
  // pelo servidor com service role; nunca fazemos fallback para o client da
  // sessão, que tem acesso PostgREST e será bloqueado no ACL da tabela.
  if (!isServiceRoleConfigured()) return { ok: false, error: "service_unavailable" };

  const codes = generateRecoveryCodes();
  const rows = codes.map((c) => ({ user_id: user.id, code_hash: hashRecoveryCode(c) }));

  // Delete + insert with the privileged server client only. Return no plaintext
  // unless both operations complete successfully.
  try {
    const admin = createAdminClient();
    const d = await admin.from("user_recovery_codes").delete().eq("user_id", user.id);
    if (d.error) return { ok: false, error: "storage_failed" };
    const ins = await admin.from("user_recovery_codes").insert(rows);
    if (ins.error) return { ok: false, error: "storage_failed" };
  } catch {
    return { ok: false, error: "storage_failed" };
  }

  await audit({
    action: "mfa.recovery_codes_regenerated",
    actorUserId: user.id,
    resourceType: "user",
    resourceId: user.id,
    requestId,
    ip,
    userAgent,
    metadata: { count: codes.length },
  });

  return { ok: true, recovery_codes: codes };
}
