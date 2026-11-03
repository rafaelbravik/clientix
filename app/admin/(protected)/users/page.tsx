import { UsersClient } from "./_client";
import { requirePlatformAdmin } from "@/lib/auth/requirePlatformAdmin";

export const metadata = { title: "Usuários — Admin Plataforma" };

export default async function AdminUsersPage() {
  const { platformAdmin } = await requirePlatformAdmin();
  return <UsersClient canManage={platformAdmin.scope === "full"} canGrantGlobalAdmin={platformAdmin.platform_role === "owner"} />;
}
