"use client";

import { useEffect, useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card } from "@/components/ui/card";
import { useT } from "@/hooks/i18n/useT";
import { copyToClipboard } from "@/lib/clipboard";

export function CanalWidgetClient() {
  const t = useT();
  const [titulo, setTitulo] = useState("Atendimento Online");
  const [corPrimaria, setCorPrimaria] = useState("#10B981");
  const [widgetPublicId, setWidgetPublicId] = useState<string | null>(null);
  const [enabled, setEnabled] = useState(false);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [appOrigin, setAppOrigin] = useState("");
  const [erro, setErro] = useState<string | null>(null);

  useEffect(() => {
    setAppOrigin(window.location.origin);
    void fetch("/api/v1/channels/webchat", { cache: "no-store" })
      .then(async (response) => {
        const json: unknown = await response.json();
        if (!response.ok || !json || typeof json !== "object" || !("data" in json)) {
          throw new Error(t("Não foi possível carregar a configuração do WebChat."));
        }
        const data = json.data as { connected?: boolean; enabled?: boolean; widget_public_id?: string | null };
        setWidgetPublicId(typeof data.widget_public_id === "string" ? data.widget_public_id : null);
        setEnabled(data.enabled === true);
      })
      .catch((error: unknown) => {
        setErro(error instanceof Error ? error.message : t("Não foi possível carregar a configuração do WebChat."));
      })
      .finally(() => setLoading(false));
  }, [t]);

  const tituloSeguro = titulo.replace(/[&<>"']/g, (char) => {
    const entities: Record<string, string> = {
      "&": "&amp;",
      "<": "&lt;",
      ">": "&gt;",
      "\"": "&quot;",
      "'": "&#39;",
    };
    return entities[char] ?? char;
  });
  const corSegura = /^#[0-9a-f]{6}$/i.test(corPrimaria) ? corPrimaria : "#0f766e";
  const snippet = widgetPublicId && appOrigin
    ? `<script src="${appOrigin}/chat/widget.js" data-widget-id="${widgetPublicId}" data-title="${tituloSeguro}" data-color="${corSegura}" defer></script>`
    : "";

  async function alterarAtivacao(nextEnabled: boolean) {
    setSaving(true);
    setErro(null);
    try {
      const response = await fetch("/api/v1/channels/webchat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ enabled: nextEnabled }),
      });
      const json: unknown = await response.json();
      if (!response.ok || !json || typeof json !== "object" || !("data" in json)) {
        throw new Error(t("Não foi possível atualizar o WebChat."));
      }
      const data = json.data as { connected?: boolean; enabled?: boolean; widget_public_id?: string | null };
      setWidgetPublicId(typeof data.widget_public_id === "string" ? data.widget_public_id : null);
      setEnabled(data.enabled === true);
      toast.success(nextEnabled ? t("WebChat ativado.") : t("WebChat desativado."));
    } catch (error) {
      setErro(error instanceof Error ? error.message : t("Não foi possível atualizar o WebChat."));
    } finally {
      setSaving(false);
    }
  }

  async function copiarCodigo() {
    await copyToClipboard(snippet);
    toast.success(t("Código do widget copiado para a área de transferência!"));
  }

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h2 className="text-lg font-semibold">{t("Chat do Site (Widget Flutuante)")}</h2>
        <p className="text-sm text-muted-foreground">
          {t("Adicione um chat ao vivo nas páginas da sua loja, landing page ou site para conversar com visitantes em tempo real.")}
        </p>
      </div>

      {erro ? <p role="alert" className="text-sm text-destructive">{erro}</p> : null}
      <div className="flex items-center gap-3">
        <Button disabled={loading || saving} onClick={() => void alterarAtivacao(!enabled)}>
          {loading ? t("Carregando…") : saving ? t("Salvando…") : enabled ? t("Desativar WebChat") : t("Ativar WebChat")}
        </Button>
        <span className="text-sm text-muted-foreground">
          {enabled ? t("Widget ativo") : t("Widget desativado")}
        </span>
      </div>

      <div className="grid gap-6 md:grid-cols-2">
        <Card className="p-6 space-y-4">
          <h3 className="text-base font-medium">{t("Personalização do Widget")}</h3>
          <div className="space-y-2">
            <Label htmlFor="w-title">{t("Título do Cabeçalho")}</Label>
            <Input id="w-title" value={titulo} onChange={(e) => setTitulo(e.target.value)} />
          </div>
          <div className="space-y-2">
            <Label htmlFor="w-color">{t("Cor Primária (Hexadecimal)")}</Label>
            <div className="flex items-center gap-3">
              <input
                type="color"
                id="w-color-picker"
                value={corPrimaria}
                onChange={(e) => setCorPrimaria(e.target.value)}
                className="h-9 w-12 cursor-pointer rounded-md border border-border bg-transparent p-1"
              />
              <Input
                id="w-color"
                value={corPrimaria}
                onChange={(e) => setCorPrimaria(e.target.value)}
                className="max-w-[140px]"
              />
            </div>
          </div>

          <div className="space-y-2 pt-2">
            <Label>{t("Como instalar no seu site")}</Label>
            <p className="text-xs text-muted-foreground">
              {t("Copie o código ao lado e cole no seu site (WordPress, Nuvemshop, Shopify ou Webflow).")}
            </p>
          </div>
        </Card>

        <Card className="p-6 space-y-4 flex flex-col justify-between">
          <div>
            <h3 className="text-base font-medium mb-2">{t("Código de Integração")}</h3>
            {loading ? (
              <p className="text-sm text-muted-foreground">{t("Carregando configuração…")}</p>
            ) : widgetPublicId ? (
              <pre className="overflow-x-auto rounded-lg bg-muted p-4 text-xs font-mono text-foreground leading-relaxed whitespace-pre-wrap">
                {snippet}
              </pre>
            ) : (
              <p className="text-sm text-muted-foreground">{t("Ative o WebChat para gerar o código de instalação.")}</p>
            )}
          </div>
          <Button onClick={copiarCodigo} className="w-full" disabled={!enabled || !snippet}>
            {t("Copiar Código para o Site")}
          </Button>
        </Card>
      </div>
    </div>
  );
}
