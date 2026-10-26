import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { translate } = vi.hoisted(() => ({ translate: (text: string) => text }));
vi.mock("@/hooks/i18n/useT", () => ({ useT: () => translate }));

import { FileUploadCustomField } from "./FileUploadCustomField";

const LEAD_ID = "22222222-2222-4222-8222-222222222222";
const ATTACHMENT_ID = "33333333-3333-4333-8333-333333333333";

function response(data: unknown, ok = true) {
  return { ok, json: async () => ({ data }) } as Response;
}

beforeEach(() => {
  vi.restoreAllMocks();
});
afterEach(() => vi.unstubAllGlobals());

describe("FileUploadCustomField", () => {
  it("lista metadados via proxy autenticado e não expõe caminho interno do Storage", async () => {
    const fetchMock = vi.fn().mockResolvedValue(response({
      attachments: [{
        id: ATTACHMENT_ID,
        filename: "proposta.pdf",
        mime_type: "application/pdf",
        size_bytes: 2048,
        created_at: "2026-10-26T12:00:00.000Z",
        media_url: `/api/v1/leads/${LEAD_ID}/attachments/${ATTACHMENT_ID}/media`,
      }],
    }));
    vi.stubGlobal("fetch", fetchMock);

    render(<FileUploadCustomField leadId={LEAD_ID} fieldKey="proposta" label="Proposta" />);

    const view = await screen.findByRole("link", { name: "Visualizar proposta.pdf" });
    expect(view).toHaveAttribute("href", `/api/v1/leads/${LEAD_ID}/attachments/${ATTACHMENT_ID}/media?inline=1`);
    expect(view.getAttribute("href")).not.toContain("internal-media");
    expect(await screen.findByRole("link", { name: "Baixar proposta.pdf" })).toHaveAttribute(
      "href",
      `/api/v1/leads/${LEAD_ID}/attachments/${ATTACHMENT_ID}/media?download=1`,
    );
    expect(fetchMock).toHaveBeenCalledWith(
      `/api/v1/leads/${LEAD_ID}/attachments?custom_field_key=proposta`,
      expect.objectContaining({ credentials: "same-origin", cache: "no-store" }),
    );
  });

  it("faz upload multipart e remove via endpoint autenticado", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(response({ attachments: [] }))
      .mockResolvedValueOnce(response({ attachments: [] }))
      .mockResolvedValueOnce(response({ attachments: [] }));
    vi.stubGlobal("fetch", fetchMock);

    render(<FileUploadCustomField leadId={LEAD_ID} fieldKey="contrato" label="Contrato" multiple />);
    const input = screen.getByLabelText("Selecionar arquivos para Contrato");
    const file = new File(["%PDF-1.7\n1 0 obj\n<<>>\nendobj\n"], "contrato.pdf", { type: "application/pdf" });
    fireEvent.change(input, { target: { files: [file] } });

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(3));
    const uploadCall = fetchMock.mock.calls[1];
    expect(uploadCall?.[0]).toBe(`/api/v1/leads/${LEAD_ID}/attachments`);
    expect((uploadCall?.[1] as RequestInit).method).toBe("POST");
    expect((uploadCall?.[1] as RequestInit).body).toBeInstanceOf(FormData);
    expect((uploadCall?.[1] as RequestInit).credentials).toBe("same-origin");
  });

  it("preserva os arquivos ao limpar o input antes da validação assíncrona", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(response({ attachments: [] }))
      .mockResolvedValueOnce(response({ attachments: [] }))
      .mockResolvedValueOnce(response({ attachments: [] }));
    vi.stubGlobal("fetch", fetchMock);

    render(<FileUploadCustomField leadId={LEAD_ID} fieldKey="contrato" label="Contrato" multiple />);
    const input = screen.getByLabelText("Selecionar arquivos para Contrato");
    const file = new File(["%PDF-1.7\n1 0 obj\n<<>>\nendobj\n"], "contrato.pdf", { type: "application/pdf" });
    const liveFileList = [file];
    Object.defineProperty(input, "files", { configurable: true, get: () => liveFileList });
    Object.defineProperty(input, "value", {
      configurable: true,
      get: () => "",
      set: () => { liveFileList.length = 0; },
    });

    fireEvent.change(input);

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(3));
    const body = fetchMock.mock.calls[1]?.[1]?.body;
    expect(body).toBeInstanceOf(FormData);
    expect((body as FormData).getAll("files")).toHaveLength(1);
  });

  it("remove o anexo pelo endpoint autenticado e atualiza a lista", async () => {
    const attachment = {
      id: ATTACHMENT_ID,
      filename: "contrato.pdf",
      mime_type: "application/pdf",
      size_bytes: 2048,
      created_at: "2026-10-26T12:00:00.000Z",
      media_url: `/api/v1/leads/${LEAD_ID}/attachments/${ATTACHMENT_ID}/media`,
    };
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(response({ attachments: [attachment] }))
      .mockResolvedValueOnce(response({ deleted: true }))
      .mockResolvedValueOnce(response({ attachments: [] }));
    vi.stubGlobal("fetch", fetchMock);

    render(<FileUploadCustomField leadId={LEAD_ID} fieldKey="contrato" label="Contrato" multiple />);
    fireEvent.click(await screen.findByRole("button", { name: "Remover contrato.pdf" }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(3));
    expect(fetchMock.mock.calls[1]?.[0]).toBe(
      `/api/v1/leads/${LEAD_ID}/attachments/${ATTACHMENT_ID}`,
    );
    expect((fetchMock.mock.calls[1]?.[1] as RequestInit).method).toBe("DELETE");
    expect(await screen.findByText("Nenhum arquivo anexado.")).toBeInTheDocument();
  });

  it("torna upload control somente leitura quando a permissão não permite mutação", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(response({ attachments: [] })));
    render(<FileUploadCustomField leadId={LEAD_ID} fieldKey="arquivo" label="Arquivo" disabled />);
    expect(await screen.findByLabelText("Selecionar arquivos para Arquivo")).toBeDisabled();
  });
});
