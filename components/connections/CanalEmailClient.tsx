"use client";

import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { apiClient } from "@/lib/api/client";
import { useT } from "@/hooks/i18n/useT";

type EmailStatus = {
  connected: boolean;
  provider: string;
  email_address?: string;
  display_name?: string;
  webhook_url?: string;
  status?: string;
};

export function CanalEmailClient() {
  const t = useT();
  const [emailAddress, setEmailAddress] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [saving, setSaving] = useState(false);

  const query = useQuery({
    queryKey: ["channel-email-inbox"],
    queryFn: async () => (await apiClient.get<{ data: EmailStatus }>("/api/v1/channels/email")).data,
  });

  const emailData = query.data;

  async function handleSalvarEmail(e: React.FormEvent) {
    e.preventDefault();
    if (!emailAddress.trim()) {
      toast.error(t("Informe o endereço de e-mail"));
      return;
    }
    setSaving(true);
    try {
      await apiClient.post("/api/v1/channels/email", {
        email_address: emailAddress.trim(),
        display_name: displayName.trim() || undefined,
      });
      toast.success(t("Caixa de e-mail conectada!"));
      setEmailAddress("");
      setDisplayName("");
      void query.refetch();
    } catch (err: unknown) {
      toast.error(err instanceof Error ? err.message : t("Falha ao configurar e-mail"));
    } finally {
      setSaving(false);
    }
  }

  async function handleDesconectar() {
    if (!confirm(t("Deseja realmente desconectar este endereço de e-mail?"))) return;
    setSaving(true);
    try {
      await apiClient.delete("/api/v1/channels/email");
      toast.success(t("E-mail desconectado."));
      void query.refetch();
    } catch (err: unknown) {
      toast.error(err instanceof Error ? err.message : t("Falha ao desconectar"));
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h2 className="text-lg font-semibold">{t("E-mail (Atendimento & Campanhas)")}</h2>
        <p className="text-sm text-muted-foreground">
          {t("Receba e responda mensagens de clientes por e-mail diretamente no Inbox unificado.")}
        </p>
      </div>

      <Card className="p-6">
        {emailData?.connected ? (
          <div className="space-y-4">
            <div className="flex items-center justify-between border-b pb-4">
              <div>
                <h3 className="text-base font-medium">{emailData.display_name || emailData.email_address}</h3>
                <p className="text-sm text-muted-foreground">{emailData.email_address}</p>
              </div>
              <Badge variant="outline" className="border-emerald-500 text-emerald-600">
                {t("Conectado")}
              </Badge>
            </div>
            <div className="text-sm text-muted-foreground space-y-2">
              <p>
                <strong>Webhook Inbound:</strong> {emailData.webhook_url}
              </p>
              <p className="text-xs">
                {t("Configure o encaminhamento de e-mails do seu provedor (Google Workspace, Outlook, cPanel ou Resend/SendGrid) para este endereço para alimentar o CRM.")}
              </p>
            </div>
            <div className="pt-2">
              <Button variant="destructive" onClick={handleDesconectar} disabled={saving}>
                {saving ? t("Desconectando…") : t("Desconectar E-mail")}
              </Button>
            </div>
          </div>
        ) : (
          <form onSubmit={handleSalvarEmail} className="space-y-4 max-w-lg">
            <div className="space-y-2">
              <Label htmlFor="display-name">{t("Nome de exibição do remetente")}</Label>
              <Input
                id="display-name"
                placeholder={t("Ex.: Suporte Clientix")}
                value={displayName}
                onChange={(e) => setDisplayName(e.target.value)}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="email-addr">{t("Endereço de E-mail")}</Label>
              <Input
                id="email-addr"
                type="email"
                placeholder="atendimento@suaempresa.com.br"
                value={emailAddress}
                onChange={(e) => setEmailAddress(e.target.value)}
                required
              />
            </div>
            <Button type="submit" disabled={saving}>
              {saving ? t("Configurando…") : t("Conectar Caixa de E-mail")}
            </Button>
          </form>
        )}
      </Card>
    </div>
  );
}
