"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useT } from "@/hooks/i18n/useT";
import { atualizarLembreteDeCasoParado } from "@/app/actions/settings/atualizarLembreteDeCasoParado";
import type { CaseWaitReminderConfig } from "@/lib/cases/case-wait-reminders";

interface Props {
  config: CaseWaitReminderConfig;
}

export function LembreteDeCasoParado({ config }: Props) {
  const t = useT();
  const router = useRouter();
  const [enabled, setEnabled] = useState(config.enabled);
  const [intervalHours, setIntervalHours] = useState(String(config.interval_hours));
  const [limit, setLimit] = useState(String(config.limit));
  const [saving, setSaving] = useState(false);

  async function salvar() {
    setSaving(true);
    try {
      const result = await atualizarLembreteDeCasoParado({
        enabled,
        interval_hours: Number(intervalHours),
        limit: Number(limit),
      });
      if (result.ok) toast.success(t("Lembrete de caso parado salvo."));
      else if (result.error === "mfa_required") router.push("/login/mfa?next=/app/ai/inbox");
      else toast.error(t("Não foi possível salvar o lembrete de caso parado."));
    } catch {
      toast.error(t("Não foi possível salvar o lembrete de caso parado."));
    } finally {
      setSaving(false);
    }
  }

  return (
    <section className="rounded-lg border border-border p-4" aria-labelledby="case-wait-reminder-title">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="min-w-0 flex-1">
          <h2 id="case-wait-reminder-title" className="font-medium">{t("Lembrete de caso parado")}</h2>
          <p className="mt-1 text-sm text-muted-foreground">
            {t("Cada nova espera humana inicia uma cadência própria. O verificador roda de hora em hora.")}
          </p>
        </div>
        <label className="flex min-h-11 items-center gap-2 text-sm">
          <input
            type="checkbox"
            aria-label={t("Ativar lembretes de caso parado")}
            checked={enabled}
            onChange={(event) => setEnabled(event.target.checked)}
          />
          {t("Ativo")}
        </label>
      </div>

      <div className="mt-4 grid gap-4 sm:grid-cols-2">
        <div className="space-y-1">
          <Label htmlFor="case-wait-interval">{t("Intervalo entre lembretes (horas)")}</Label>
          <Input
            id="case-wait-interval"
            type="number"
            min={1}
            max={168}
            step={1}
            value={intervalHours}
            onChange={(event) => setIntervalHours(event.target.value)}
          />
          <p className="text-xs text-muted-foreground">{t("De 1 a 168 horas")}</p>
        </div>
        <div className="space-y-1">
          <Label htmlFor="case-wait-limit">{t("Máximo por espera humana")}</Label>
          <Input
            id="case-wait-limit"
            type="number"
            min={1}
            max={10}
            step={1}
            value={limit}
            onChange={(event) => setLimit(event.target.value)}
          />
          <p className="text-xs text-muted-foreground">{t("De 1 a 10 lembretes")}</p>
        </div>
      </div>

      <div className="mt-4 flex justify-end">
        <Button type="button" disabled={saving} onClick={() => void salvar()}>
          {saving ? t("Salvando...") : t("Salvar configuração")}
        </Button>
      </div>
    </section>
  );
}
