import { PlatformAdminsClient } from "./_client";
import { requirePlatformAdmin } from "@/lib/auth/requirePlatformAdmin";

export const metadata = { title: "Platform Admins — Admin Plataforma" };

export default async function AdminPlatformAdminsPage() {
  const { platformAdmin } = await requirePlatformAdmin();
  return <PlatformAdminsClient canManage={platformAdmin.platform_role === "owner"} />;
}
