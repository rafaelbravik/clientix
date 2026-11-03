import { requirePlatformAdmin } from "@/lib/auth/requirePlatformAdmin";
import { createAdminClient } from "@/lib/supabase/admin";
import type { SupabaseClient } from "@supabase/supabase-js";
import { PlatformPlansClient, type PlatformPlan } from "./_client";
import { idiomaDoVisitante } from "@/lib/i18n/idiomaAnonimo";
import { traduzir } from "@/lib/i18n/dicionario";

export const metadata = { title: "Planos — Admin Plataforma" };

export default async function PlatformPlansPage() {
  const idioma = await idiomaDoVisitante(null);
  const t = (texto: string) => traduzir(texto, idioma);
  const { platformAdmin } = await requirePlatformAdmin();
  const admin = createAdminClient() as unknown as SupabaseClient;
  const { data, error } = await admin
    .from("platform_plan_catalog")
    .select("slug, name, active, max_users, max_channels, allowed_channels, features, updated_at")
    .order("slug", { ascending: true });

  if (error || !data) {
    return (
      <section className="rounded-lg border border-destructive/30 bg-destructive/5 p-6" role="alert">
        <h1 className="text-xl font-semibold">{t("Planos indisponíveis")}</h1>
        <p className="mt-2 text-sm text-muted-foreground">{t("Não foi possível carregar o catálogo de planos. Verifique a migration 9062 e tente novamente.")}</p>
      </section>
    );
  }

  return (
    <PlatformPlansClient
      initialPlans={data as unknown as PlatformPlan[]}
      canEdit={platformAdmin.platform_role === "owner"}
    />
  );
}
