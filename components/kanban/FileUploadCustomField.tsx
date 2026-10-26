"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { useT } from "@/hooks/i18n/useT";
import {
  LEAD_ATTACHMENT_MAX_BYTES,
  LEAD_ATTACHMENT_MAX_FILES,
  LEAD_ATTACHMENT_MIME_TYPES,
  validateLeadAttachment,
} from "@/lib/leads/attachment-validation";
import { DownloadSimple, Eye, Paperclip, Trash } from "@/lib/ui/icons";

interface AttachmentItem {
  id: string;
  filename: string;
  mime_type: string;
  size_bytes: number;
  created_at: string;
  media_url: string;
}

interface ApiEnvelope<T> {
  data?: T;
  error?: { message?: string };
}

interface Props {
  leadId?: string;
  fieldKey: string;
  label: string;
  multiple?: boolean;
  disabled?: boolean;
  required?: boolean;
  onChange?: (hasAttachment: boolean) => void;
}

function tamanhoLegivel(bytes: number): string {
  return bytes < 1024 * 1024
    ? `${Math.max(1, Math.round(bytes / 1024))} KB`
    : `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** Campo file CRM: o cliente vê metadados e URLs do proxy autenticado apenas. */
export function FileUploadCustomField({
  leadId,
  fieldKey,
  label,
  multiple = false,
  disabled = false,
  required = false,
  onChange,
}: Props) {
  const t = useT();
  const [items, setItems] = useState<AttachmentItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const onChangeRef = useRef(onChange);
  useEffect(() => { onChangeRef.current = onChange; }, [onChange]);
  const endpoint = useMemo(
    () => (leadId ? `/api/v1/leads/${encodeURIComponent(leadId)}/attachments` : null),
    [leadId],
  );

  const reload = useCallback(async (signal?: AbortSignal) => {
    if (!endpoint) {
      setItems([]);
      setLoading(false);
      setError(null);
      return;
    }
    // A lead/pipeline switch must never paint the previous lead's attachments
    // while the new tenant-scoped request is in flight.
    setItems([]);
    setLoading(true);
    setError(null);
    try {
      const response = await fetch(`${endpoint}?custom_field_key=${encodeURIComponent(fieldKey)}`, {
        credentials: "same-origin",
        cache: "no-store",
        signal,
      });
      const body = (await response.json()) as ApiEnvelope<{ attachments: AttachmentItem[] }>;
      if (!response.ok || !body.data) throw new Error(body.error?.message ?? t("Não foi possível carregar os anexos."));
      setItems(body.data.attachments);
    } catch (cause) {
      if (cause instanceof DOMException && cause.name === "AbortError") return;
      setItems([]);
      setError(cause instanceof Error ? cause.message : t("Não foi possível carregar os anexos."));
    } finally {
      if (!signal?.aborted) setLoading(false);
    }
  }, [endpoint, fieldKey, t]);

  useEffect(() => {
    const controller = new AbortController();
    void reload(controller.signal);
    return () => controller.abort();
  }, [reload]);

  useEffect(() => onChangeRef.current?.(items.length > 0), [items.length]);

  async function upload(files: File[]) {
    if (!endpoint || !files.length || disabled || uploading) return;
    const remaining = multiple ? LEAD_ATTACHMENT_MAX_FILES - items.length : 1 - items.length;
    if (files.length > remaining) {
      setError(
        multiple
          ? t("Este campo aceita até {limite} arquivos.").replace("{limite}", String(LEAD_ATTACHMENT_MAX_FILES))
          : t("Este campo aceita um arquivo. Remova o atual antes de enviar outro."),
      );
      return;
    }
    for (const file of files) {
      const checked = validateLeadAttachment({
        name: file.name,
        type: file.type,
        size: file.size,
        bytes: new Uint8Array(await file.arrayBuffer()),
      });
      if (!checked.ok) {
        setError(t("Cada arquivo deve ser PDF, PNG, JPEG ou WebP válido e ter até 5 MB."));
        return;
      }
    }
    setUploading(true);
    setError(null);
    try {
      const form = new FormData();
      form.set("custom_field_key", fieldKey);
      for (const file of files) form.append("files", file, file.name);
      const response = await fetch(endpoint, {
        method: "POST",
        credentials: "same-origin",
        body: form,
      });
      const body = (await response.json()) as ApiEnvelope<unknown>;
      if (!response.ok) throw new Error(body.error?.message ?? t("Não foi possível enviar o arquivo."));
      await reload();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : t("Não foi possível enviar o arquivo."));
    } finally {
      setUploading(false);
    }
  }

  async function remove(item: AttachmentItem) {
    if (!endpoint || disabled || deletingId) return;
    setDeletingId(item.id);
    setError(null);
    try {
      const response = await fetch(`${endpoint}/${encodeURIComponent(item.id)}`, {
        method: "DELETE",
        credentials: "same-origin",
      });
      const body = (await response.json()) as ApiEnvelope<unknown>;
      if (!response.ok) throw new Error(body.error?.message ?? t("Não foi possível remover o arquivo."));
      await reload();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : t("Não foi possível remover o arquivo."));
    } finally {
      setDeletingId(null);
    }
  }

  const inputId = `file-${leadId ?? "new"}-${fieldKey}`;
  const uploadDisabled = disabled || uploading || !endpoint || loading || (!multiple && items.length > 0);

  return (
    <div className="min-w-0 space-y-2" data-testid={`custom-file-${fieldKey}`}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <Label htmlFor={inputId}>
          {label}{required && <span className="ml-1 text-error-fg">*</span>}
        </Label>
        <span className="text-xs text-muted-foreground">
          {t("PDF, PNG, JPEG ou WebP · até 5 MB")}
          {multiple && ` · ${t("até {limite} arquivos").replace("{limite}", String(LEAD_ATTACHMENT_MAX_FILES))}`}
        </span>
      </div>

      {!leadId ? (
        <p className="rounded-md border border-dashed p-3 text-xs text-muted-foreground">
          {t("Salve o negócio para adicionar anexos.")}
        </p>
      ) : (
        <>
          <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
            <input
              id={inputId}
              className="block min-w-0 w-full text-sm file:mr-3 file:min-h-11 file:rounded-sm file:border-0 file:bg-accent-soft file:px-3 file:text-sm file:font-medium file:text-text focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-accent-500"
              type="file"
              accept={LEAD_ATTACHMENT_MIME_TYPES.join(",")}
              multiple={multiple}
              disabled={uploadDisabled}
              onChange={(event) => {
                // Snapshot before clearing the input; clearing it mutates its live FileList.
                const files = Array.from(event.currentTarget.files ?? []);
                event.currentTarget.value = "";
                void upload(files);
              }}
              aria-label={t("Selecionar arquivos para {campo}").replace("{campo}", label)}
            />
            {uploading && <span role="status" className="shrink-0 text-xs text-muted-foreground">{t("Enviando…")}</span>}
          </div>

          {loading ? (
            <p className="text-xs text-muted-foreground">{t("Carregando anexos…")}</p>
          ) : items.length > 0 ? (
            <ul className="space-y-2" aria-label={t("Arquivos de {campo}").replace("{campo}", label)}>
              {items.map((item) => (
                <li key={item.id} className="flex min-w-0 flex-wrap items-center gap-2 rounded-md border border-border p-2">
                  <Paperclip size={16} className="shrink-0 text-muted-foreground" aria-hidden />
                  <span className="min-w-0 flex-1 break-all text-xs font-medium">{item.filename}</span>
                  <span className="shrink-0 text-xs text-muted-foreground">{tamanhoLegivel(item.size_bytes)}</span>
                  <Button asChild variant="ghost" size="icon" aria-label={t("Visualizar {arquivo}").replace("{arquivo}", item.filename)}>
                    <a href={`${item.media_url}?inline=1`} target="_blank" rel="noopener noreferrer">
                      <Eye size={16} aria-hidden />
                    </a>
                  </Button>
                  <Button asChild variant="ghost" size="icon" aria-label={t("Baixar {arquivo}").replace("{arquivo}", item.filename)}>
                    <a href={`${item.media_url}?download=1`}>
                      <DownloadSimple size={16} aria-hidden />
                    </a>
                  </Button>
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    aria-label={t("Remover {arquivo}").replace("{arquivo}", item.filename)}
                    disabled={disabled || deletingId !== null}
                    onClick={() => void remove(item)}
                  >
                    <Trash size={16} aria-hidden />
                  </Button>
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-xs text-muted-foreground">{t("Nenhum arquivo anexado.")}</p>
          )}
        </>
      )}

      {error && <p role="alert" className="text-xs text-error-fg">{error}</p>}
    </div>
  );
}
