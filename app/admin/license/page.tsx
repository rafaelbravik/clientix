import Link from "next/link";
import { requirePlatformAdmin } from "@/lib/auth/requirePlatformAdmin";
import { createLicenseAdminSummary } from "@/lib/licensing/admin-view";
import { getInstallationLicenseStatus } from "@/lib/licensing/enforcement";
import { LicenseAdminClient } from "./_client";

export const metadata = { title: "Licença da instalação — Admin" };
export const dynamic = "force-dynamic";

export default async function InstallationLicensePage() {
  await requirePlatformAdmin();
  const status = await getInstallationLicenseStatus();
  return (
    <main className="mx-auto min-h-screen max-w-5xl space-y-6 p-4 sm:p-6">
      <Link
        href="/app/settings"
        className="text-sm text-muted-foreground underline-offset-4 hover:underline"
      >
        Voltar para Configurações
      </Link>
      <LicenseAdminClient initialLicense={createLicenseAdminSummary(status)} />
    </main>
  );
}
