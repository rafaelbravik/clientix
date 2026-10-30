import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { beforeEach, describe, expect, it, vi } from "vitest";

const uploadMock = vi.fn(async ({ file }: { file: File }) => ({
  storage_path: `org/conv/${file.name}`,
  media_mime: file.type || "application/octet-stream",
  media_size_bytes: file.size,
  kind: file.type.startsWith("image/") ? ("image" as const) : ("document" as const),
}));
const sendMock = vi.fn();
const sendAsyncMock = vi.fn(async (args: unknown) => {
  sendMock(args);
  return {};
});
const noteMock = vi.fn();
const noteAsyncMock = vi.fn(async (args: unknown) => {
  noteMock(args);
  return {};
});

vi.mock("@/hooks/inbox/useUploadMedia", () => ({
  useUploadMedia: () => ({ mutateAsync: uploadMock, isPending: false }),
}));
vi.mock("@/hooks/inbox/useSendMessage", () => ({
  useSendMessage: () => ({ mutate: sendMock, mutateAsync: sendAsyncMock, isPending: false }),
}));
vi.mock("@/hooks/inbox/useCreateNote", () => ({
  useCreateNote: () => ({ mutate: noteMock, mutateAsync: noteAsyncMock, isPending: false }),
}));
vi.mock("@/hooks/inbox/useMessageTemplates", () => ({ useMessageTemplates: () => ({ data: [] }) }));
vi.mock("@/hooks/inbox/useDraftReply", () => ({ useDraftReply: () => ({ mutate: vi.fn(), isPending: false }) }));
vi.mock("@/hooks/auth/AuthProvider", () => ({ usePermission: () => true }));

import { Composer } from "@/components/inbox/Composer";

function file(name: string, type = "application/pdf") {
  return new File([new Uint8Array([1, 2, 3])], name, { type });
}

function transfer(files: File[], types: string[] = ["Files"]) {
  return { files, types, dropEffect: "none" } as unknown as DataTransfer;
}

function renderComposer(props: Partial<React.ComponentProps<typeof Composer>> = {}) {
  return render(
    <QueryClientProvider client={new QueryClient()}>
      <Composer conversationId="conv-8m" {...props} />
    </QueryClientProvider>,
  );
}

function drop(files: File[], target = screen.getByTestId("composer")) {
  return fireEvent.drop(target, { dataTransfer: transfer(files) });
}

