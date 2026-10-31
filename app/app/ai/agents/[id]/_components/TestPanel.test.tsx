import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ invalidateQueries: vi.fn(), post: vi.fn() }));
vi.mock("@tanstack/react-query", () => ({ useQueryClient: () => ({ invalidateQueries: mocks.invalidateQueries }) }));
vi.mock("@/lib/api/client", () => ({ apiClient: { post: mocks.post } }));
vi.mock("@/hooks/i18n/useT", () => ({ useT: () => (text: string) => text }));
vi.mock("./RunTrace", () => ({ RunTrace: () => null }));

import type { AgentRow } from "@/hooks/ai/useAgent";
import type { AgentVersionRow } from "@/hooks/ai/useAgentVersions";
import { TestPanel } from "./TestPanel";

const agent = { id: "agent-a" } as AgentRow;
const subscriptionDraft = {
  id: "version-a",
  status: "draft",
  version_number: 1,
  provider: "openai-assinatura",
  model: "gpt-a",
  tool_ids: [],
  system_prompt: "prompt sintético",
} as unknown as AgentVersionRow;

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("preview do provider por assinatura", () => {
  it("mostra o provider e explica o uso da conta sem mencionar chave de API como requisito", () => {
    render(<TestPanel agent={agent} draft={subscriptionDraft} published={null} />);

    expect(screen.getByText(/OpenAI pela assinatura \(ChatGPT\) \/ gpt-a/)).toBeTruthy();
    expect(screen.getByText("O teste usa a assinatura ChatGPT conectada.")).toBeTruthy();
    expect(screen.getByText("Nenhuma mensagem é enviada via WhatsApp. O teste não usa chave de API.")).toBeTruthy();
    expect(mocks.post).not.toHaveBeenCalled();
  });
});
