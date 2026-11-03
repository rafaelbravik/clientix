import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { SetupWizard } from "./_setup-wizard";
import { createAdminClient } from "@/lib/supabase/admin";
import { idiomaDoVisitante } from "@/lib/i18n/idiomaAnonimo";
import { traduzir } from "@/lib/i18n/dicionario";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Configuração inicial" };

export default async function SetupPage() {
  const idioma = await idiomaDoVisitante(null);
  const t = (texto: string) => traduzir(texto, idioma);
  const { data: initialized, error } = await createAdminClient().rpc("fn_platform_initialized");
  if (!error && initialized === true) redirect("/login?next=%2Fadmin");
  if (error || typeof initialized !== "boolean") {
    return (
      <main className="mx-auto flex min-h-[70vh] w-full max-w-3xl items-center px-4 py-10 sm:px-6">
        <section className="w-full rounded-lg border bg-card p-6 shadow-sm" aria-labelledby="setup-unavailable-title">
          <h1 id="setup-unavailable-title" className="text-xl font-semibold">{t("Não foi possível verificar a instalação")}</h1>
          <p className="mt-2 text-sm text-muted-foreground">{t("O banco não respondeu à consulta de segurança. Tente novamente quando a instalação estiver disponível.")}</p>
          <a className="mt-5 inline-flex h-11 items-center rounded-sm bg-accent px-4 text-sm font-medium text-accent-foreground focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-accent-500" href="/setup">{t("Tentar novamente")}</a>
        </section>
      </main>
    );
  }

  return (
    <main className="mx-auto flex min-h-[70vh] w-full max-w-3xl items-center px-4 py-10 sm:px-6">
      <SetupWizard />
    </main>
  );
}
