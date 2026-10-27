import { redirect } from "next/navigation";

import { requireAuth, resolveActiveOrg } from "@/lib/auth/server";
import { ROLE_RANK, escreveComoPlatformAdmin } from "@/lib/auth/types";
import { supportWriteError } from "@/lib/impersonate/support";
import { traduzir } from "@/lib/i18n/dicionario";
import { CASE_WAIT_REMINDER_DEFAULTS, normalizarCaseWaitReminderConfig } from "@/lib/cases/case-wait-reminders";
import { createAdminClient } from "@/lib/supabase/admin";
import { AgentInboxList } from "./_components/AgentInboxList";
import { LembreteDeCasoParado } from "./_components/LembreteDeCasoParado";

export const dynamic = "force-dynamic";

export default async function AgentInboxPage() {
  const user = await requireAuth();
  const activeOrg = await resolveActiveOrg(user);
  if (!activeOrg) redirect("/app");
  const canResolve = ROLE_RANK[activeOrg.role] >= ROLE_RANK.agent;
  const canConfigureReminders = !supportWriteError(user.support) &&
    ((escreveComoPlatformAdmin(user) && !user.support) || ROLE_RANK[activeOrg.role] >= ROLE_RANK.admin);
  const idioma = user.idioma;
  let reminderConfig = CASE_WAIT_REMINDER_DEFAULTS;
  if (canConfigureReminders) {
    const { data } = await createAdminClient()
      .from("organizations")
      .select("settings")
      .eq("id", activeOrg.orgId)
      .maybeSingle();
    const settings = data?.settings && typeof data.settings === "object" && !Array.isArray(data.settings)
      ? data.settings as Record<string, unknown>
      : {};
    reminderConfig = normalizarCaseWaitReminderConfig(settings.case_wait_reminders);
  }

  return (
    <div className="flex h-full flex-col gap-6 p-6">
      <header>
        <h1 className="text-2xl font-semibold tracking-tight">{traduzir("Central de avisos", idioma)}</h1>
        <p className="text-sm text-muted-foreground">
          {traduzir(
            "O que o assistente precisou escalar para o time: conexões caídas, tarefas que falharam, atendimentos passados a humanos.",
            idioma,
          )}
        </p>
      </header>
      {canConfigureReminders ? <LembreteDeCasoParado config={reminderConfig} /> : null}
      <AgentInboxList canResolve={canResolve} />
    </div>
  );
}
