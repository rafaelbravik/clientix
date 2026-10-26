"use server";

import { headers } from "next/headers";
import { redirect } from "next/navigation";

import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { audit, isServiceRoleConfigured } from "@/lib/audit";
import { generateRecoveryCodes, hashRecoveryCode } from "@/lib/auth/recovery-codes";

export type ConfirmMfaEnrollResult =
  | { ok: true; recovery_codes: string[] }
  | {
      ok: false;
      error: "invalid_code" | "challenge_failed" | "verify_failed" | "service_unavailable" | "storage_failed";
      message?: string;
    };

/**
 * Confirms a TOTP enrollment by issuing a challenge + verifying the code, then
 * generates 10 single-use recovery codes (sha256-hashed, stored as bytea).
 *
 * Recovery codes are returned ONCE to the caller for display — never stored
 * plaintext. Caller is responsible for showing them to the user with copy /
 * download / acknowledge UX.
 */
export async function confirmMfaEnroll(
  code: string,
  factorId: string,
): Promise<ConfirmMfaEnrollResult> {
  const supabase = await createClient();
  const hdrs = await headers();
  const requestId = hdrs.get("x-request-id");
  const ip = hdrs.get("x-forwarded-for")?.split(",")[0]?.trim() ?? null;
  const userAgent = hdrs.get("user-agent") ?? null;

  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  if (!/^\d{6}$/.test(code)) {
    return { ok: false, error: "invalid_code" };
  }

  // Códigos de recuperação são gravados somente pelo servidor. Se a chave
  // privilegiada não estiver configurada, não confirmamos o enrollment nem
  // devolvemos códigos que não poderiam ser usados depois.
  if (!isServiceRoleConfigured()) return { ok: false, error: "service_unavailable" };

  const { data: challenge, error: challengeErr } = await supabase.auth.mfa.challenge({
    factorId,
  });
  if (challengeErr || !challenge) {
    return { ok: false, error: "challenge_failed", message: challengeErr?.message };
  }

  const { error: verifyErr } = await supabase.auth.mfa.verify({
    factorId,
    challengeId: challenge.id,
    code,
  });
  if (verifyErr) {
    return { ok: false, error: "verify_failed", message: verifyErr.message };
  }

  // Generate + hash 10 recovery codes.
  const codes = generateRecoveryCodes();
  const rows = codes.map((c) => ({
    user_id: user.id,
    code_hash: hashRecoveryCode(c),
  }));

  // Recovery code hashes are not writable through the authenticated client.
  // The table ACL grants this operation only to the server's service role.
  try {
    const admin = createAdminClient();
    const { error } = await admin.from("user_recovery_codes").insert(rows);
    if (error) return { ok: false, error: "storage_failed" };
  } catch {
    return { ok: false, error: "storage_failed" };
  }

  await audit({
    action: "auth.mfa_enrolled",
    actorUserId: user.id,
    metadata: { recovery_codes_generated: codes.length },
    requestId,
    ip,
    userAgent,
  });

  return { ok: true, recovery_codes: codes };
}
