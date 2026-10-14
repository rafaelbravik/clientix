import { describe, expect, it } from "vitest";
import { findActiveConversationForChannel } from "@/lib/channels/conversation-isolation";

const ORG = "org-a";
const CONTACT = "contact-a";
const rows = [
  {
    id: "wa-conversation",
    organization_id: ORG,
    contact_id: CONTACT,
    channel: "whatsapp",
    channel_session_id: "wa-session",
    archived_at: null,
    status: "open",
  },
  {
    id: "ig-other-account",
    organization_id: ORG,
    contact_id: CONTACT,
    channel: "instagram",
    channel_session_id: "ig-session-other",
    archived_at: null,
    status: "open",
  },
  {
    id: "ig-other-tenant",
    organization_id: "org-b",
    contact_id: CONTACT,
    channel: "instagram",
    channel_session_id: "ig-session",
    archived_at: null,
    status: "open",
  },
  {
    id: "ig-current",
    organization_id: ORG,
    contact_id: CONTACT,
    channel: "instagram",
    channel_session_id: "ig-session",
    archived_at: null,
    status: "open",
  },
];

function adminWithRows() {
  const filters = new Map<string, unknown>();
  const query: Record<string, unknown> = {};
  let selectedColumns: string[] = [];
  query.select = (columns: string) => {
    selectedColumns = columns.split(",").map((column) => column.trim());
    return query;
  };
  query.eq = (column: string, value: unknown) => {
    filters.set(column, value);
    return query;
  };
  query.is = (column: string, value: unknown) => {
    filters.set(column, value);
    return query;
  };
  query.order = () => query;
  query.limit = () => query;
  query.maybeSingle = async () => ({
    data: (() => {
      const row = rows.find((candidate) =>
        [...filters].every(
          ([column, value]) => candidate[column as keyof typeof candidate] === value,
        ),
      );
      return row
        ? Object.fromEntries(
            selectedColumns.map((column) => [column, row[column as keyof typeof row]]),
          )
        : null;
    })(),
    error: null,
  });
  return { from: () => query } as never;
}

describe("identidade de conversa por canal", () => {
  it("não reutiliza conversa WhatsApp, de outra conta social ou de outro tenant", async () => {
    const conversation = await findActiveConversationForChannel(adminWithRows(), {
      organizationId: ORG,
      contactId: CONTACT,
      channel: "instagram",
      channelSessionId: "ig-session",
    });

    expect(conversation).toEqual({ id: "ig-current", status: "open" });
  });

  it("não reutiliza conversa de outro canal quando ainda não há conversa Instagram", async () => {
    const conversation = await findActiveConversationForChannel(adminWithRows(), {
      organizationId: ORG,
      contactId: CONTACT,
      channel: "tiktok",
      channelSessionId: "tt-session",
    });

    expect(conversation).toBeNull();
  });
});
