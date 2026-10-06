"use client";

import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { toast } from "sonner";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { apiClient } from "@/lib/api/client";
import { useT } from "@/hooks/i18n/useT";
import { copyToClipboard } from "@/lib/clipboard";

type ChannelStatus = {
  connected: boolean;
  provider: string;
  username?: string;
  display_name?: string;
  account_id?: string;
  business_id?: string;
  webhook_url?: string;
  webhook_secret?: string;
};

export function CanalInstagramTikTokClient() {
  const t = useT();

  // Instagram states
  const [igAccountId, setIgAccountId] = useState("");
  const [igToken, setIgToken] = useState("");
  const [igAppSecret, setIgAppSecret] = useState("");
  const [igName, setIgName] = useState("");
  const [igSaving, setIgSaving] = useState(false);

  // TikTok states
  const [ttBusinessId, setTtBusinessId] = useState("");
  const [ttToken, setTtToken] = useState("");
  const [ttSecret, setTtSecret] = useState("");
  const [ttName, setTtName] = useState("");
  const [ttSaving, setTtSaving] = useState(false);

  const queryIg = useQuery({
    queryKey: ["channel-instagram"],
    queryFn: async () => (await apiClient.get<{ data: ChannelStatus }>("/api/v1/channels/instagram")).data,
  });

  const queryTt = useQuery({
    queryKey: ["channel-tiktok"],
    queryFn: async () => (await apiClient.get<{ data: ChannelStatus }>("/api/v1/channels/tiktok")).data,
  });

  const igData = queryIg.data;
  const ttData = queryTt.data;

  async function handleSalvarInstagram(e: React.FormEvent) {
    e.preventDefault();
    setIgSaving(true);
    try {
      await apiClient.post("/api/v1/channels/instagram", {
        account_id: igAccountId.trim(),
        token: igToken.trim(),
        app_secret: igAppSecret.trim() || undefined,
        display_name: igName.trim() || undefined,
      });
      toast.success(t("Instagram Direct conectado!"));
      setIgAccountId("");
      setIgToken("");
      setIgAppSecret("");
      void queryIg.refetch();
    } catch (err: unknown) {
      toast.error(err instanceof Error ? err.message : t("Falha ao conectar Instagram"));
    } finally {
      setIgSaving(false);
    }
  }

  async function handleSalvarTikTok(e: React.FormEvent) {
    e.preventDefault();
    setTtSaving(true);
    try {
      await apiClient.post("/api/v1/channels/tiktok", {
        business_id: ttBusinessId.trim(),
        token: ttToken.trim(),
        webhook_secret: ttSecret.trim() || undefined,
        display_name: ttName.trim() || undefined,
      });
      toast.success(t("TikTok Direct conectado!"));
      setTtBusinessId("");
      setTtToken("");
      setTtSecret("");
      void queryTt.refetch();
    } catch (err: unknown) {
      toast.error(err instanceof Error ? err.message : t("Falha ao conectar TikTok"));
    } finally {
      setTtSaving(false);
    }
  }

  return (
    <div className="grid gap-6 md:grid-cols-2 mt-6">
      {/* Card Instagram */}
      <Card className="p-6 space-y-4">
        <div className="flex items-center justify-between border-b pb-3">
          <div className="flex items-center gap-2">
            <span className="text-xl">📸</span>
            <h3 className="font-semibold">{t("Instagram Direct")}</h3>
          </div>
          {igData?.connected ? (
            <Badge className="bg-emerald-500 text-white">Online</Badge>
          ) : (
            <Badge variant="outline">Desconectado</Badge>
          )}
        </div>

        {igData?.connected ? (
          <div className="space-y-3 text-sm">
            <p><strong>Conta:</strong> @{igData.username || igData.account_id}</p>
            <div className="p-3 rounded-md bg-muted/60 border text-xs space-y-2 font-mono">
              <div>
                <span className="text-muted-foreground block text-[10px] uppercase font-sans font-semibold">Webhook Callback URL</span>
                <div className="flex items-center justify-between gap-2 mt-0.5">
                  <span className="break-all select-all">{igData.webhook_url}</span>
                  {igData.webhook_url && (
                    <Button
                      variant="ghost"
                      size="sm"
                      className="h-6 px-2 text-xs"
                      onClick={async () => {
                        await copyToClipboard(igData.webhook_url || "");
                        toast.success(t("URL do Webhook copiada!"));
                      }}
                    >
                      Copiar
                    </Button>
                  )}
                </div>
              </div>
            </div>
            <Button
              variant="destructive"
              size="sm"
              onClick={async () => {
                if (confirm(t("Desconectar Instagram?"))) {
                  await apiClient.delete("/api/v1/channels/instagram");
                  void queryIg.refetch();
                }
              }}
            >
              {t("Desconectar")}
            </Button>
          </div>
        ) : (
          <form onSubmit={handleSalvarInstagram} className="space-y-3">
            <div className="space-y-1">
              <Label htmlFor="ig-acc">{t("ID da Conta Instagram Business")}</Label>
              <Input
                id="ig-acc"
                placeholder="17841400..."
                value={igAccountId}
                onChange={(e) => setIgAccountId(e.target.value)}
                required
              />
            </div>
            <div className="space-y-1">
              <Label htmlFor="ig-token">{t("Token de Acesso (Page / User)")}</Label>
              <Input
                id="ig-token"
                type="password"
                placeholder="EAA..."
                value={igToken}
                onChange={(e) => setIgToken(e.target.value)}
                required
              />
            </div>
            <div className="space-y-1">
              <Label htmlFor="ig-app-secret">{t("Meta App Secret (Opcional se no .env)")}</Label>
              <Input
                id="ig-app-secret"
                type="password"
                placeholder="Segredo do aplicativo Meta..."
                value={igAppSecret}
                onChange={(e) => setIgAppSecret(e.target.value)}
              />
            </div>
            <div className="space-y-1">
              <Label htmlFor="ig-name">{t("Nome de exibição")}</Label>
              <Input
                id="ig-name"
                placeholder="Instagram Principal"
                value={igName}
                onChange={(e) => setIgName(e.target.value)}
              />
            </div>
            <Button type="submit" size="sm" disabled={igSaving} className="w-full">
              {igSaving ? t("Conectando…") : t("Conectar Instagram")}
            </Button>
          </form>
        )}
      </Card>

      {/* Card TikTok */}
      <Card className="p-6 space-y-4">
        <div className="flex items-center justify-between border-b pb-3">
          <div className="flex items-center gap-2">
            <span className="text-xl">🎵</span>
            <h3 className="font-semibold">{t("TikTok Direct")}</h3>
          </div>
          {ttData?.connected ? (
            <Badge className="bg-emerald-500 text-white">Online</Badge>
          ) : (
            <Badge variant="outline">Desconectado</Badge>
          )}
        </div>

        {ttData?.connected ? (
          <div className="space-y-3 text-sm">
            <p><strong>Conta:</strong> @{ttData.username || ttData.business_id}</p>
            <div className="p-3 rounded-md bg-muted/60 border text-xs space-y-2 font-mono">
              <div>
                <span className="text-muted-foreground block text-[10px] uppercase font-sans font-semibold">Webhook Callback URL</span>
                <div className="flex items-center justify-between gap-2 mt-0.5">
                  <span className="break-all select-all">{ttData.webhook_url}</span>
                  {ttData.webhook_url && (
                    <Button
                      variant="ghost"
                      size="sm"
                      className="h-6 px-2 text-xs"
                      onClick={async () => {
                        await copyToClipboard(ttData.webhook_url || "");
                        toast.success(t("URL do Webhook copiada!"));
                      }}
                    >
                      Copiar
                    </Button>
                  )}
                </div>
              </div>
              {ttData.webhook_secret && (
                <div>
                  <span className="text-muted-foreground block text-[10px] uppercase font-sans font-semibold">Webhook Secret / Client Secret</span>
                  <div className="flex items-center justify-between gap-2 mt-0.5">
                    <span className="break-all select-all">{ttData.webhook_secret}</span>
                    <Button
                      variant="ghost"
                      size="sm"
                      className="h-6 px-2 text-xs"
                      onClick={async () => {
                        await copyToClipboard(ttData.webhook_secret || "");
                        toast.success(t("Secret copiado!"));
                      }}
                    >
                      Copiar
                    </Button>
                  </div>
                </div>
              )}
            </div>
            <Button
              variant="destructive"
              size="sm"
              onClick={async () => {
                if (confirm(t("Desconectar TikTok?"))) {
                  await apiClient.delete("/api/v1/channels/tiktok");
                  void queryTt.refetch();
                }
              }}
            >
              {t("Desconectar")}
            </Button>
          </div>
        ) : (
          <form onSubmit={handleSalvarTikTok} className="space-y-3">
            <div className="space-y-1">
              <Label htmlFor="tt-acc">{t("Business Account ID do TikTok")}</Label>
              <Input
                id="tt-acc"
                placeholder="7123456789..."
                value={ttBusinessId}
                onChange={(e) => setTtBusinessId(e.target.value)}
                required
              />
            </div>
            <div className="space-y-1">
              <Label htmlFor="tt-token">{t("Access Token TikTok Business")}</Label>
              <Input
                id="tt-token"
                type="password"
                placeholder="act.example..."
                value={ttToken}
                onChange={(e) => setTtToken(e.target.value)}
                required
              />
            </div>
            <div className="space-y-1">
              <Label htmlFor="tt-secret">{t("Webhook / App Secret (Opcional - gerado se omitido)")}</Label>
              <Input
                id="tt-secret"
                type="password"
                placeholder="Client Secret do app TikTok..."
                value={ttSecret}
                onChange={(e) => setTtSecret(e.target.value)}
              />
            </div>
            <div className="space-y-1">
              <Label htmlFor="tt-name">{t("Nome de exibição")}</Label>
              <Input
                id="tt-name"
                placeholder="TikTok Oficial"
                value={ttName}
                onChange={(e) => setTtName(e.target.value)}
              />
            </div>
            <Button type="submit" size="sm" disabled={ttSaving} className="w-full">
              {ttSaving ? t("Conectando…") : t("Conectar TikTok")}
            </Button>
          </form>
        )}
      </Card>
    </div>
  );
}
