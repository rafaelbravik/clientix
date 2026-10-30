"use client";
import { useT } from "@/hooks/i18n/useT";
import {
  forwardRef,
  useImperativeHandle,
  useEffect,
  useRef,
  useState,
  type ClipboardEvent,
  type DragEvent,
  type KeyboardEvent,
} from "react";
import { PaperPlaneTilt } from "@/lib/ui/icons";
import { Button } from "@/components/ui/button";
import { AttachMenu } from "@/components/inbox/composer/AttachMenu";
import { AttachmentPreviewDialog } from "@/components/inbox/composer/AttachmentPreviewDialog";
import { ContactPickerDialog } from "@/components/inbox/composer/ContactPickerDialog";
import { QuickRepliesBar } from "@/components/inbox/composer/QuickRepliesBar";
import { AudioRecorder } from "@/components/inbox/composer/AudioRecorder";
import { ReplyReviewPanel } from "@/components/inbox/composer/ReplyReviewPanel";
import { EmojiButton } from "@/components/inbox/composer/EmojiButton";
import { resolveSlash, TemplateMenu } from "@/components/inbox/composer/TemplateMenu";
import { useCreateNote } from "@/hooks/inbox/useCreateNote";
import { useMessageTemplates, type MessageTemplate } from "@/hooks/inbox/useMessageTemplates";
import { X } from "lucide-react";
import { useSendMessage } from "@/hooks/inbox/useSendMessage";
import { useUploadMedia, type DestinoDoUpload } from "@/hooks/inbox/useUploadMedia";
import { imagemDoClipboard } from "@/lib/inbox/clipboard-image";
import { interpolateTemplate } from "@/lib/inbox/template-vars";
import {
  type AvisoDeRascunho,
  type MotivoDeRecusa,
} from "@/lib/inbox/rascunho-sugerido";
import { apiClient } from "@/lib/api/client";
import { cn } from "@/lib/utils";

export interface ComposerHandle {
  focus: () => void;
}

/**
 * O que a tela diz quando o rascunho NÃO vale mais (issue #1611: "a conversa
 * abre sem texto e com aviso").
 *
 * Os quatro motivos são frases separadas de propósito: o atendente precisa
 * saber se o texto expirou, se alguém já usou ou se o link era de outra
 * conversa — e a única coisa que os quatro têm em comum (a conversa abriu sem
 * ele) é justamente o que ele não deve presumir sozinho.
 */
function avisoDeRascunhoIndisponivel(motivo: MotivoDeRecusa, t: (texto: string) => string): string {
  switch (motivo) {
    case "outra_conversa":
      return t("O texto sugerido pertence a outra conversa. A conversa abriu sem ele.");
    case "usado":
      return t("O texto sugerido já foi usado. A conversa abriu sem ele.");
    case "expirado":
      return t("O texto sugerido expirou. A conversa abriu sem ele.");
    case "nao_encontrado":
    default:
      return t("O texto sugerido não foi encontrado. A conversa abriu sem ele.");
  }
}

interface Props {
  conversationId: string;
  userId?: string | null;
  initialDraft?: string;
  initialMode?: "reply" | "note";
  onDraftChange?: (text: string, mode: "reply" | "note") => void;
  active?: boolean;
  disabled?: boolean;
  /** Set true when contact is blocked / anonymized — explanation shown. */
  blockedReason?: string | null;
  /**
   * Janela de 24h fechada: barra a RESPOSTA, e só ela.
   *
   * Separado de `blockedReason` porque a nota interna nunca chega ao cliente —
   * a regra da plataforma não a alcança, e barrá-la tira do atendente
   * justamente o lugar onde ele registra por que a conversa esfriou. A primeira
   * versão deste bloqueio usava `blockedReason` e levou a nota junto.
   */
  janelaFechada?: string | null;
  /**
   * A mensagem que esta resposta CITA, quando o atendente escolheu responder
   * "em cima" de uma. `null` = envio solto, o caso comum.
   *
   * Vem de fora e não daqui porque quem escolhe é a lista de mensagens: o
   * composer só precisa mostrar o que foi escolhido e mandá-lo junto.
   */
  respondendo?: { id: string; body: string | null; direction: string } | null;
  /** Desfaz a escolha — o `x` da faixa de citação. */
  onCancelarResposta?: () => void;
  /** Nome do contato da conversa, para interpolar {{nome}}/{{primeiro_nome}} do template escolhido. */
  contactName?: string | null;
  /** Protocolo da conversa, para interpolar {{protocolo}} do template escolhido. */
  protocolo?: string | null;
  /** Contato da conversa — excluído do seletor de cartão compartilhado. */
  currentContactId?: string | null;
  /**
   * Texto sugerido por integração (issue #1611). O texto em si já vem em
   * `initialDraft` (é ele que preenche o campo); aqui vêm o AVISO de origem e o
   * `draft_id` que o consumo usa depois do clique.
   */
  rascunho?: AvisoDeRascunho | null;
}

