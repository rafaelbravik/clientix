"use client";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { cn } from "@/lib/utils";
import { useT } from "@/lib/i18n/IdiomaProvider";

const TABS = [
  { href: "/admin/licenses", label: "Licenças" },
  { href: "/admin/customers", label: "Clientes" },
  { href: "/admin/installations", label: "Instalações" },
  { href: "/admin/billing", label: "Cobrança" },
  { href: "/admin/licensing/audit", label: "Auditoria" },
];

export function LicensingNav() {
  const pathname = usePathname();
  const t = useT();

  return (
    <div className="-mx-4 mb-6 overflow-x-auto border-b border-border px-4 sm:mx-0 sm:px-0">
      <div className="flex w-max min-w-full space-x-6">
        {TABS.map((tab) => {
          const isActive =
            pathname === tab.href ||
            pathname.startsWith(`${tab.href}/`) ||
            (tab.href === "/admin/licenses" && pathname.startsWith("/admin/licensing/licenses")) ||
            (tab.href === "/admin/customers" &&
              pathname.startsWith("/admin/licensing/customers")) ||
            (tab.href === "/admin/installations" &&
              pathname.startsWith("/admin/licensing/installations"));
          return (
            <Link
              key={tab.href}
              href={tab.href}
              className={cn(
                "-mb-[2px] shrink-0 border-b-2 pb-3 text-sm font-medium whitespace-nowrap transition-colors",
                isActive
                  ? "border-primary font-semibold text-foreground"
                  : "border-transparent text-muted-foreground hover:text-foreground",
              )}
            >
              {t(tab.label)}
            </Link>
          );
        })}
      </div>
    </div>
  );
}
