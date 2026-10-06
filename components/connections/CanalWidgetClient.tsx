"use client";

import { useState } from "react";
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

  const snippet = `<script
  src="${typeof window !== "undefined" ? window.location.origin : "http://localhost:3000"}/chat/widget.js"
  data-title="${titulo}"
  data-color="${corPrimaria}"
  defer
></script>`;

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
              {t("Copie o código ao lado e cole antes do fechamento da tag </body> no seu site (WordPress, Nuvemshop, Shopify, Webflow, etc).")}
            </p>
          </div>
        </Card>

        <Card className="p-6 space-y-4 flex flex-col justify-between">
          <div>
            <h3 className="text-base font-medium mb-2">{t("Código de Integração")}</h3>
            <pre className="overflow-x-auto rounded-lg bg-muted p-4 text-xs font-mono text-foreground leading-relaxed whitespace-pre-wrap">
              {snippet}
            </pre>
          </div>
          <Button onClick={copiarCodigo} className="w-full">
            {t("Copiar Código para o Site")}
          </Button>
        </Card>
      </div>
    </div>
  );
}
