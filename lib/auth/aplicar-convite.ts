import { cookies } from "next/headers";

import { audit } from "@/lib/audit";
import { cookieSecure } from "@/lib/supabase/cookie-secure";
import { createAdminClient } from "@/lib/supabase/admin";
import type { InvitePayload } from "@/lib/auth/invite-token";

/**
 * O ATO de virar membro: grava o vínculo, audita e escolhe a organização ativa.
 *
 * Existe separado porque tem DOIS chamadores legítimos, e antes só havia um:
 *
 * - `app/actions/team/acceptInvite.ts` — quem já tinha conta e clicou no botão;
 * - `app/auth/confirm/route.ts` — quem acabou de confirmar o e-mail por um
 *   convite. Esse caminho conhecia o convite, tinha a sessão firmada e o e-mail
 *   provado pelo provedor de auth, e mesmo assim só redirecionava para uma tela
 *   com um botão. O vínculo é o que dá menu e organização; sem ele a pessoa
 *   entra num CRM vazio, e essa foi a experiência medida de dois convidados
 *   reais.
 *
 * A VALIDADE DO TOKEN não se decide aqui — quem decide é quem chama, e os dois
 * chamam `verifyInviteToken` antes (o segundo por dentro de
 * `decidirConviteDoSignup`, que ainda confere o e-mail contra o que o provedor
 * confirmou).
 *
 * A LINHA DE `team_invites` (migration 0238), sim, é tratada aqui — e precisa
 * ser, nos dois sentidos:
 *
 * - **Revogação.** Um convite cancelado na tela de Equipe mantém assinatura e
 *   validade boas no token; o que diz que ele morreu é a linha. Deixar essa
 *   checagem no botão de aceite (onde ela nasceu, no PR #664) daria acesso a
 *   um convite revogado a quem chegasse pelo OUTRO caminho — confirmar o
 *   e-mail —, que é justamente o caminho de quem ainda não tem conta, ou seja,
 *   o caso comum.
 * - **Fechamento.** `fn_accept_team_invite_atomic` fecha a linha na MESMA transação
 *   que cria o vínculo. Além de evitar convites aceitos listados como pendentes,
 *   isto converte o assento reservado sem contar a mesma pessoa duas vezes.
 *
 * Convite sem linha (emitido antes desta migration, ou instalação cujo envio
 * não tinha service-role) segue o fluxo: a checagem de revogação de MEMBERSHIP
 * dentro de `fn_accept_team_invite_atomic` continua valendo.
 */

export type ResultadoDoConvite =
  | { ok: true; membershipId: string; mudou: boolean }
  | { ok: false; motivo: "invalid_or_expired" | "internal_error" };

export async function aplicarConvite(params: {
  userId: string;
  payload: InvitePayload;
  requestId?: string | null;
}): Promise<ResultadoDoConvite> {
  const { userId, payload, requestId } = params;

  const admin = createAdminClient();

  // Convite REVOGADO na tela de Equipe. Sem linha, segue — ver o cabeçalho.
  const { data: linhaDoConvite } = await admin
    .from("team_invites")
    .select("revoked_at")
    .eq("id", payload.invite_id)
    .eq("organization_id", payload.organization_id)
    .maybeSingle();
  if (linhaDoConvite?.revoked_at) return { ok: false, motivo: "invalid_or_expired" };

  // Org, papel e convidador vêm EXCLUSIVAMENTE do token assinado; o usuário,
  // de quem chamou. Nada aqui vem de body de requisição.
  const { data: resultado, error } = await admin.rpc("fn_accept_team_invite_atomic", {
    p_interface_settings: payload.interface_settings ?? { preset: "completa" },
    p_user: userId,
    p_org: payload.organization_id,
    p_role: payload.role,
    p_invited_by: payload.invited_by ?? null,
    p_issued_at: payload.iat ? new Date(payload.iat * 1000).toISOString() : null,
    p_invited_at: new Date((payload.iat ?? payload.exp - 86400) * 1000).toISOString(),
    p_invite_id: payload.invite_id,
  });

  if (error) {
    return {
      ok: false,
      // 42501 é a recusa da própria função (convite revogado ou posterior à
      // revogação) — não é falha de infraestrutura e não merece 500.
      motivo: error.code === "42501" ? "invalid_or_expired" : "internal_error",
    };
  }

  if (resultado.changed) {
    await audit({
      action: "member.accepted",
      actorUserId: userId,
      organizationId: payload.organization_id,
      resourceType: "membership",
      resourceId: resultado.id,
      metadata: { invite_id: payload.invite_id, role: payload.role },
      requestId: requestId ?? null,
    });
  }

  // Sem isto a pessoa entra sem organização escolhida e o app não sabe qual
  // mostrar — o mesmo motivo pelo qual o botão de aceite sempre gravou aqui.
  (await cookies()).set("active_org", payload.organization_id, {
    httpOnly: true,
    sameSite: "strict",
    secure: cookieSecure(),
    path: "/",
    maxAge: 60 * 60 * 24 * 30,
  });

  return { ok: true, membershipId: resultado.id as string, mudou: Boolean(resultado.changed) };
}
