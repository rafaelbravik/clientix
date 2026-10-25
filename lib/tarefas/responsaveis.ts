import { createAdminClient } from "@/lib/supabase/admin";
import { isServiceRoleConfigured } from "@/lib/audit";

export type ResultadoDaValidacaoDeResponsavel = "valido" | "membro_inexistente" | "indisponivel";

/**
 * Confirma que o responsável pertence à organização ativa e não foi revogado.
 * O ator vem de `requireRole`; não há organização nem identidade confiada ao body.
 */
export async function validarResponsavelDaTarefa(
  organizationId: string,
  userId: string,
  actorUserId: string,
): Promise<ResultadoDaValidacaoDeResponsavel> {
  // `requireRole` já provou a membership da identidade autenticada.
  if (userId === actorUserId) return "valido";
  if (!isServiceRoleConfigured()) return "indisponivel";

  try {
    const { data, error } = await createAdminClient()
      .from("user_organizations")
      .select("user_id")
      .eq("organization_id", organizationId)
      .eq("user_id", userId)
      .is("revoked_at", null)
      .maybeSingle();
    if (error) return "indisponivel";
    return data ? "valido" : "membro_inexistente";
  } catch {
    return "indisponivel";
  }
}

/**
 * Nomes mínimos para as linhas de tarefa. Só enriquece identidades que ainda
 * são membros da organização; nunca devolve e-mail ou ID na apresentação.
 */
export async function nomesDosResponsaveisDaTarefa(
  organizationId: string,
  userIds: readonly (string | null | undefined)[],
  actor?: { id: string; fullName: string | null },
): Promise<Map<string, string>> {
  const ids = [...new Set(userIds.filter((id): id is string => Boolean(id)))];
  const nomes = new Map<string, string>();
  if (actor?.fullName?.trim() && ids.includes(actor.id)) {
    nomes.set(actor.id, actor.fullName.trim().slice(0, 120));
  }
  if (!isServiceRoleConfigured() || ids.length === 0) return nomes;

  try {
    const admin = createAdminClient();
    const { data: rows, error } = await admin
      .from("user_organizations")
      .select("user_id")
      .eq("organization_id", organizationId)
      .in("user_id", ids)
      .is("revoked_at", null);
    if (error) return nomes;

    const membros = (rows ?? []) as Array<{ user_id: string }>;
    await Promise.all(
      membros.map(async ({ user_id }) => {
        if (nomes.has(user_id)) return;
        const { data } = await admin.auth.admin.getUserById(user_id);
        const nome = data?.user?.user_metadata?.full_name;
        if (typeof nome === "string" && nome.trim()) nomes.set(user_id, nome.trim().slice(0, 120));
      }),
    );
  } catch {
    // Nome ausente é apresentação degradada, não deve ocultar tarefa acessível.
  }
  return nomes;
}
