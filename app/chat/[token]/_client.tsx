"use client";

import { useEffect, useRef, useState } from "react";
import { Check, Copy, PaperPlaneTilt, CircleNotch as Spinner } from "@/lib/ui/icons";
import { copyToClipboard } from "@/lib/clipboard";
import { useT } from "@/hooks/i18n/useT";

interface MessageItem {
  id: string;
  direction: "inbound" | "outbound";
  body: string | null;
  kind: string;
  sent_at: string;
  status: string;
}

interface ChatData {
  conversation: {
    id: string;
    protocolo: string | null;
    status: string;
    contact?: {
      display_name?: string | null;
      name?: string | null;
    } | null;
  };
  organization: {
    name: string;
    app_name: string;
    logo_url: string | null;
    accent_color: string;
  };
  messages: MessageItem[];
}

export function ChatWidgetClient({ token }: { token?: string }) {
  const t = useT();
  const [data, setData] = useState<ChatData | null>(null);
  const [loading, setLoading] = useState(true);
  const [erro, setErro] = useState<string | null>(null);
  const [inputText, setInputText] = useState("");
  const [sending, setSending] = useState(false);
  const [copiado, setCopiado] = useState(false);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const tokenRef = useRef<string>(token || "");

  // 1. Limpeza segura da URL no bootstrap (FASE E: URL Cleanup)
  // Remove o token da barra de endereço para evitar vazamento em histórico e referrer
  useEffect(() => {
    if (typeof window !== "undefined" && window.location.pathname.startsWith("/chat/")) {
      const novaUrl = window.location.origin + "/chat/session";
      // Preserva o histórico substituindo o caminho sem recarregar a página
      window.history.replaceState({ sessionBootstrapped: true }, "", novaUrl);
    }
  }, []);

  // 2. Carrega dados do chat via Authorization Bearer e cookie HttpOnly
  const carregarChat = async (isBackground = false): Promise<"ok" | "fatal" | "transient"> => {
    try {
      const headers: Record<string, string> = {};
      if (tokenRef.current) {
        headers["Authorization"] = `Bearer ${tokenRef.current}`;
      }
      const res = await fetch("/api/v1/widget/chat", { headers });
      if (!res.ok) {
        if (res.status === 401 || res.status === 403 || res.status === 404) {
          setErro("Este link de atendimento é inválido ou expirou.");
          return "fatal";
        }
        if (!isBackground) {
          setErro("Serviço de atendimento temporariamente indisponível.");
        }
        return "transient";
      }
      const json = await res.json();
      if (json.ok && json.data) {
        setData(json.data);
        setErro(null);
      }
      return "ok";
    } catch {
      if (!isBackground) {
        setErro("Não foi possível conectar ao servidor de atendimento.");
      }
      return "transient";
    } finally {
      if (!isBackground) setLoading(false);
    }
  };

  useEffect(() => {
    let pollingAtivo = true;
    void carregarChat();

    // Polling inteligente e racionalizado (5s ativo, 20s em segundo plano).
    // Interrompe imediatamente se o link expirar ou for inválido (401/403/404), mas tolera falhas de rede transitórias.
    const loop = async () => {
      while (pollingAtivo) {
        const delay = typeof document !== "undefined" && document.hidden ? 20000 : 5000;
        await new Promise((resolve) => setTimeout(resolve, delay));
        if (!pollingAtivo) break;
        const resultado = await carregarChat(true);
        if (resultado === "fatal") {
          pollingAtivo = false;
          break;
        }
      }
    };

    void loop();

    return () => {
      pollingAtivo = false;
    };
  }, [token]);

  // Rola suavemente para a última mensagem
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [data?.messages]);

  // 3. Envio de nova mensagem via Authorization Bearer
  const handleEnviar = async (e?: React.FormEvent) => {
    if (e) e.preventDefault();
    const texto = inputText.trim();
    if (!texto || sending) return;

    setInputText("");
    setSending(true);

    // Mensagem otimista imediata
    const msgOtimista: MessageItem = {
      id: `temp-${Date.now()}`,
      direction: "inbound",
      body: texto,
      kind: "text",
      sent_at: new Date().toISOString(),
      status: "sending",
    };

    setData((prev) => (prev ? { ...prev, messages: [...prev.messages, msgOtimista] } : prev));

    try {
      const headers: Record<string, string> = { "Content-Type": "application/json" };
      if (tokenRef.current) {
        headers["Authorization"] = `Bearer ${tokenRef.current}`;
      }
      const res = await fetch("/api/v1/widget/chat/messages", {
        method: "POST",
        headers,
        body: JSON.stringify({ body: texto }),
      });

      if (res.ok) {
        void carregarChat(true);
      }
    } catch {
      // Deixa mensagem visível e sincroniza no próximo ciclo
    } finally {
      setSending(false);
    }
  };

  const handleCopiarProtocolo = async () => {
    if (!data?.conversation.protocolo) return;
    await copyToClipboard(data.conversation.protocolo);
    setCopiado(true);
    setTimeout(() => setCopiado(false), 2000);
  };

  if (loading) {
    return (
      <div className="flex h-full w-full flex-col items-center justify-center gap-3">
        <Spinner size={32} className="animate-spin text-primary" />
        <p className="text-sm text-muted-foreground">Iniciando canal de atendimento...</p>
      </div>
    );
  }

  if (erro || !data) {
    return (
      <div className="flex h-full w-full flex-col items-center justify-center p-6 text-center">
        <div className="rounded-full bg-destructive/10 p-3 text-destructive">
          <span className="text-2xl font-bold">!</span>
        </div>
        <h2 className="mt-4 text-base font-semibold">{t("Atendimento indisponível")}</h2>
        <p className="mt-2 text-sm text-muted-foreground max-w-xs">{erro}</p>
      </div>
    );
  }

  const { organization, conversation, messages } = data;
  const accentColor = organization.accent_color || "#0284c7";

  return (
    <div className="mx-auto flex h-full w-full max-w-2xl flex-col bg-background shadow-lg sm:border sm:border-border sm:my-auto sm:h-[94vh] sm:rounded-2xl overflow-hidden">
      {/* ── Topo do Chat ── */}
      <header className="flex shrink-0 items-center justify-between border-b border-border bg-card px-4 py-3">
        <div className="flex items-center gap-3">
          {organization.logo_url ? (
            <img
              src={organization.logo_url}
              alt={organization.name}
              className="h-10 w-10 rounded-full border border-border object-cover"
            />
          ) : (
            <div
              className="flex h-10 w-10 items-center justify-center rounded-full text-white font-semibold text-sm shadow-sm"
              style={{ backgroundColor: accentColor }}
            >
              {organization.name.slice(0, 2).toUpperCase()}
            </div>
          )}
          <div>
            <h1 className="text-sm font-semibold text-foreground leading-tight">
              {organization.app_name || organization.name}
            </h1>
            <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
              <span className="h-2 w-2 rounded-full bg-emerald-500 inline-block animate-pulse" />
              Online no atendimento
            </p>
          </div>
        </div>

        {/* Protocolo */}
        {conversation.protocolo && (
          <button
            type="button"
            onClick={handleCopiarProtocolo}
            className="flex items-center gap-1.5 rounded-lg border border-border/80 bg-muted/60 px-2.5 py-1 text-xs font-mono text-muted-foreground hover:bg-muted hover:text-foreground transition-colors cursor-pointer"
            title={t("Copiar número do protocolo")}
          >
            <span>#{conversation.protocolo}</span>
            {copiado ? (
              <Check size={12} className="text-emerald-500" aria-hidden />
            ) : (
              <Copy size={12} aria-hidden />
            )}
          </button>
        )}
      </header>

      {/* ── Lista de Mensagens ── */}
      <main className="flex-1 overflow-y-auto p-4 space-y-3 bg-muted/20">
        <div className="flex justify-center">
          <span className="rounded-full bg-muted/60 px-3 py-1 text-[11px] font-medium text-muted-foreground">
            {t("Início do atendimento seguro")}
          </span>
        </div>

        {messages.map((m) => {
          const isMe = m.direction === "inbound";
          return (
            <div
              key={m.id}
              className={`flex w-full ${isMe ? "justify-end" : "justify-start"}`}
            >
              <div
                className={`max-w-[82%] rounded-2xl px-4 py-2.5 shadow-xs text-sm leading-relaxed ${
                  isMe
                    ? "rounded-tr-xs text-white"
                    : "rounded-tl-xs bg-card border border-border/70 text-foreground"
                }`}
                style={isMe ? { backgroundColor: accentColor } : undefined}
              >
                <p className="whitespace-pre-wrap break-words">{m.body}</p>
                <div
                  className={`mt-1 flex items-center justify-end gap-1 text-[10px] ${
                    isMe ? "text-white/80" : "text-muted-foreground"
                  }`}
                >
                  <span>
                    {new Date(m.sent_at).toLocaleTimeString([], {
                      hour: "2-digit",
                      minute: "2-digit",
                    })}
                  </span>
                  {isMe && (
                    <span className="opacity-90">
                      {m.status === "sending" ? "..." : "✓✓"}
                    </span>
                  )}
                </div>
              </div>
            </div>
          );
        })}
        <div ref={messagesEndRef} />
      </main>

      {/* ── Barra de Envio Inferior ── */}
      <footer className="shrink-0 border-t border-border bg-card p-3">
        <form onSubmit={handleEnviar} className="flex items-center gap-2">
          <input
            type="text"
            value={inputText}
            onChange={(e) => setInputText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                void handleEnviar();
              }
            }}
            placeholder={t("Digite sua mensagem…")}
            className="flex-1 rounded-full border border-border bg-background px-4 py-2.5 text-sm text-foreground placeholder:text-muted-foreground focus:outline-hidden focus:ring-2 focus:ring-ring focus:ring-offset-1"
          />
          <button
            type="submit"
            disabled={!inputText.trim() || sending}
            className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full text-white transition-opacity disabled:opacity-50 cursor-pointer shadow-xs"
            style={{ backgroundColor: accentColor }}
            title="Enviar mensagem"
          >
            {sending ? (
              <Spinner size={16} className="animate-spin" />
            ) : (
              <PaperPlaneTilt size={16} weight="fill" />
            )}
          </button>
        </form>
      </footer>
    </div>
  );
}
