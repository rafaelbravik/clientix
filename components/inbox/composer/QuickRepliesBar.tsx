"use client";

import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { useT } from "@/hooks/i18n/useT";
import type { MessageTemplate } from "@/hooks/inbox/useMessageTemplates";
import {
  lerBarraExpandida,
  respostasMostradas,
  salvarBarraExpandida,
} from "@/lib/inbox/barra-de-respostas";

interface Props {
  userId: string | null;
  templates: MessageTemplate[];
  disabled: boolean;
  onPick: (template: MessageTemplate) => void;
}

export function QuickRepliesBar({ userId, templates, disabled, onPick }: Props) {
  const t = useT();
  const [preference, setPreference] = useState<{ userId: string | null; expanded: boolean }>({
    userId: null,
    expanded: false,
  });

  useEffect(() => {
    setPreference({ userId, expanded: lerBarraExpandida(userId) });
  }, [userId]);

  const expanded = preference.userId === userId && preference.expanded;
  const { visiveis, restantes } = respostasMostradas(templates, expanded);
  if (visiveis.length === 0) return null;

  function toggle() {
    const next = !expanded;
    salvarBarraExpandida(userId, next);
    setPreference({ userId, expanded: next });
  }

  return (
    <div
      className="mb-2 flex min-w-0 flex-wrap items-center gap-1.5"
      role="toolbar"
      aria-label={t("Respostas rápidas do Inbox")}
      data-testid="quick-replies-bar"
    >
      {visiveis.map((template) => (
        <Button
          key={template.id}
          type="button"
          size="sm"
          variant="outline"
          className="h-8 max-w-40 min-w-0 px-2 text-xs"
          title={template.title}
          aria-label={template.title}
          disabled={disabled}
          onClick={() => onPick(template)}
        >
          <span className="truncate">{template.title}</span>
        </Button>
      ))}
      {(restantes > 0 || expanded) && (
        <Button
          type="button"
          size="sm"
          variant="ghost"
          className="h-8 px-2 text-xs"
          aria-expanded={expanded}
          onClick={toggle}
        >
          {expanded ? t("Menos respostas") : `${t("Mais respostas")} (${restantes})`}
        </Button>
      )}
    </div>
  );
}
