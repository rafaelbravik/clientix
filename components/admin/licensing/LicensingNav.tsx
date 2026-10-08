"use client";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { cn } from "@/lib/utils";

const TABS = [
  { href: "/admin/licensing/licenses", label: "Licenças" },
  { href: "/admin/licensing/customers", label: "Clientes" },
  { href: "/admin/licensing/installations", label: "Instalações" },
  { href: "/admin/licensing/audit", label: "Auditoria" },
];

export function LicensingNav() {
  const pathname = usePathname();

  return (
    <div className="flex border-b border-border space-x-6 mb-6">
      {TABS.map((tab) => {
        const isActive = pathname.startsWith(tab.href);
        return (
          <Link
            key={tab.href}
            href={tab.href}
            className={cn(
              "pb-3 text-sm font-medium transition-colors border-b-2 -mb-[2px]",
              isActive
                ? "border-primary text-foreground font-semibold"
                : "border-transparent text-muted-foreground hover:text-foreground"
            )}
          >
            {tab.label}
          </Link>
        );
      })}
    </div>
  );
}
