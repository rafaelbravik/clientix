import { requirePlatformOwner } from "@/lib/auth/requirePlatformAdmin";
import { OwnerConsole } from "./_owner-console";

export const dynamic = "force-dynamic";
export const metadata = { title: "Proprietário da plataforma" };

export default async function OwnerPage() {
  const { user } = await requirePlatformOwner();

  return (
    <main className="mx-auto min-h-screen w-full max-w-5xl space-y-8 px-4 py-10 sm:px-6">
      <header className="space-y-2">
        <p className="text-sm font-medium text-muted-foreground">{user.email}</p>
        <h1 className="text-3xl font-semibold tracking-tight">Painel do proprietário</h1>
        <p className="max-w-2xl text-sm text-muted-foreground">
          Crie empresas nesta instalação e convide usuários dentro do limite do plano e da licença.
          Gerencie a licença local em{" "}
          <a className="underline" href="/admin/license">
            Licença
          </a>
          .
        </p>
      </header>
      <OwnerConsole ownerEmail={user.email ?? ""} />
    </main>
  );
}
