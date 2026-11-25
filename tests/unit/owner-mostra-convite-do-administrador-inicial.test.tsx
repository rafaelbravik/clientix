import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

vi.mock("@/hooks/i18n/useT", () => ({ useT: () => (text: string) => text }));
vi.mock("@/lib/random-id", () => ({ randomId: () => "owner-invite-test-key" }));
vi.mock("@/lib/clipboard", () => ({ copyToClipboard: vi.fn() }));
vi.mock("@/app/owner/_subscription-manager", () => ({ OwnerSubscriptionManager: () => null }));

import { copyToClipboard } from "@/lib/clipboard";
import { OwnerConsole } from "@/app/owner/_owner-console";

const fetchMock = vi.fn();
const copyMock = vi.mocked(copyToClipboard);
const INVITE_URL = "http://127.0.0.1:3000/accept-invite?token=owner-invite-test";

describe("painel do proprietário: convite do administrador inicial", () => {
  beforeEach(() => {
    fetchMock.mockReset();
    copyMock.mockReset();
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it("exibe e permite copiar o link retornado pela criação da empresa", async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({
        data: {
          id: "tenant-1",
          slug: "empresa-teste",
          display_name: "Empresa Teste",
          owner_invitation: {
            accept_url: INVITE_URL,
            expires_at: "2026-12-02T12:00:00.000Z",
            email_dispatched: false,
          },
        },
      }),
    });
    copyMock.mockResolvedValue(true);

    render(<OwnerConsole ownerEmail="owner@example.test" />);
    fireEvent.change(screen.getByLabelText("Nome da empresa"), {
      target: { value: "Empresa Teste" },
    });
    fireEvent.change(screen.getByLabelText("Identificador"), {
      target: { value: "empresa-teste" },
    });
    fireEvent.change(screen.getByLabelText("Plano"), { target: { value: "standard" } });
    fireEvent.change(screen.getByLabelText("E-mail do administrador inicial"), {
      target: { value: "tenant.admin@example.test" },
    });
    fireEvent.submit(screen.getByRole("button", { name: "Criar empresa" }).closest("form")!);

    const linkInput = await screen.findByLabelText("Link do convite do administrador");
    expect(linkInput).toHaveValue(INVITE_URL);
    expect(linkInput).toHaveAttribute("readonly");
    expect(
      screen.getByText(
        "O envio por e-mail não foi confirmado. Copie o link e compartilhe com o administrador.",
      ),
    ).toBeInTheDocument();
    expect(screen.getByText(/Válido até/)).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Copiar convite do administrador" }));
    await waitFor(() => expect(copyMock).toHaveBeenCalledWith(INVITE_URL));
    expect(await screen.findByText("Link do convite copiado.")).toBeInTheDocument();
  });
});
