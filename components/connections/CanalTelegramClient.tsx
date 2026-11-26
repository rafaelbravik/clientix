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
  telegram_app_configured?: boolean;
  status?: "connected" | "connecting" | "attention" | "disconnected";
  inbound_enabled?: boolean;
  sessions?: Array<{
    id: string;
    telegram_phone: string | null;
    telegram_user_id: string;
    display_name: string | null;
    status: string;
    status_reason: string | null;
    last_health_check_at: string | null;
  }>;
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
  const [sessionString, setSessionString] = useState("");
  const [smsCode, setSmsCode] = useState("");
  const [password2FA, setPassword2FA] = useState("");
  const [stepUser, setStepUser] = useState<"credentials" | "code" | "password">("credentials");
  const [userSaving, setUserSaving] = useState(false);
  const [userFormOpen, setUserFormOpen] = useState(false);

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
    refetchInterval: (query) => (query.state.data?.status === "connecting" ? 5_000 : false),
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
      const res = await apiClient.post<{
        data: { phone_code_hash: string; session_string: string; is_code_via_app: boolean };
      }>("/api/v1/channels/telegram-user/auth", {
        action: "send_code",
        phone: phone.trim(),
      });
      setPhoneCodeHash(res.data.phone_code_hash);
      setSessionString(res.data.session_string);
      setStepUser("code");
      toast.success(
        res.data.is_code_via_app
          ? t("Código enviado para o aplicativo Telegram")
          : t("Código enviado pelo método informado pelo Telegram"),
      );
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
      const response = await apiClient.post<{
        data: { password_needed?: boolean; session_string?: string };
      }>("/api/v1/channels/telegram-user/auth", {
        action: "sign_in",
        phone: phone.trim(),
        phone_code_hash: phoneCodeHash,
        phone_code: smsCode.trim(),
        session_string: sessionString,
      });
      if (response.data.password_needed && response.data.session_string) {
        setSessionString(response.data.session_string);
        setStepUser("password");
        toast.info(t("Agora informe a senha de duas etapas do Telegram"));
      } else {
        concluirConexaoTelegram();
      }
    } catch (err: unknown) {
      toast.error(err instanceof Error ? err.message : t("Código inválido ou senha incorreta"));
    } finally {
      setUserSaving(false);
    }
  }

  async function handleConfirmarSenhaTelegram(e: React.FormEvent) {
    e.preventDefault();
    if (!password2FA) {
      toast.error(t("Digite a senha de duas etapas"));
      return;
    }
    setUserSaving(true);
    try {
      await apiClient.post("/api/v1/channels/telegram-user/auth", {
        action: "check_password",
        phone: phone.trim(),
        password: password2FA,
        session_string: sessionString,
      });
      concluirConexaoTelegram();
    } catch (err: unknown) {
      toast.error(err instanceof Error ? err.message : t("Senha incorreta"));
    } finally {
      setUserSaving(false);
    }
  }

  function concluirConexaoTelegram() {
    toast.success(t("Conta de Telegram conectada. O Worker está iniciando a escuta."));
    setStepUser("credentials");
    setPhone("");
    setPhoneCodeHash("");
    setSessionString("");
    setSmsCode("");
    setPassword2FA("");
    setUserFormOpen(false);
    void queryUser.refetch();
  }

  function limparFluxoTelegram() {
    setStepUser("credentials");
    setPhone("");
    setPhoneCodeHash("");
    setSessionString("");
    setSmsCode("");
    setPassword2FA("");
    if ((userData?.sessions?.length ?? 0) > 0) setUserFormOpen(false);
  }

  async function handleDesconectarTelegram(channelSessionId: string) {
    if (!confirm(t("Deseja desconectar esta conta de usuário do Telegram?"))) return;
    setUserSaving(true);
    try {
      await apiClient.delete("/api/v1/channels/telegram-user", {
        channel_session_id: channelSessionId,
      });
      toast.success(t("Conta Telegram desconectada."));
      void queryUser.refetch();
    } catch (err: unknown) {
      toast.error(err instanceof Error ? err.message : t("Erro ao desconectar"));
    } finally {
      setUserSaving(false);
    }
  }

  const showUserForm = (userData?.sessions?.length ?? 0) === 0 || userFormOpen;

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
              {userData?.status === "connected"
                ? t("Conectado")
                : userData?.status === "connecting"
                  ? t("Conectando")
                  : userData?.status === "attention"
                    ? t("Verificar conexão")
                    : t("Desconectado")}
            </Badge>
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
          {!userData?.telegram_app_configured && (
            <p
              role="status"
              className="mb-4 rounded-md border border-amber-500/40 bg-amber-500/5 p-3 text-sm text-muted-foreground"
            >
              {t(
                "O Dono da instalação precisa configurar o aplicativo Telegram em Administração → Configuração da instalação → Telegram. Depois disso, informe aqui apenas o telefone da conta e confirme o código recebido.",
              )}
            </p>
          )}
          <p
            role="status"
            className="mb-4 rounded-md border border-amber-500/40 bg-amber-500/5 p-3 text-sm text-muted-foreground"
          >
            {t(
              "A conta de usuário conecta diretamente ao Telegram e recebe mensagens privadas no Inbox. O Telegram pode limitar contas que enviam mensagens em excesso; mantenha os envios dentro do uso esperado. Grupos ainda não são aceitos neste fluxo.",
            )}
          </p>
          <Card className="p-6">
            <div className="space-y-5">
              {(userData?.sessions ?? []).map((session) => (
                <div
                  key={session.id}
                  className="flex items-center justify-between gap-4 border-b pb-4"
                >
                  <div className="min-w-0">
                    <h3 className="truncate text-base font-medium">
                      {session.display_name || session.telegram_phone || t("Conta Telegram")}
                    </h3>
                    <p className="text-sm text-muted-foreground">
                      {session.telegram_phone || `ID ${session.telegram_user_id}`}
                    </p>
                    <p className="text-xs text-muted-foreground">
                      {session.status === "WORKING"
                        ? t("Worker conectado")
                        : session.status === "STARTING"
                          ? t("Worker iniciando conexão")
                          : t("Conexão precisa de atenção")}
                    </p>
                  </div>
                  <div className="flex shrink-0 items-center gap-3">
                    <Badge
                      variant={session.status === "WORKING" ? "default" : "outline"}
                      className={session.status === "WORKING" ? "bg-emerald-500 text-white" : ""}
                    >
                      {session.status === "WORKING"
                        ? t("Ativa")
                        : session.status === "STARTING"
                          ? t("Iniciando")
                          : t("Atenção")}
                    </Badge>
                    <Button
                      variant="destructive"
                      size="sm"
                      onClick={() => void handleDesconectarTelegram(session.id)}
                      disabled={userSaving}
                    >
                      {t("Desconectar")}
                    </Button>
                  </div>
                </div>
              ))}

              {(userData?.sessions?.length ?? 0) > 0 && !userFormOpen && (
                <Button variant="outline" onClick={() => setUserFormOpen(true)}>
                  {t("Conectar outra conta")}
                </Button>
              )}

              {showUserForm &&
                (stepUser === "credentials" ? (
                  <form onSubmit={handleEnviarCodigoTelegram} className="max-w-lg space-y-4">
                    <div className="space-y-2">
                      <Label htmlFor="telegram-phone">{t("Número de Telefone")}</Label>
                      <Input
                        id="telegram-phone"
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
                    <Button
                      type="submit"
                      disabled={userSaving || !userData?.telegram_app_configured}
                    >
                      {userSaving ? t("Enviando código…") : t("Avançar")}
                    </Button>
                  </form>
                ) : stepUser === "code" ? (
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
                    <div className="flex gap-2">
                      <Button type="submit" disabled={userSaving}>
                        {userSaving ? t("Confirmando código…") : t("Continuar")}
                      </Button>
                      <Button variant="outline" type="button" onClick={limparFluxoTelegram}>
                        {t("Cancelar")}
                      </Button>
                    </div>
                  </form>
                ) : (
                  <form onSubmit={handleConfirmarSenhaTelegram} className="max-w-lg space-y-4">
                    <div className="space-y-2">
                      <Label htmlFor="telegram-2fa">{t("Senha de duas etapas do Telegram")}</Label>
                      <Input
                        id="telegram-2fa"
                        type="password"
                        autoComplete="current-password"
                        value={password2FA}
                        onChange={(e) => setPassword2FA(e.target.value)}
                        required
                      />
                    </div>
                    <div className="flex gap-2">
                      <Button type="submit" disabled={userSaving}>
                        {userSaving ? t("Conectando…") : t("Conectar Telegram")}
                      </Button>
                      <Button variant="outline" type="button" onClick={limparFluxoTelegram}>
                        {t("Cancelar")}
                      </Button>
                    </div>
                  </form>
                ))}
            </div>
          </Card>
        </TabsContent>
      </Tabs>
    </div>
  );
}
