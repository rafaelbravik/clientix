-- 9063 — accepting a pending invite consumes its reserved seat atomically.
-- The invitation row and its membership are changed by one transaction so the
-- quota trigger never counts the same seat as both pending and active.

create or replace function public.fn_accept_team_invite_atomic(
  p_user uuid,
  p_org uuid,
  p_role text,
  p_invited_by uuid,
  p_issued_at timestamptz,
  p_invited_at timestamptz,
  p_interface_settings jsonb,
  p_invite_id uuid
) returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  m public.user_organizations%rowtype;
  v_invite public.team_invites%rowtype;
begin
  if p_role not in ('viewer', 'agent', 'manager', 'admin') then
    raise exception 'invalid_role' using errcode = '22023';
  end if;

  perform pg_advisory_xact_lock(hashtextextended(p_user::text || ':' || p_org::text, 0));

  if not exists (
    select 1 from public.organizations where id = p_org and status = 'active'
  ) then
    raise exception 'organization_unavailable' using errcode = '42501';
  end if;

  -- A persisted invite reserves a seat. Lock and accept that exact row before
  -- inserting the membership; both changes commit or roll back together.
  -- A missing row remains compatible with pre-0238 stateless invitations.
  if p_invite_id is not null then
    select * into v_invite
      from public.team_invites
     where id = p_invite_id
     for update;

    if found then
      if v_invite.organization_id <> p_org
         or v_invite.role is distinct from p_role
         or v_invite.revoked_at is not null
         or not exists (
           select 1 from auth.users
            where id = p_user and lower(email) = lower(v_invite.email)
         ) then
        raise exception 'invite_unavailable' using errcode = '42501';
      end if;

      if v_invite.accepted_at is not null then
        if v_invite.accepted_by is distinct from p_user then
          raise exception 'invite_already_accepted' using errcode = '42501';
        end if;
      else
        if v_invite.expires_at <= clock_timestamp() then
          raise exception 'invite_expired' using errcode = '42501';
        end if;

        update public.team_invites
           set accepted_at = clock_timestamp(), accepted_by = p_user
         where id = v_invite.id
           and organization_id = p_org
           and accepted_at is null
           and revoked_at is null
        returning * into v_invite;

        if not found then
          raise exception 'invite_unavailable' using errcode = '42501';
        end if;
      end if;
    end if;
  end if;

  select * into m
    from public.user_organizations
   where organization_id = p_org and user_id = p_user
   for update;

  if found and m.revoked_at is null and m.accepted_at is not null then
    return jsonb_build_object('id', m.id, 'changed', false);
  end if;

  if found and m.revoked_at is not null
     and (p_issued_at is null or p_issued_at <= m.revoked_at) then
    raise exception 'invite_revoked' using errcode = '42501';
  end if;

  if m.id is not null then
    update public.user_organizations
       set role = p_role,
           revoked_at = null,
           interface_settings = p_interface_settings,
           invited_by = coalesce(p_invited_by, invited_by),
           invited_at = p_invited_at,
           accepted_at = clock_timestamp(),
           updated_at = clock_timestamp()
     where organization_id = p_org and id = m.id
    returning * into m;
  else
    insert into public.user_organizations(
      organization_id, user_id, role, invited_by, invited_at, accepted_at, interface_settings
    ) values (
      p_org, p_user, p_role, p_invited_by, p_invited_at, clock_timestamp(), p_interface_settings
    ) returning * into m;
  end if;

  -- The owner has assumed the team. Remove only provisional memberships after
  -- the invited administrator is active, in the same transaction.
  if p_role = 'admin' then
    delete from public.attendant_availability av
     where av.organization_id = p_org
       and av.user_id <> p_user
       and exists (
         select 1 from public.user_organizations uo
          where uo.organization_id = p_org
            and uo.user_id = av.user_id
            and uo.provisional_until_handover
       );

    delete from public.user_organizations uo
     where uo.organization_id = p_org
       and uo.provisional_until_handover
       and uo.user_id <> p_user;
  end if;

  return jsonb_build_object('id', m.id, 'changed', true);
end;
$$;

revoke all on function public.fn_accept_team_invite_atomic(uuid, uuid, text, uuid, timestamptz, timestamptz, jsonb, uuid)
  from public, anon, authenticated;
grant execute on function public.fn_accept_team_invite_atomic(uuid, uuid, text, uuid, timestamptz, timestamptz, jsonb, uuid)
  to service_role;

notify pgrst, 'reload schema';
