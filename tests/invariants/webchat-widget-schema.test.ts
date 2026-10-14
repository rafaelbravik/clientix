import { describe, expect, it } from "vitest";

import { lastLine, sql } from "./gov-helpers";

function newOrg(): string {
  const slug = `inv-webchat-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;
  sql(`
    insert into public.organizations (slug, legal_name, display_name, settings)
    values ('${slug}', 'WebChat invariant', 'WebChat invariant', '{"plan":"pro"}'::jsonb);
  `);
  return sql(`select id from public.organizations where slug = '${slug}'`).trim();
}

function insertWebchat(input: { org: string; publicId: string; status?: "WORKING" | "STOPPED" }): string {
  const status = input.status ?? "WORKING";
  sql(`
    insert into public.channel_sessions (
      organization_id, provider, webchat_public_id, waha_session_name,
      webhook_secret_encrypted, display_name, status
    ) values (
      '${input.org}', 'webchat', '${input.publicId}', null, null, 'WebChat', '${status}'
    );
  `);
  return sql(`select id from public.channel_sessions where webchat_public_id = '${input.publicId}'`).trim();
}

function errorFrom(fn: () => unknown): string {
  try {
    fn();
  } catch (error) {
    const detail = error as { stderr?: Buffer | string; message?: string };
    return `${detail.stderr ?? ""}${detail.message ?? ""}`;
  }
  throw new Error("a inserção passou; a restrição esperada não foi aplicada");
}

describe("0511 · contrato de schema do WebChat", () => {
  it("reutiliza channel_sessions e mantém a identidade pública única e não secreta", () => {
    const columns = sql(`
      select column_name || '|' || is_nullable
        from information_schema.columns
       where table_schema = 'public' and table_name = 'channel_sessions'
         and column_name in ('webchat_public_id', 'webhook_secret_encrypted')
       order by column_name;
    `).trim();
    expect(columns).toContain("webchat_public_id|YES");
    expect(columns).toContain("webhook_secret_encrypted|YES");

    const orgA = newOrg();
    const publicId = "aaaaaaaa-1111-4111-8111-111111111111";
    const sessionId = insertWebchat({ org: orgA, publicId });
    expect(sessionId).toMatch(/^[0-9a-f-]{36}$/i);

    const duplicateInOrg = errorFrom(() =>
      insertWebchat({ org: orgA, publicId: "aaaaaaaa-1111-4111-8111-111111111112" }),
    );
    expect(duplicateInOrg).toMatch(/channel_sessions_webchat_org_active_unique/);

    const orgB = newOrg();
    const duplicatePublicId = errorFrom(() => insertWebchat({ org: orgB, publicId }));
    expect(duplicatePublicId).toMatch(/channel_sessions_webchat_public_id_unique/);
  });

  it("aceita conversa WebChat na mesma sessão tenant-aware que o Inbox consulta", () => {
    const org = newOrg();
    const publicId = "bbbbbbbb-2222-4222-8222-222222222222";
    const sessionId = insertWebchat({ org, publicId });
    const contactId = lastLine(sql(`
      insert into public.contacts (organization_id, name, display_name, source)
      values ('${org}', 'Visitante', 'Visitante', 'webchat');
      select id from public.contacts where organization_id = '${org}' order by created_at desc limit 1;
    `));
    const conversationId = "cccccccc-3333-4333-8333-333333333333";
    sql(`
      insert into public.conversations (
        id, organization_id, contact_id, channel_session_id, channel,
        provider_conversation_id, status
      ) values (
        '${conversationId}', '${org}', '${contactId}', '${sessionId}', 'webchat',
        '${conversationId}', 'open'
      );
    `);
    expect(
      sql(`select organization_id || '|' || channel || '|' || channel_session_id from public.conversations where id = '${conversationId}'`),
    ).toBe(`${org}|webchat|${sessionId}`);
  });

  it("disabled é um estado válido, mas segue separado da identidade pública", () => {
    const org = newOrg();
    const publicId = "dddddddd-4444-4444-8444-444444444444";
    const id = insertWebchat({ org, publicId, status: "STOPPED" });
    expect(sql(`select status || '|' || webchat_public_id from public.channel_sessions where id = '${id}'`)).toBe(
      `STOPPED|${publicId}`,
    );
  });
});
