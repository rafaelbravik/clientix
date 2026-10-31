"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";

import {
  completeChatGPTSubscriptionLogin,
  disconnectChatGPTSubscription,
  startChatGPTSubscriptionLogin,
} from "@/app/actions/settings/chatgptSubscription";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { useT } from "@/hooks/i18n/useT";

type StatusSiwc = "not_connected" | "connected" | "expired" | "unreadable";

const ERROS: Record<string, string> = {
  feature_disabled: "O módulo de assinatura está desligado nesta instalação.",
  permission_denied: "Sua função não permite alterar esta credencial.",
  mfa_required: "Confirme a autenticação multifator antes de alterar credenciais.",
  invalid_callback: "A URL de retorno não corresponde ao formato esperado. Inicie a conexão novamente.",
  invalid_state: "A conexão não pôde ser confirmada. Inicie o login novamente nesta organização.",
  expired_state: "Esta tentativa expirou. Inicie a conexão novamente.",
  replayed_nonce: "Esta tentativa já foi usada. Inicie a conexão novamente.",
  identity_mismatch: "Outra conta já está conectada. Desconecte a conta atual antes de vincular outra.",
  token_exchange_failed: "O provedor não concluiu a autorização. Tente conectar novamente.",
  invalid_id_token: "A identidade recebida não pôde ser validada. Tente conectar novamente.",
  credential_unreadable: "A credencial não pôde ser lida com segurança. Desconecte e conecte novamente.",
  configuration_unavailable: "A configuração de conexão não está disponível nesta instalação.",
  storage_failed: "Não foi possível salvar a conexão com segurança. Tente novamente.",
  remote_revoke_failed: "A sessão local foi removida, mas o provedor não confirmou a revogação remota.",
};

export function ChatGPTSubscriptionPanel({ initialStatus }: { initialStatus: StatusSiwc }) {
  const t = useT();
  const router = useRouter();
  const [status, setStatus] = useState(initialStatus);
  const [authorizationUrl, setAuthorizationUrl] = useState<string | null>(null);
  const [callbackUrl, setCallbackUrl] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  function iniciar() {
    setError(null);
    setMessage(null);
    setCallbackUrl("");
    startTransition(async () => {
      const result = await startChatGPTSubscriptionLogin();
      if (!result.ok) {
        setError(result.error);
        return;
      }
      setAuthorizationUrl(result.authorizationUrl);
    });
  }

  function concluir() {
    setError(null);
    setMessage(null);
    startTransition(async () => {
      const result = await completeChatGPTSubscriptionLogin({ callbackUrl });
      if (!result.ok) {
        setError(result.error);
        setAuthorizationUrl(null);
        setCallbackUrl("");
        return;
      }
      setStatus("connected");
      setAuthorizationUrl(null);
      setCallbackUrl("");
      setMessage(result.reconnected ? "Conta reconectada com segurança." : "Conta conectada com segurança.");
      router.refresh();
    });
  }

  function desconectar() {
    if (!window.confirm(t("Desconectar a conta ChatGPT desta organização?"))) return;
    setError(null);
    setMessage(null);
    startTransition(async () => {
      const result = await disconnectChatGPTSubscription();
      if (!result.ok) {
        setError(result.error);
        return;
      }
      setStatus("not_connected");
      setAuthorizationUrl(null);
      setCallbackUrl("");
      setMessage(
        result.remoteRevocation === "not_confirmed"
          ? "A conta foi removida daqui, mas não foi possível confirmar a revogação remota."
          : "Conta desconectada.",
      );
      router.refresh();
    });
  }

  const conectado = status === "connected";

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t("Assinatura do ChatGPT")}</CardTitle>
        <CardDescription>
          {t(
            "Vincule uma conta pelo login oficial do ChatGPT. Esta conexão não ativa o uso por agentes nesta etapa.",
          )}
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div role="status" className="text-sm">
          {conectado
            ? t("Conta conectada")
            : status === "expired"
              ? t("A autorização expirou. Reconecte a conta para renovar o acesso.")
              : status === "unreadable"
                ? t("A conexão não pôde ser lida. Reconecte ou desconecte a conta.")
                : t("Nenhuma conta conectada.")}
        </div>

        {error ? <p role="alert" className="text-sm text-destructive">{t(ERROS[error] ?? "Não foi possível concluir esta operação.")}</p> : null}
        {message ? <p role="status" className="text-sm text-muted-foreground">{t(message)}</p> : null}

        <div className="flex flex-wrap gap-2">
          <Button type="button" onClick={iniciar} disabled={pending}>
            {pending
              ? t("Preparando conexão…")
              : status === "not_connected"
                ? t("Conectar assinatura do ChatGPT")
                : t("Reconectar")}
          </Button>
          {conectado || status === "expired" || status === "unreadable" ? (
            <Button type="button" variant="outline" onClick={desconectar} disabled={pending}>
              {pending ? t("Desconectando…") : t("Desconectar")}
            </Button>
          ) : null}
        </div>

        {authorizationUrl ? (
          <div className="space-y-3 rounded-md border p-4">
            <p className="text-sm">
              {t("Abra o login oficial, conclua a autorização e copie a URL completa exibida pelo navegador para colar abaixo.")}
            </p>
            <Button asChild variant="secondary">
              <a href={authorizationUrl} target="_blank" rel="noopener noreferrer">
                {t("Abrir login do ChatGPT")}
              </a>
            </Button>
            <div className="space-y-2">
              <Label htmlFor="chatgpt-siwc-callback">{t("URL de retorno")}</Label>
              <Textarea
                id="chatgpt-siwc-callback"
                value={callbackUrl}
                onChange={(event) => setCallbackUrl(event.currentTarget.value)}
                autoComplete="off"
                spellCheck={false}
                rows={3}
                maxLength={4096}
                disabled={pending}
              />
            </div>
            <Button type="button" onClick={concluir} disabled={pending || callbackUrl.trim().length === 0}>
              {pending ? t("Validando conexão…") : t("Concluir conexão")}
            </Button>
          </div>
        ) : null}
      </CardContent>
    </Card>
  );
}
