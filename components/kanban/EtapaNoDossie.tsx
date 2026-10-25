"use client";

import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useT } from "@/hooks/i18n/useT";
import type { Stage } from "@/lib/kanban/types";

interface Props {
  etapaAtualId: string;
  etapas: Stage[];
  aoMudar: (stageId: string) => void;
  disabled?: boolean;
}

/** Controle de apresentação. A autorização e as regras de movimento ficam na pipeline. */
export function EtapaNoDossie({ etapaAtualId, etapas, aoMudar, disabled = false }: Props) {
  const t = useT();
  const validas = [...etapas]
    .filter((etapa) => !etapa.is_archived)
    .sort((a, b) => a.position - b.position);
  const atual = validas.find((etapa) => etapa.id === etapaAtualId);

  if (!atual) return <span className="text-text-muted">{t("Etapa indisponível")}</span>;

  return (
    <Select
      value={etapaAtualId}
      disabled={disabled}
      onValueChange={(destino) => {
        if (destino !== etapaAtualId && validas.some((etapa) => etapa.id === destino)) {
          aoMudar(destino);
        }
      }}
    >
      <SelectTrigger
        aria-label={t("Etapa do funil")}
        className="h-auto min-h-7 w-auto max-w-full gap-2 border-0 px-1.5 py-1 text-xs text-text-muted shadow-none"
      >
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {validas.map((etapa) => (
          <SelectItem key={etapa.id} value={etapa.id}>
            {etapa.name}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}
