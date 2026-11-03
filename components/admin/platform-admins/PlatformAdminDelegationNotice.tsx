import { Info } from "@/lib/ui/icons";
import { useT } from "@/hooks/i18n/useT";

export function PlatformAdminDelegationNotice() {
  const t = useT();
  return (
    <div
      role="note"
      className="flex gap-3 rounded-lg border border-blue-200 bg-blue-50 p-4 text-blue-900"
    >
      <Info size={20} className="mt-0.5 shrink-0 text-blue-600" aria-hidden />
      <p className="text-sm leading-relaxed text-blue-800">
        {t("O proprietário global pode conceder ou revogar grants de administrador por operação auditada. Criar, recuperar ou transferir a propriedade global continua sujeito ao procedimento administrativo documentado.")}
      </p>
    </div>
  );
}
