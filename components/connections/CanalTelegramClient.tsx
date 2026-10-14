"use client";

import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { apiClient } from "@/lib/api/client";
import { useT } from "@/hooks/i18n/useT";

type TelegramBotStatus = {
  connected: boolean;
  provider: string;
  bot_id?: string;
  username?: string;
  display_name?: string;
  webhook_url?: string;
};

type TelegramUserStatus = {
  connected: boolean;
  status?: "partial" | "disabled";
  gateway_configured?: boolean;
  inbound_enabled?: boolean;
  phone_number?: string;
  first_name?: string;
  username?: string;
};

export function CanalTelegramClient() {
  const t = useT();
  const [subAba, setSubAba] = useState<"bot" | "user">("bot");

  // Bot states
  const [botToken, setBotToken] = useState("");
  const [botName, setBotName] = useState("");
  const [botSaving, setBotSaving] = useState(false);

  // User MTProto states
  const [phone, setPhone] = useState("");
  const [phoneCodeHash, setPhoneCodeHash] = useState("");
  const [smsCode, setSmsCode] = useState("");
  const [password2FA, setPassword2FA] = useState("");
  const [stepUser, setStepUser] = useState<"phone" | "code">("phone");
  const [userSaving, setUserSaving] = useState(false);

  const queryBot = useQuery({
    queryKey: ["channel-telegram-bot"],
    queryFn: async () =>
      (await apiClient.get<{ data: TelegramBotStatus }>("/api/v1/channels/telegram")).data,
  });

  const queryUser = useQuery({
    queryKey: ["channel-telegram-user"],
    queryFn: async () => {
      try {
        return (await apiClient.get<{ data: TelegramUserStatus }>("/api/v1/channels/telegram-user"))
          .data;
      } catch {
        return { connected: false };
      }
    },
  });

  const botData = queryBot.data;
  const userData = queryUser.data;

  async function handleSalvarBot(e: React.FormEvent) {
    e.preventDefault();
    if (!botToken.trim()) {
      toast.error(t("Informe o token fornecido pelo @BotFather"));
      return;
    }
    setBotSaving(true);
    try {
      await apiClient.post("/api/v1/channels/telegram", {
        token: botToken.trim(),
        display_name: botName.trim() || undefined,
      });
      toast.success(t("Bot do Telegram conectado com sucesso!"));
      setBotToken("");
      setBotName("");
      void queryBot.refetch();
    } catch (err: unknown) {
      toast.error(err instanceof Error ? err.message : t("Erro ao conectar bot do Telegram"));
    } finally {
      setBotSaving(false);
    }
  }

  async function handleDesconectarBot() {
    if (!confirm(t("Deseja realmente desconectar o bot do Telegram?"))) return;
    setBotSaving(true);
    try {
      await apiClient.delete("/api/v1/channels/telegram");
      toast.success(t("Bot desconectado."));
      void queryBot.refetch();
    } catch (err: unknown) {
      toast.error(err instanceof Error ? err.message : t("Erro ao desconectar"));
    } finally {
      setBotSaving(false);
    }
  }

  async function handleEnviarCodigoTelegram(e: React.FormEvent) {
    e.preventDefault();
    if (!phone.trim()) {
      toast.error(t("Informe o telefone no formato internacional (+55...)"));
      return;
    }
    setUserSaving(true);
    try {
      const res = await apiClient.post<{ data: { phone_code_hash: string } }>(
        "/api/v1/channels/telegram-user/auth",
        {
          action: "send_code",
          phone_number: phone.trim(),
        },
      );
      setPhoneCodeHash(res.data.phone_code_hash);
      setStepUser("code");
      toast.success(t("Código enviado para o seu aplicativo Telegram!"));
    } catch (err: unknown) {
      toast.error(err instanceof Error ? err.message : t("Falha ao solicitar código"));
    } finally {
      setUserSaving(false);
    }
  }

  async function handleConfirmarCodigoTelegram(e: React.FormEvent) {
    e.preventDefault();
    if (!smsCode.trim()) {
      toast.error(t("Digite o código recebido"));
      return;
    }
    setUserSaving(true);
    try {
      await apiClient.post("/api/v1/channels/telegram-user/auth", {
        action: "sign_in",
        phone_number: phone.trim(),
        phone_code_hash: phoneCodeHash,
        code: smsCode.trim(),
        password: password2FA.trim() || undefined,
      });
      toast.success(t("Conta de Telegram conectada!"));
      setStepUser("phone");
      setPhone("");
      setSmsCode("");
      void queryUser.refetch();
    } catch (err: unknown) {
      toast.error(err instanceof Error ? err.message : t("Código inválido ou senha incorreta"));
    } finally {
      setUserSaving(false);
    }
  }

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h2 className="text-lg font-semibold">{t("Telegram")}</h2>
        <p className="text-sm text-muted-foreground">
          {t(
            "Conecte um Bot oficial ou uma Conta de Usuário (MTProto) para atender leads e disparar mensagens.",
          )}
        </p>
      </div>

      <Tabs value={subAba} onValueChange={(v) => setSubAba(v as "bot" | "user")}>
        <TabsList>
          <TabsTrigger value="bot">
            {t("Bot Oficial (@BotFather)")}
            {botData?.connected && <Badge className="ml-2 bg-emerald-500 text-white">Online</Badge>}
          </TabsTrigger>
          <TabsTrigger value="user">
            {t("Conta de Usuário (Disparos / Humano)")}
            <Badge variant="outline" className="ml-2">
              {userData?.status === "disabled" ? t("Desativado") : t("Parcial")}
            </Badge>
            {userData?.connected && (
              <Badge className="ml-2 bg-emerald-500 text-white">Conectado</Badge>
            )}
          </TabsTrigger>
        </TabsList>

        <TabsContent value="bot" className="mt-4">
          <Card className="p-6">
            {botData?.connected ? (
              <div className="space-y-4">
                <div className="flex items-center justify-between border-b pb-4">
                  <div>
                    <h3 className="text-base font-medium">
                      {botData.display_name || botData.username || "Bot Conectado"}
                    </h3>
                    <p className="text-sm text-muted-foreground">@{botData.username}</p>
                  </div>
                  <Badge variant="outline" className="border-emerald-500 text-emerald-600">
                    {t("Ativo")}
                  </Badge>
                </div>
                <div className="space-y-1 text-sm text-muted-foreground">
                  <p>
                    <strong>Webhook ativo:</strong> {botData.webhook_url}
                  </p>
                  <p>
                    {t(
                      "As mensagens recebidas pelo bot caem diretamente no Inbox da sua organização.",
                    )}
                  </p>
                </div>
                <div className="pt-2">
                  <Button variant="destructive" onClick={handleDesconectarBot} disabled={botSaving}>
                    {botSaving ? t("Desconectando…") : t("Desconectar Bot")}
                  </Button>
                </div>
              </div>
            ) : (
              <form onSubmit={handleSalvarBot} className="max-w-lg space-y-4">
                <div className="space-y-2">
                  <Label htmlFor="bot-name">{t("Nome de exibição (opcional)")}</Label>
                  <Input
                    id="bot-name"
                    placeholder={t("Ex.: Atendimento Clientix")}
                    value={botName}
                    onChange={(e) => setBotName(e.target.value)}
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="bot-token">{t("Token do Bot (do @BotFather)")}</Label>
                  <Input
                    id="bot-token"
                    type="password"
                    placeholder="123456789:ABCdefGhIJKlmNoPQRsTUVwxyZ"
                    value={botToken}
                    onChange={(e) => setBotToken(e.target.value)}
                    required
                  />
                  <p className="text-xs text-muted-foreground">
                    {t(
                      "Abra o Telegram, procure por @BotFather, envie /newbot e cole o token aqui.",
                    )}
                  </p>
                </div>
                <Button type="submit" disabled={botSaving}>
                  {botSaving ? t("Verificando e Conectando…") : t("Conectar Bot do Telegram")}
                </Button>
              </form>
            )}
          </Card>
        </TabsContent>

        <TabsContent value="user" className="mt-4">
          <p
            role="status"
            className="mb-4 rounded-md border border-amber-500/40 bg-amber-500/5 p-3 text-sm text-muted-foreground"
          >
            {t(
              "Telegram User/MTProto está parcial: autenticação e envio dependem de um gateway HTTPS; mensagens recebidas ainda não entram no dispatcher. O Bot API é o canal Telegram suportado para produção.",
            )}
          </p>
          <Card className="p-6">
            {userData?.connected ? (
              <div className="space-y-4">
                <div className="flex items-center justify-between border-b pb-4">
                  <div>
                    <h3 className="text-base font-medium">
                      {userData.first_name || userData.phone_number}
                    </h3>
                    <p className="text-sm text-muted-foreground">{userData.phone_number}</p>
                  </div>
                  <Badge className="bg-emerald-500 text-white">{t("Sessão Ativa")}</Badge>
                </div>
                <p className="text-sm text-muted-foreground">
                  {t(
                    "Esta conta pode ser utilizada para envio ativo de campanhas e atendimento direto.",
                  )}
                </p>
              </div>
            ) : stepUser === "phone" ? (
              <form onSubmit={handleEnviarCodigoTelegram} className="max-w-lg space-y-4">
                <div className="space-y-2">
                  <Label htmlFor="phone">{t("Número de Telefone")}</Label>
                  <Input
                    id="phone"
                    placeholder="+5511999998888"
                    value={phone}
                    onChange={(e) => setPhone(e.target.value)}
                    required
                  />
                  <p className="text-xs text-muted-foreground">
                    {t(
                      "Você receberá uma mensagem com código de confirmação no seu app do Telegram.",
                    )}
                  </p>
                </div>
                <Button type="submit" disabled={userSaving}>
                  {userSaving ? t("Enviando código…") : t("Avançar")}
                </Button>
              </form>
            ) : (
              <form onSubmit={handleConfirmarCodigoTelegram} className="max-w-lg space-y-4">
                <div className="space-y-2">
                  <Label htmlFor="code">{t("Código de Verificação")}</Label>
                  <Input
                    id="code"
                    placeholder="12345"
                    value={smsCode}
                    onChange={(e) => setSmsCode(e.target.value)}
                    required
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="pass2fa">{t("Senha de 2 Etapas (se ativa na sua conta)")}</Label>
                  <Input
                    id="pass2fa"
                    type="password"
                    placeholder={t("Deixe vazio se não tiver senha de nuvem")}
                    value={password2FA}
                    onChange={(e) => setPassword2FA(e.target.value)}
                  />
                </div>
                <div className="flex gap-2">
                  <Button type="submit" disabled={userSaving}>
                    {userSaving ? t("Conectando…") : t("Conectar Telegram")}
                  </Button>
                  <Button variant="outline" type="button" onClick={() => setStepUser("phone")}>
                    {t("Voltar")}
                  </Button>
                </div>
              </form>
            )}
          </Card>
        </TabsContent>
      </Tabs>
    </div>
  );
}
