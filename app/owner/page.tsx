import { requirePlatformOwner } from "@/lib/auth/requirePlatformAdmin";
import { OwnerConsole } from "./_owner-console";

export const dynamic = "force-dynamic";
export const metadata = { title: "Proprietário da plataforma" };

export default async function OwnerPage() {
  const { user } = await requirePlatformOwner();

  return (
    <main className="mx-auto min-h-screen w-full max-w-5xl space-y-8 px-4 py-10 sm:px-6">
      <OwnerConsole ownerEmail={user.email ?? ""} />
    </main>
  );
}
