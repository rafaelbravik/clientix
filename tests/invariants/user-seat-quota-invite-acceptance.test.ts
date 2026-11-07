import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { sql } from "./gov-helpers";

function uuid(): string {
  return randomUUID();
}

function criarCenario() {
  const orgId = uuid();
  const ownerId = uuid();
  const inviteeId = uuid();
  const inviteeEmail = `invite-seat-${uuid()}@invariant.test`;
  const inviteId = uuid();
  const otherInviteId = uuid();
  const suffix = orgId.replaceAll("-", "");

  sql(`
    insert into public.organizations (id, slug, legal_name, display_name, status, settings)
    values ('${orgId}', 'seat-transfer-${suffix}', 'Seat transfer test', 'Seat transfer test', 'active', '{"plan":"standard"}'::jsonb);
    insert into auth.users (id, email) values ('${ownerId}', 'seat-owner-${suffix}@invariant.test');
    insert into auth.users (id, email) values ('${inviteeId}', '${inviteeEmail}');
    insert into public.user_organizations (organization_id, user_id, role, accepted_at)
    values ('${orgId}', '${ownerId}', 'admin', now());
    insert into public.team_invites (id, organization_id, email, role, invited_by, expires_at)
    values
      ('${inviteId}', '${orgId}', '${inviteeEmail}', 'admin', '${ownerId}', now() + interval '24 hours'),
      ('${otherInviteId}', '${orgId}', 'other-${suffix}@invariant.test', 'agent', '${ownerId}', now() + interval '24 hours');
  `);

  return { orgId, ownerId, inviteeId, inviteeEmail, inviteId, suffix };
}

describe("9063 — aceite converte atomicamente o assento reservado", () => {
  it("aceita um convite no limite sem contar duas vezes o mesmo assento", () => {
    const { orgId, ownerId, inviteeId, inviteId, suffix } = criarCenario();

    const result = JSON.parse(sql(`
      select public.fn_accept_team_invite_atomic(
        '${inviteeId}', '${orgId}', 'admin', '${ownerId}', now(), now(),
        '{"preset":"completa"}'::jsonb, '${inviteId}'
      );
    `)) as { changed: boolean };

    expect(result.changed).toBe(true);
    expect(
      sql(`
        select
          (select count(*) from public.user_organizations where organization_id='${orgId}' and revoked_at is null and accepted_at is not null)
          || '|' ||
          (select count(*) from public.team_invites where organization_id='${orgId}' and accepted_at is null and revoked_at is null and expires_at > now())
          || '|' ||
          (select accepted_by = '${inviteeId}' from public.team_invites where id='${inviteId}')
          || '|' ||
          (select role from public.user_organizations where organization_id='${orgId}' and user_id='${inviteeId}');
      `),
    ).toBe("2|1|true|admin");

    let quotaError = "";
    try {
      sql(`
        insert into public.team_invites (organization_id, email, role, expires_at)
        values ('${orgId}', 'overflow-${suffix}@invariant.test', 'agent', now() + interval '24 hours');
      `);
    } catch (error) {
      const failure = error as { stderr?: Buffer | string; message?: string };
      quotaError = String(failure.stderr ?? "") + String(failure.message ?? "");
    }
    expect(quotaError).toContain("quota_exceeded");
  });

  it("reverte o fechamento do convite quando a criação do vínculo falha", () => {
    const { orgId, inviteeId, inviteId } = criarCenario();
    const missingInviterId = uuid();

    let rejected = false;
    try {
      sql(`
        select public.fn_accept_team_invite_atomic(
          '${inviteeId}', '${orgId}', 'admin', '${missingInviterId}', now(), now(),
          '{"preset":"completa"}'::jsonb, '${inviteId}'
        );
      `);
    } catch (error) {
      const failure = error as { stderr?: Buffer | string; message?: string };
      rejected = `${failure.stderr ?? ""}${failure.message ?? ""}`.includes("foreign key");
    }

    expect(rejected).toBe(true);
    expect(
      sql(`
        select
          (select accepted_at is null and accepted_by is null from public.team_invites where id='${inviteId}')
          || '|' ||
          (select count(*) = 0 from public.user_organizations where organization_id='${orgId}' and user_id='${inviteeId}');
      `),
    ).toBe("true|true");
  });

  it("mantém a nova função restrita ao service_role", () => {
    expect(
      sql(`
        select
          has_function_privilege('anon', 'public.fn_accept_team_invite_atomic(uuid,uuid,text,uuid,timestamptz,timestamptz,jsonb,uuid)', 'execute')
          || '|' || has_function_privilege('authenticated', 'public.fn_accept_team_invite_atomic(uuid,uuid,text,uuid,timestamptz,timestamptz,jsonb,uuid)', 'execute')
          || '|' || has_function_privilege('service_role', 'public.fn_accept_team_invite_atomic(uuid,uuid,text,uuid,timestamptz,timestamptz,jsonb,uuid)', 'execute');
      `),
    ).toBe("false|false|true");
  });
});
