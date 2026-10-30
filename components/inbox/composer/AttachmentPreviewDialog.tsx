"use client";
import { useEffect, useMemo } from "react";
import { useT } from "@/hooks/i18n/useT";

import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { FileText } from "@/lib/ui/icons";
import { formatBytes } from "@/components/inbox/media/media-utils";

interface Props {
  files: File[];
  caption: string;
  sending: boolean;
  onCaptionChange: (caption: string) => void;
  onCancel: () => void;
  onSend: (caption: string) => void;
}

/** Preview antes do envio (padrão WhatsApp): thumb ou card + legenda. */
export function AttachmentPreviewDialog({ files, caption, sending, onCaptionChange, onCancel, onSend }: Props) {
  const t = useT();
  const file = files[0] ?? null;

  const objectUrl = useMemo(() => (file && /^(image|video)\//.test(file.type) ? URL.createObjectURL(file) : null), [file]);
  useEffect(() => () => {
    if (objectUrl) URL.revokeObjectURL(objectUrl);
  }, [objectUrl]);

  if (!file) return null;
  const isImage = file.type.startsWith("image/");
  const isVideo = file.type.startsWith("video/");

  return (
    <Dialog open onOpenChange={(open) => !open && onCancel()}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>{t(files.length > 1 ? "Enviar anexos" : "Enviar anexo")}</DialogTitle>
        </DialogHeader>
        <div className="flex items-center justify-center rounded-lg bg-muted/40 p-3">
          {isImage && objectUrl && (
            <img src={objectUrl} alt={file.name} className="max-h-64 rounded-md object-contain" />
          )}
          {isVideo && objectUrl && <video src={objectUrl} controls className="max-h-64 rounded-md" />}
          {!isImage && !isVideo && files.length === 1 && (
            <div className="flex items-center gap-3 py-4">
              <FileText size={28} weight="duotone" className="text-primary" aria-hidden />
              <div className="text-sm">
                <p className="font-medium">{file.name}</p>
                <p className="text-xs text-muted-foreground">{formatBytes(file.size)}</p>
              </div>
            </div>
          )}
        </div>
        {files.length > 1 && (
          <ol aria-label={t("Arquivos selecionados")} className="max-h-32 space-y-1 overflow-y-auto text-xs">
            {files.map((item, index) => (
              <li key={`${item.name}:${item.lastModified}:${index}`} className="flex min-w-0 items-center gap-2">
                <span className="w-5 shrink-0 text-right text-muted-foreground">{index + 1}.</span>
                <span className="min-w-0 flex-1 truncate" title={item.name}>
                  {item.name}
                </span>
                <span className="shrink-0 text-muted-foreground">{formatBytes(item.size)}</span>
              </li>
            ))}
          </ol>
        )}
        <Input
          value={caption}
          onChange={(e) => onCaptionChange(e.target.value)}
          placeholder={t("Legenda (opcional)")}
          aria-label={t("Legenda")}
          onKeyDown={(e) => e.key === "Enter" && !sending && onSend(caption.trim())}
        />
        <DialogFooter>
          <Button variant="ghost" onClick={onCancel} disabled={sending}>
            {t("Cancelar")}
          </Button>
          <Button onClick={() => onSend(caption.trim())} disabled={sending}>
            {t("Enviar")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
