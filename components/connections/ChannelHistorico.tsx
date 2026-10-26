"use client";

import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { apiClient } from "@/lib/api/client";
import { ApiError } from "@/lib/api/types";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { useT } from "@/hooks/i18n/useT";
import { toast } from "sonner";

interface ImportStatus {
  id: string;
  status: "pending" | "running" | "completed" | "failed" | "cancelled";
  range_days: number;
  range_start: string;
  imported_count: number;
  skipped_count: number;
  failed_count: number;
  last_error_code: string | null;
  started_at: string | null;
  finished_at: string | null;
  updated_at: string;
}

interface HistoryResponse {
  history_supported: boolean;
  reason_code: string | null;
  import: ImportStatus | null;
  preview?: PreviewStatus | null;
}

interface PreviewStatus {
  range_days: number;
  range_start: string;
  conversations: number;
  messages: number;
  audios: number;
  images: number;
  partial: boolean;
}

const RANGES = [30, 90, 180, 365] as const;

export function ChannelHistorico({ channelId, status }: { channelId: string; status: string }) {
  const t = useT();
  const qc = useQueryClient();
  const [rangeDays, setRangeDays] = useState<number>(90);
  const [busy, setBusy] = useState(false);
  const [previewBusy, setPreviewBusy] = useState(false);
  const [preview, setPreview] = useState<PreviewStatus | null>(null);
  const query = useQuery({
    queryKey: ["whatsapp-history", channelId],
    queryFn: async () => (await apiClient.get<{ data: HistoryResponse }>(`/api/v1/channel-sessions/${channelId}/historico`)).data,
    refetchInterval: 10_000,
  });

  const run = async (action: "start" | "cancel") => {
    setBusy(true);
    try {
      if (action === "start") {
        await apiClient.post(`/api/v1/channel-sessions/${channelId}/historico`, { range_days: rangeDays, preview_confirmed: true });
        setPreview(null);
      } else {
        await apiClient.post(`/api/v1/channel-sessions/${channelId}/historico/cancel`, {});
      }
      await qc.invalidateQueries({ queryKey: ["whatsapp-history", channelId] });
      toast.success(t(action === "start" ? "Importação do histórico iniciada." : "Importação cancelada."));
    } catch (error) {
      const message = error instanceof ApiError && error.code === "mfa_required"
        ? t("Confirme a verificação em duas etapas para continuar.")
        : t("Não foi possível concluir a operação do histórico.");
      toast.error(message);
    } finally {
      setBusy(false);
    }
  };

  const loadPreview = async () => {
    setPreviewBusy(true);
    setPreview(null);
    try {
      const response = await apiClient.get<{ data: HistoryResponse }>(
        `/api/v1/channel-sessions/${channelId}/historico?preview_days=${rangeDays}`,
      );
      if (!response.data.preview) throw new Error("preview_unavailable");
      setPreview(response.data.preview);
    } catch {
      toast.error(t("Não foi possível calcular a prévia do histórico."));
    } finally {
      setPreviewBusy(false);
    }
  };

  if (query.isLoading) return <p className="text-xs text-muted-foreground">{t("Verificando suporte ao histórico…")}</p>;
  if (query.isError || !query.data) return <p className="text-xs text-destructive">{t("Não foi possível verificar a importação do histórico.")}</p>;
  const state = query.data;
  const job = state.import;
  const active = job?.status === "pending" || job?.status === "running";

  return (
    <Card className="space-y-3 border-dashed p-3">
      <div>
        <h3 className="text-sm font-medium">{t("Importar histórico")}</h3>
        <p className="mt-1 text-xs text-muted-foreground">
          {state.history_supported
            ? t("Importa conversas individuais do período escolhido. Mensagens históricas ficam no Inbox sem acionar IA ou automações.")
            : state.reason_code === "store_not_enabled"
              ? t("O histórico não foi habilitado antes do pareamento. Para importar, conecte novamente um número com o armazenamento de histórico ligado.")
              : t("Esta sessão ainda não está pronta para importar o histórico.")}
        </p>
      </div>
      {job && (
        <div className="space-y-1 text-xs" aria-live="polite">
          <p className="font-medium">{t(job.status === "pending" ? "Aguardando processamento" : job.status === "running" ? "Importação em andamento" : job.status === "completed" ? "Importação concluída" : job.status === "cancelled" ? "Importação cancelada" : "Importação interrompida")}</p>
          <p className="text-muted-foreground">
            {job.imported_count} {t("mensagens importadas")} · {job.skipped_count} {t("conversas ignoradas")} · {job.failed_count} {t("falhas")}
          </p>
          {job.status === "failed" && <p className="text-destructive">{t("A última tentativa falhou. Você pode iniciar uma nova importação.")}</p>}
          {job.status === "completed" && <p className="text-muted-foreground">{t("Período iniciado em")} {new Date(job.range_start).toLocaleDateString()}.</p>}
        </div>
      )}
      <div className="flex flex-wrap items-end gap-2">
        {!active && (
          <label className="flex min-w-36 flex-col gap-1 text-xs">
            <span>{t("Período")}</span>
            <select
              className="h-9 rounded-md border border-input bg-background px-2 text-sm"
              value={rangeDays}
              disabled={!state.history_supported || status !== "WORKING" || busy}
              onChange={(event) => { setRangeDays(Number(event.target.value)); setPreview(null); }}
              aria-label={t("Período do histórico")}
            >
              {RANGES.map((days) => <option value={days} key={days}>{days} {t("dias")}</option>)}
            </select>
          </label>
        )}
        {active ? (
          <Button variant="outline" size="sm" disabled={busy} onClick={() => void run("cancel")}>
            {t("Cancelar importação")}
          </Button>
        ) : (
          <>
            <Button variant="outline" size="sm" disabled={!state.history_supported || status !== "WORKING" || busy || previewBusy} onClick={() => void loadPreview()}>
              {previewBusy ? t("Calculando prévia…") : t("Ver prévia")}
            </Button>
            {preview && preview.range_days === rangeDays && (
              <div className="w-full rounded-md border bg-muted/30 p-3 text-xs" aria-live="polite">
                <p className="font-medium">{preview.partial ? t("Estimativa parcial — pelo menos") : t("Prévia do período")}</p>
                <p className="mt-1 text-muted-foreground">
                  {preview.conversations} {t("conversas")} · {preview.messages} {t("mensagens")} · {preview.audios} {t("áudios")} · {preview.images} {t("imagens")}
                </p>
                <p className="mt-1 text-muted-foreground">{t("A importação processa no máximo 100 mensagens por conversa. Arquivos que o provedor não disponibilizar aparecerão como indisponíveis.")}</p>
                <p className="mt-1 text-muted-foreground">{t("As mensagens antigas serão exibidas com a data original e não acionam IA nem automações.")}</p>
                <Button className="mt-3" size="sm" disabled={busy || status !== "WORKING"} onClick={() => void run("start")}>
                  {t("Importar este período")}
                </Button>
              </div>
            )}
          </>
        )}
      </div>
    </Card>
  );
}
