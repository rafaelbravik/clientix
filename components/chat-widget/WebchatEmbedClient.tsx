"use client";

import { useEffect, useRef, useState } from "react";
import { ChatWidgetClient } from "@/app/chat/[token]/_client";
import { useT } from "@/hooks/i18n/useT";

type BootstrapData = { token: string; expires_at: string };

export function WebchatEmbedClient({ widgetPublicId }: { widgetPublicId: string }) {
  const t = useT();
  const [token, setToken] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  const bootstrapStarted = useRef(false);

  useEffect(() => {
    if (bootstrapStarted.current) return;
    bootstrapStarted.current = true;

    const storageKey = `clientix:webchat:${widgetPublicId}`;
    const bootstrap = async (existingToken?: string): Promise<BootstrapData | null> => {
      const response = await fetch("/api/v1/widget/bootstrap", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        cache: "no-store",
        body: JSON.stringify({
          widget_public_id: widgetPublicId,
          ...(existingToken ? { existing_token: existingToken } : {}),
        }),
      });
      const json: unknown = await response.json().catch(() => null);
      if (!response.ok || !json || typeof json !== "object" || !("data" in json)) return null;
      const data = json.data as Partial<BootstrapData>;
      return typeof data.token === "string" && typeof data.expires_at === "string"
        ? { token: data.token, expires_at: data.expires_at }
        : null;
    };

    void (async () => {
      try {
        let previous: string | undefined;
        try {
          previous = sessionStorage.getItem(storageKey) ?? undefined;
        } catch {
          previous = undefined;
        }
        let result = await bootstrap(previous);
        if (!result && previous) {
          try {
            sessionStorage.removeItem(storageKey);
          } catch {
            // Storage indisponível: o token segue apenas em memória.
          }
          result = await bootstrap();
        }
        if (!result) {
          setFailed(true);
          return;
        }
        try {
          sessionStorage.setItem(storageKey, result.token);
        } catch {
          // O iframe continua funcional nesta navegação sem armazenamento local.
        }
        setToken(result.token);
      } catch {
        setFailed(true);
      }
    })();
  }, [widgetPublicId]);

  if (token) return <ChatWidgetClient token={token} preservePath />;
  return (
    <div className="flex h-screen items-center justify-center bg-background p-6 text-center">
      <p className="text-sm text-muted-foreground">
        {failed
          ? t("Atendimento indisponível. Tente novamente mais tarde.")
          : t("Iniciando atendimento…")}
      </p>
    </div>
  );
}