export const Composer = forwardRef<ComposerHandle, Props>(function Composer(
  {
    conversationId,
    userId = null,
    initialDraft = "",
    initialMode = "reply",
    active = true,
    onDraftChange,
    disabled,
    blockedReason,
    janelaFechada,
    contactName,
    protocolo,
    currentContactId,
    respondendo,
    onCancelarResposta,
    rascunho = null,
  },
  ref,
) {
  const t = useT();
  const [text, setText] = useState(initialDraft);
  // O aviso some no primeiro ENVIO: depois do clique o rascunho foi usado, e
  // deixar a faixa prometendo texto que já saiu seria mentira de tela.
  const [rascunhoUsado, setRascunhoUsado] = useState(false);
  const [pendingFiles, setPendingFiles] = useState<File[]>([]);
  const [pendingCaption, setPendingCaption] = useState("");
  /**
   * O modo em que o arquivo foi ESCOLHIDO, congelado na escolha — e não o modo
   * em que o diálogo está aberto agora.
   *
   * Sem isto, um anexo escolhido em "Nota interna" que o operador troque para
   * "Responder" antes de clicar Enviar sairia pela rota de MENSAGEM: o arquivo
   * subiria em `whatsapp-media` e iria para o cliente. É exatamente o defeito
   * que a F3 da #1863 existe para não ter — e um dropdown de dois botões não
   * pode ser a única coisa entre um print interno e o celular da pessoa.
   */
  const [pendingEm, setPendingEm] = useState<"reply" | "note">("reply");
  const [contactPickerOpen, setContactPickerOpen] = useState(false);
  const [menuDismissed, setMenuDismissed] = useState(false);
  const [mode, setMode] = useState<"reply" | "note">(initialMode);
  const [draggingFiles, setDraggingFiles] = useState(false);
  const [sendingAttachments, setSendingAttachments] = useState(false);
  const dragDepth = useRef(0);
  const sendingAttachmentsRef = useRef(false);
  useEffect(() => {
    onDraftChange?.(text, mode);
  }, [text, mode, onDraftChange]);
  const taRef = useRef<HTMLTextAreaElement | null>(null);
  const send = useSendMessage();
  const upload = useUploadMedia();
  const createNote = useCreateNote();
  const templates = useMessageTemplates();
  const slash = resolveSlash(text);
  const menuOpen = mode === "reply" && slash.open && !menuDismissed;

  useImperativeHandle(ref, () => ({
    focus: () => taRef.current?.focus(),
  }));

  // send/createNote fora do disable: o texto some na hora do envio; travar o campo
  // até a API voltar impedia digitar a próxima mensagem com o campo ainda cheio.
  const isDisabled = disabled || !!blockedReason || upload.isPending;
  // A janela só alcança o que SAI. Em modo nota o composer segue liberado: a
  // nota interna nunca chega ao cliente, e é onde o atendente registra por que
  // a conversa esfriou — barrá-la tira exatamente o que ainda dá para fazer.
  const respostaBarrada = isDisabled || (mode === "reply" && !!janelaFechada);
  const aceitaArquivos =
    !respostaBarrada && pendingFiles.length === 0 && !sendingAttachments && !sendingAttachmentsRef.current;

  /** Escolhe a fila e MARCA o modo da escolha (ver `pendingEm`). */
  function escolherArquivos(files: File[]) {
    if (!aceitaArquivos || files.length === 0) return;
    setPendingFiles(files);
    setPendingCaption("");
    setPendingEm(mode);
  }

  function transferindoArquivo(e: DragEvent<HTMLElement>): boolean {
    return Array.from(e.dataTransfer.types ?? []).includes("Files");
  }

  function onDragOver(e: DragEvent<HTMLElement>) {
    if (!transferindoArquivo(e)) return;
    // Mesmo bloqueado, impede que o browser navegue para o arquivo solto.
    e.preventDefault();
    e.dataTransfer.dropEffect = aceitaArquivos ? "copy" : "none";
  }

  function onDragEnter(e: DragEvent<HTMLElement>) {
    if (!transferindoArquivo(e) || !aceitaArquivos) return;
    dragDepth.current += 1;
    setDraggingFiles(true);
  }

  function onDragLeave() {
    if (dragDepth.current === 0) return;
    dragDepth.current = Math.max(0, dragDepth.current - 1);
    if (dragDepth.current === 0) setDraggingFiles(false);
  }

  function limparEstadoDeDrag() {
    dragDepth.current = 0;
    setDraggingFiles(false);
  }

  function onDrop(e: DragEvent<HTMLElement>) {
    if (!transferindoArquivo(e)) return;
    e.preventDefault();
    e.stopPropagation();
    const files = Array.from(e.dataTransfer.files ?? []);
    limparEstadoDeDrag();
    if (!aceitaArquivos) return;
    escolherArquivos(files);
  }

  function autoresize() {
    const ta = taRef.current;
    if (!ta) return;
    ta.style.height = "auto";
    ta.style.height = `${Math.min(ta.scrollHeight, 160)}px`;
  }

  function handleSubmit() {
    const body = text.trim();
    if (!body || (mode === "note" ? isDisabled : respostaBarrada)) return;

    setText("");
    requestAnimationFrame(() => autoresize());

    const restoreOnError = () => {
      // Se a pessoa já começou a próxima resposta, preserve os dois textos.
      setText((current) => (current ? `${body}\n${current}` : body));
      requestAnimationFrame(() => autoresize());
    };

    if (mode === "note") {
      createNote.mutate({ conversation_id: conversationId, body }, { onError: restoreOnError });
      return;
    }
    send.mutate(
      {
        conversation_id: conversationId,
        body,
        type: "text",
        ...(respondendo ? { reply_to_message_id: respondendo.id } : {}),
      },
      {
        onSuccess: () => {
          // A citação vale para UMA mensagem. Mantê-la depois do envio faria a
          // próxima frase sair citando algo que o atendente já respondeu.
          onCancelarResposta?.();
          consumirRascunhoEnviado();
          requestAnimationFrame(() => autoresize());
        },
        // Do upstream, e fica: sem isto o texto some quando o envio falha, e
        // quem escreveu um parágrafo o perde sem ter como recuperá-lo.
        onError: restoreOnError,
      },
    );
  }

  /**
   * Marca o rascunho como usado — só depois do ENVIO humano dar certo.
   *
   * Fire-and-forget de propósito: o texto já saiu, e a falha do consumo não pode
   * virar erro de envio. O aviso some na mesma hora (estado local), porque a
   * proposta é de uso único: repetir a dica depois do clique seria encher a tela
   * de alguém que já leu.
   */
  function consumirRascunhoEnviado(): void {
    const leitura = rascunho?.leitura;
    if (rascunhoUsado || leitura?.estado !== "sugerido") return;
    setRascunhoUsado(true);
    void apiClient
      .post(`/api/v1/conversations/${conversationId}/drafts/consume`, {
        draft_id: leitura.draftId,
      })
      .catch(() => {
        /* silêncio: ver docstring */
      });
  }

  function applyTemplate(t: MessageTemplate) {
    const filled = interpolateTemplate(t.body, {
      name: contactName ?? null,
      protocolo: protocolo ?? null,
    });
    setText(filled);
    setMenuDismissed(true);
    const ta = taRef.current;
    if (!ta) return;
    requestAnimationFrame(() => {
      ta.focus();
      ta.selectionStart = ta.selectionEnd = filled.length;
      autoresize();
    });
  }

  /**
   * Ctrl/Cmd+V com imagem no clipboard cai no MESMO caminho do menu "+":
   * abre o preview com legenda e envia por ali. Nada de atalho paralelo — a
   * validação, o toast de erro e o retry já vivem lá.
   *
   * As DUAS guardas antes de olhar o clipboard não são zelo: com um anexo já em
   * preview a colagem substituiria em silêncio o que o operador escolheu, e
   * desabilitado é desabilitado. Em qualquer um desses casos o Ctrl+V precisa
   * continuar sendo o Ctrl+V de sempre.
   *
   * O MODO saiu da guarda (#1863, F3): "Nota interna" passou a aceitar anexo,
   * e a imagem colada ali vira exatamente o mesmo preview de sempre — com o
   * modo congelado na escolha (`escolherArquivos`), para ela não escapar para o
   * cliente se o operador trocar de aba no meio. `respostaBarrada` já cobre os
   * dois modos: em nota ele é só `isDisabled` (a janela fechada barra a
   * RESPOSTA, e só ela — a nota continua sendo o lugar onde se registra por que
   * a conversa esfriou).
   */
  function onPaste(e: ClipboardEvent<HTMLTextAreaElement>) {
    if (respostaBarrada || pendingFiles.length > 0) return;
    const imagem = imagemDoClipboard(e.clipboardData, new Date());
    if (!imagem) return; // colagem de texto segue o caminho normal do browser
    e.preventDefault();
    escolherArquivos([imagem]);
  }

  function onKeyDown(e: KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === "Escape" && menuOpen) {
      setMenuDismissed(true);
      return;
    }
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      if (menuOpen) return; // deixa o Enter pro menu; não envia /query como mensagem
      handleSubmit();
    }
  }

  if (blockedReason) {
    return (
      <div
        data-testid="composer"
        onDragEnter={onDragEnter}
        onDragOver={onDragOver}
        onDragLeave={onDragLeave}
        onDrop={onDrop}
        className="relative border-t border-border bg-muted/40 px-4 py-3 text-center text-xs text-muted-foreground"
      >
        {blockedReason}
      </div>
    );
  }

  return (
    <>
      <div
        className={cn(
          "relative border-t border-border bg-background px-3 py-2",
          mode === "note" && "border-warning/40 bg-warning-bg",
        )}
        data-testid="composer"
        onDragEnter={onDragEnter}
        onDragOver={onDragOver}
        onDragLeave={onDragLeave}
        onDrop={onDrop}
      >
        {draggingFiles && aceitaArquivos && (
          <div
            data-testid="composer-drop-overlay"
            aria-hidden="true"
            className="pointer-events-none absolute inset-2 z-20 flex items-center justify-center rounded-md border-2 border-dashed border-primary bg-primary/10 px-3 text-center text-sm font-medium text-primary"
          >
            {t("Solte o arquivo para anexar")}
          </div>
        )}
        {mode === "reply" && (
          <ReplyReviewPanel conversationId={conversationId} disabled={isDisabled} />
        )}
        {mode === "reply" && (
          <QuickRepliesBar
            userId={userId}
            templates={templates.data ?? []}
            disabled={respostaBarrada}
            onPick={applyTemplate}
          />
        )}
        <TemplateMenu
          open={menuOpen}
          query={slash.query}
          templates={templates.data ?? []}
          onPick={applyTemplate}
          onClose={() => setMenuDismissed(true)}
        />
        {/* O AVISO DO RASCUNHO SUGERIDO (issue #1611) — acima dos modos, sempre
            que a resposta está liberada. Nada aqui envia: a faixa só diz de onde
            veio o texto que já está no campo (e, quando o rascunho não vale
            mais, por que o campo está vazio). */}
        {rascunho && !rascunhoUsado && mode === "reply" && (
          <div
            data-testid="aviso-rascunho"
            className="mb-1.5 flex items-start gap-2 rounded-md border-l-2 border-primary bg-muted/60 px-2 py-1.5 text-xs"
          >
            <p className="min-w-0 flex-1 text-muted-foreground">
              {rascunho.leitura.estado === "sugerido" ? (
                <>
                  {t("Texto sugerido por")}{" "}
                  <span className="font-medium text-foreground">{rascunho.leitura.origem}</span>.{" "}
                  {t("Revise antes de enviar.")}
                </>
              ) : (
                avisoDeRascunhoIndisponivel(rascunho.leitura.motivo, t)
              )}
            </p>
          </div>
        )}
        <div className="mb-1.5 flex gap-1">
          <button
            type="button"
            onClick={() => setMode("reply")}
            className={cn(
              "rounded-full px-2.5 py-1 text-xs font-medium transition-colors",
              mode === "reply"
                ? "bg-accent text-accent-foreground"
                : "text-muted-foreground hover:bg-muted",
            )}
          >
            {t("Responder")}
          </button>
          <button
            type="button"
            onClick={() => setMode("note")}
            className={cn(
              "rounded-full px-2.5 py-1 text-xs font-medium transition-colors",
              mode === "note"
                ? "bg-warning text-warning-fg"
                : "text-muted-foreground hover:bg-muted",
            )}
          >
            {t("Nota interna")}
          </button>
        </div>
        {/*
          A FAIXA DA CITAÇÃO — o que o atendente escolheu responder.

          Fica ACIMA do campo, como no WhatsApp, e não dentro dele: o texto
          citado pode ter várias linhas, e empurrá-lo para dentro do campo faria
          o que se digita disputar espaço com o que se cita.

          `line-clamp-2` porque o objetivo é reconhecer qual mensagem é, não
          relê-la — ela está logo acima, no fio.
        */}
        {respondendo && mode === "reply" && (
          <div className="mb-1 flex items-start gap-2 rounded-md border-l-2 border-primary bg-muted/60 px-2 py-1.5">
            <div className="min-w-0 flex-1">
              <div className="text-[11px] font-medium text-primary">
                {respondendo.direction === "outbound" ? t("Você") : t("Cliente")}
              </div>
              <div className="line-clamp-2 text-xs text-muted-foreground">
                {respondendo.body?.trim() || t("(sem texto)")}
              </div>
            </div>
            <button
              type="button"
              onClick={onCancelarResposta}
              aria-label={t("Cancelar resposta")}
              className="rounded-md p-0.5 text-muted-foreground hover:bg-muted hover:text-foreground"
            >
              <X className="size-4" />
            </button>
          </div>
        )}
        <div className="flex items-end gap-2">
          {/* O "+" existe nos DOIS modos desde a F3 da #1863: em "Nota interna"
              ele abre o mesmo menu, com as DUAS primeiras opções — foto/vídeo e
              documento — porque a nota passou a aceitar anexo. A terceira
              (Contato) some: cartão de contato é `type: "contact"`, uma MENSAGEM
              para o cliente, e nota com cartão de contato não existe. O `disabled`
              continua o de sempre: em modo nota `respostaBarrada` é só
              `isDisabled`, e a janela fechada barra a resposta, não a nota. */}
          <AttachMenu
            disabled={respostaBarrada || pendingFiles.length > 0 || sendingAttachments}
            onPick={escolherArquivos}
            onPickContact={mode === "reply" ? () => setContactPickerOpen(true) : undefined}
          />
          <EmojiButton
            disabled={isDisabled}
            onPick={(emoji) => {
              const ta = taRef.current;
              if (!ta) {
                setText((t) => t + emoji);
                return;
              }
              const start = ta.selectionStart ?? text.length;
              const end = ta.selectionEnd ?? text.length;
              const next = text.slice(0, start) + emoji + text.slice(end);
              setText(next);
              requestAnimationFrame(() => {
                ta.focus();
                ta.selectionStart = ta.selectionEnd = start + emoji.length;
                autoresize();
              });
            }}
          />
          <textarea
            ref={taRef}
            value={text}
            onChange={(e) => {
              setText(e.target.value);
              if (!resolveSlash(e.target.value).open) setMenuDismissed(false);
              autoresize();
            }}
            onKeyDown={onKeyDown}
            onPaste={onPaste}
            rows={1}
            // O atalho saiu do placeholder e foi para o diálogo de atalhos (`?`)
            // e para o `title` aqui. Dois motivos, nesta ordem: ele some assim
            // que se digita a primeira letra — isto é, some justamente quando
            // você ia quebrar linha —; e, com a coluna do inbox mais estreita
            // depois do conserto do layout, a frase quebrava em duas linhas
            // dentro de um campo de uma linha só.
            //
            // "(só o time vê)" FICA: não é atalho, é consequência. Quem escreve
            // uma nota interna precisa saber que ela não vai para o cliente, e
            // essa informação não pode depender de abrir um diálogo.
            placeholder={
              mode === "note"
                ? t("Escreva uma nota interna… (só o time vê)")
                : t("Escreva uma mensagem…")
            }
            title={
              mode === "note"
                ? t("Enter salva a nota · Shift+Enter quebra linha")
                : t("Enter envia · Shift+Enter quebra linha")
            }
            className={cn(
              "max-h-40 min-h-9 flex-1 resize-none rounded-md border border-input bg-background px-3 py-2 text-sm",
              "placeholder:text-muted-foreground focus:ring-1 focus:ring-ring focus:outline-hidden",
            )}
            disabled={mode === "note" ? isDisabled : respostaBarrada}
            aria-label={t("Mensagem")}
          />
          {text.trim() || mode === "note" ? (
            <Button
              type="button"
              size="icon"
              className="h-9 w-9 shrink-0"
              onClick={handleSubmit}
              disabled={(mode === "note" ? isDisabled : respostaBarrada) || !text.trim()}
              aria-label={t("Enviar")}
            >
              <PaperPlaneTilt size={16} weight="fill" aria-hidden />
            </Button>
          ) : (
            active && <AudioRecorder conversationId={conversationId} disabled={respostaBarrada} />
          )}
        </div>
      </div>
      <AttachmentPreviewDialog
        files={pendingFiles}
        caption={pendingCaption}
        onCaptionChange={setPendingCaption}
        sending={sendingAttachments || upload.isPending || send.isPending || createNote.isPending}
        onCancel={() => {
          setPendingFiles([]);
          setPendingCaption("");
        }}
        onSend={async (caption) => {
          if (pendingFiles.length === 0 || sendingAttachmentsRef.current) return;
          // A BIFURCAÇÃO (#1863, F3) — e ela é decidida pelo modo CONGELADO NA
          // ESCOLHA (`pendingEm`), não pelo modo de agora.
          //
          //   reply  → upload em `whatsapp-media` + `useSendMessage`: exatamente
          //            o que era antes, byte por byte. Nada aqui mudou para o
          //            cliente.
          //   note   → upload em `internal-media` + `useCreateNote`, com o trio
          //            como `anexo`. Não existe passo de envio: a nota não é
          //            mensagem, não tem `type`, não tem destino no WhatsApp.
          //
          // Upload e registro/envio continuam usando as mutações existentes. A
          // fila avança só depois de cada item concluir, para um erro preservar
          // o item atual e os seguintes para retry.
          const destino: DestinoDoUpload = pendingEm === "note" ? "nota" : "mensagem";
          const filesToSend = pendingFiles;
          sendingAttachmentsRef.current = true;
          setSendingAttachments(true);
          try {
            for (let index = 0; index < filesToSend.length; index += 1) {
              const file = filesToSend[index]!;
              try {
                const uploaded = await upload.mutateAsync({ conversationId, file, destino });
                const legenda = index === 0 ? caption : "";
                if (destino === "nota") {
                  await createNote.mutateAsync({
                    conversation_id: conversationId,
                    body: legenda,
                    anexo: {
                      storage_path: uploaded.storage_path,
                      media_mime: uploaded.media_mime,
                      media_size_bytes: uploaded.media_size_bytes,
                    },
                  });
                } else {
                  await send.mutateAsync({
                    conversation_id: conversationId,
                    type: uploaded.kind,
                    body: legenda || undefined,
                    media_storage_path: uploaded.storage_path,
                    media_mime: uploaded.media_mime,
                    media_size_bytes: uploaded.media_size_bytes,
                  });
                }
              } catch {
                // O hook já apresenta o erro; a fila continua disponível para retry.
                setPendingFiles(filesToSend.slice(index));
                return;
              }
              setPendingFiles(filesToSend.slice(index + 1));
              if (index === 0) setPendingCaption("");
            }
            setPendingFiles([]);
            setPendingCaption("");
          } finally {
            sendingAttachmentsRef.current = false;
            setSendingAttachments(false);
          }
        }}
      />
      <ContactPickerDialog
        open={contactPickerOpen}
        onOpenChange={setContactPickerOpen}
        excludeContactId={currentContactId}
        sending={send.isPending}
        onPick={(payload) => {
          send.mutate(
            {
              conversation_id: conversationId,
              type: "contact",
              metadata: payload.contactId
                ? { shared_contact_id: payload.contactId }
                : {
                    shared_contact: {
                      name: payload.name,
                      phone_number: payload.phone_number,
                    },
                  },
            },
            { onSuccess: () => setContactPickerOpen(false) },
          );
        }}
      />
    </>
  );
});