describe("Composer — drag & drop convergente", () => {
  beforeEach(() => {
    uploadMock.mockClear();
    sendMock.mockClear();
    sendAsyncMock.mockClear();
    noteMock.mockClear();
    noteAsyncMock.mockClear();
    uploadMock.mockImplementation(async ({ file: item }) => ({
      storage_path: `org/conv/${item.name}`,
      media_mime: item.type || "application/octet-stream",
      media_size_bytes: item.size,
      kind: item.type.startsWith("image/") ? ("image" as const) : ("document" as const),
    }));
    sendAsyncMock.mockImplementation(async (args) => {
      sendMock(args);
      return {};
    });
    noteAsyncMock.mockImplementation(async (args) => {
      noteMock(args);
      return {};
    });
  });

  it("botão e drop abrem o mesmo preview", async () => {
    const { unmount } = renderComposer();
    fireEvent.click(screen.getByRole("button", { name: /anexar/i }));
    const input = document.querySelector('input[accept^=".pdf"]') as HTMLInputElement;
    const buttonFile = file("botao.pdf");
    fireEvent.change(input, { target: { files: [buttonFile] } });
    expect(await screen.findByRole("dialog")).toBeInTheDocument();
    expect(screen.getByText("botao.pdf")).toBeInTheDocument();
    unmount();

    renderComposer();
    drop([file("drop.pdf")]);
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText("drop.pdf")).toBeInTheDocument();
    expect(uploadMock).not.toHaveBeenCalled();
  });

  it("mantém ordem de vários arquivos e só faz upload depois de confirmar", async () => {
    renderComposer();
    const files = [file("a.pdf"), file("b.pdf"), file("c.pdf")];
    drop(files);

    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByRole("list", { name: "Arquivos selecionados" })).toHaveTextContent(
      "1.a.pdf3 B2.b.pdf3 B3.c.pdf3 B",
    );
    expect(uploadMock).not.toHaveBeenCalled();
    fireEvent.change(within(dialog).getByLabelText("Legenda"), { target: { value: "documentos" } });
    fireEvent.click(within(dialog).getByRole("button", { name: /^enviar$/i }));

    await waitFor(() => expect(uploadMock).toHaveBeenCalledTimes(3));
    expect(uploadMock.mock.calls.map(([args]) => args.file.name)).toEqual(["a.pdf", "b.pdf", "c.pdf"]);
    expect(sendMock.mock.calls.map(([args]) => (args as { media_storage_path: string }).media_storage_path)).toEqual([
      "org/conv/a.pdf",
      "org/conv/b.pdf",
      "org/conv/c.pdf",
    ]);
    expect((sendMock.mock.calls[0]![0] as { body?: string }).body).toBe("documentos");
    expect((sendMock.mock.calls[1]![0] as { body?: string }).body).toBeUndefined();
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
  });

  it("recusa segundo drop enquanto o preview está aberto e não substitui a fila", async () => {
    renderComposer();
    drop([file("original.pdf")]);
    const dialog = await screen.findByRole("dialog");

    const dataTransfer = transfer([file("segundo.pdf")]);
    const dropWasPrevented = fireEvent.drop(screen.getByTestId("composer"), { dataTransfer });

    expect(dropWasPrevented).toBe(false);
    expect(within(dialog).getByText("original.pdf")).toBeInTheDocument();
    expect(within(dialog).queryByText("segundo.pdf")).not.toBeInTheDocument();
    expect(uploadMock).not.toHaveBeenCalled();
  });

  it("o botão também aceita uma seleção múltipla em ordem na mesma fila", async () => {
    renderComposer();
    fireEvent.click(screen.getByRole("button", { name: /anexar/i }));
    const input = document.querySelector('input[accept^=".pdf"]') as HTMLInputElement;
    fireEvent.change(input, { target: { files: [file("primeiro.pdf"), file("segundo.pdf")] } });

    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByRole("list", { name: "Arquivos selecionados" })).toHaveTextContent(
      "1.primeiro.pdf3 B2.segundo.pdf3 B",
    );
    expect(uploadMock).not.toHaveBeenCalled();
  });

  it("bloqueia drop de resposta com janela fechada, mas permite nota interna", async () => {
    renderComposer({ janelaFechada: "A janela de 24 horas fechou." });
    const dataTransfer = transfer([file("bloqueado.pdf")]);
    expect(fireEvent.dragOver(screen.getByTestId("composer"), { dataTransfer })).toBe(false);
    expect(dataTransfer.dropEffect).toBe("none");
    drop([file("bloqueado.pdf")]);
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /nota interna/i }));
    drop([file("nota.pdf")]);
    const dialog = await screen.findByRole("dialog");
    fireEvent.click(within(dialog).getByRole("button", { name: /^enviar$/i }));

    await waitFor(() =>
      expect(uploadMock).toHaveBeenCalledWith(expect.objectContaining({ conversationId: "conv-8m", destino: "nota" })),
    );
    await waitFor(() => expect(noteMock).toHaveBeenCalledWith(expect.objectContaining({ conversation_id: "conv-8m" })));
    expect(sendMock).not.toHaveBeenCalled();
  });

  it("com Composer bloqueado impede navegação do browser e recusa o arquivo", () => {
    renderComposer({ disabled: true });
    const dataTransfer = transfer([file("bloqueado.pdf")]);

    expect(fireEvent.dragOver(screen.getByTestId("composer"), { dataTransfer })).toBe(false);
    expect(dataTransfer.dropEffect).toBe("none");
    drop([file("bloqueado.pdf")]);
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(uploadMock).not.toHaveBeenCalled();
  });

  it("com bloqueio de contato também recusa o drop e impede a navegação", () => {
    renderComposer({ blockedReason: "Contato indisponível." });
    const dataTransfer = transfer([file("bloqueado.pdf")]);
    expect(fireEvent.dragOver(screen.getByTestId("composer"), { dataTransfer })).toBe(false);
    expect(dataTransfer.dropEffect).toBe("none");
    drop([file("bloqueado.pdf")]);
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(uploadMock).not.toHaveBeenCalled();
  });

  it("define o destino de nota no instante do drop", async () => {
    renderComposer();
    fireEvent.click(screen.getByRole("button", { name: /nota interna/i }));
    drop([file("nota-interna.pdf")]);
    const dialog = await screen.findByRole("dialog");
    const responder = [...document.querySelectorAll("button")].find((button) => button.textContent?.trim() === "Responder");
    if (responder) fireEvent.click(responder);
    fireEvent.click(within(dialog).getByRole("button", { name: /^enviar$/i }));

    await waitFor(() => expect(uploadMock).toHaveBeenCalledWith(expect.objectContaining({ destino: "nota" })));
    await waitFor(() => expect(noteMock).toHaveBeenCalled());
    expect(sendMock).not.toHaveBeenCalled();
  });

  it("ignora arraste e drop de texto sem cancelar o comportamento do browser", () => {
    renderComposer();
    const plainText = transfer([], ["text/plain"]);
    expect(fireEvent.dragOver(screen.getByTestId("composer"), { dataTransfer: plainText })).toBe(true);
    expect(fireEvent.drop(screen.getByTestId("composer"), { dataTransfer: plainText })).toBe(true);
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("realça no dragenter, não pisca em filho e limpa no leave/drop", async () => {
    renderComposer();
    const root = screen.getByTestId("composer");
    const child = screen.getByLabelText("Mensagem");
    const dataTransfer = transfer([file("arrasto.pdf")]);
    fireEvent.dragEnter(root, { dataTransfer });
    expect(screen.getByTestId("composer-drop-overlay")).toHaveTextContent("Solte o arquivo para anexar");
    fireEvent.dragEnter(child, { dataTransfer });
    fireEvent.dragLeave(child, { dataTransfer });
    expect(screen.getByTestId("composer-drop-overlay")).toBeInTheDocument();
    drop([file("arrasto.pdf")]);
    expect(screen.queryByTestId("composer-drop-overlay")).not.toBeInTheDocument();
    expect(await screen.findByRole("dialog")).toBeInTheDocument();
  });

  it("limpa o realce no leave real e escolhe dropEffect copy quando permitido", () => {
    renderComposer();
    const root = screen.getByTestId("composer");
    const dataTransfer = transfer([file("arrasto.pdf")]);
    expect(fireEvent.dragOver(root, { dataTransfer })).toBe(false);
    expect(dataTransfer.dropEffect).toBe("copy");
    fireEvent.dragEnter(root, { dataTransfer });
    expect(screen.getByTestId("composer-drop-overlay")).toBeInTheDocument();
    fireEvent.dragLeave(root, { dataTransfer });
    expect(screen.queryByTestId("composer-drop-overlay")).not.toBeInTheDocument();
  });

  it("mantém a fila no preview para retry quando o upload falha", async () => {
    uploadMock.mockRejectedValueOnce(new Error("upload_failed"));
    renderComposer();
    drop([file("retry.pdf")]);
    const dialog = await screen.findByRole("dialog");
    fireEvent.click(within(dialog).getByRole("button", { name: /^enviar$/i }));
    await waitFor(() => expect(uploadMock).toHaveBeenCalledTimes(1));
    expect(within(dialog).getByText("retry.pdf")).toBeInTheDocument();
    expect(sendMock).not.toHaveBeenCalled();

    fireEvent.click(within(dialog).getByRole("button", { name: /^enviar$/i }));
    await waitFor(() => expect(uploadMock).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(sendMock).toHaveBeenCalledTimes(1));
  });

  it("não faz upload se a confirmação não for acionada", async () => {
    renderComposer();
    drop([file("sem-confirmar.pdf")]);
    expect(await screen.findByRole("dialog")).toBeInTheDocument();
    expect(uploadMock).not.toHaveBeenCalled();
    expect(sendMock).not.toHaveBeenCalled();
  });
});
