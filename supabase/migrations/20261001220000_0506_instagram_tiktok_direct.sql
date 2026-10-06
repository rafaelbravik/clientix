-- 0506 · Instagram Direct Nativo (Meta Graph API) & TikTok Messaging API
--
-- Adiciona suporte nativo ao Instagram Direct via Meta Graph API e TikTok Messaging API,
-- incluindo armazenamento seguro de credenciais, constraints de integridade, índices únicos
-- e a tabela de automação Comment-to-DM no Instagram.

alter table public.channel_sessions
  add column if not exists instagram_account_id text,
  add column if not exists instagram_username text,
  add column if not exists instagram_token_encrypted bytea,
  add column if not exists tiktok_business_id text,
  add column if not exists tiktok_username text,
  add column if not exists tiktok_token_encrypted bytea,
  add column if not exists tiktok_refresh_token_encrypted bytea;

comment on column public.channel_sessions.instagram_account_id is
  'ID da conta Instagram Business / Page ID da Meta. É o sessionRef deste canal.';
comment on column public.channel_sessions.instagram_username is
  'Handle/username do perfil no Instagram (ex: @minhaempresa).';
comment on column public.channel_sessions.instagram_token_encrypted is
  'Token de acesso da Meta Graph API cifrado por fn_encrypt_oauth.';
comment on column public.channel_sessions.tiktok_business_id is
  'ID comercial da conta do TikTok for Business. É o sessionRef deste canal.';
comment on column public.channel_sessions.tiktok_username is
  'Handle/username da conta no TikTok.';
comment on column public.channel_sessions.tiktok_token_encrypted is
  'Access Token da TikTok Messaging API cifrado por fn_encrypt_oauth.';
comment on column public.channel_sessions.tiktok_refresh_token_encrypted is
  'Refresh Token da TikTok Messaging API cifrado por fn_encrypt_oauth.';

-- 1. Alarga channel_sessions_provider_check
alter table public.channel_sessions
  drop constraint if exists channel_sessions_provider_check;

alter table public.channel_sessions
  add constraint channel_sessions_provider_check
    check (provider in (
      'waha', 'meta_cloud', 'zernio', 'zernio_social', 'wacalls', 'datafy', 'telegram', 'email', 'instagram', 'tiktok'
    ));

-- 2. Alarga channel_sessions_provider_ref_check
alter table public.channel_sessions
  drop constraint if exists channel_sessions_provider_ref_check;

alter table public.channel_sessions
  add constraint channel_sessions_provider_ref_check check (
    (provider = 'waha' and waha_session_name is not null) or
    (provider = 'meta_cloud' and meta_phone_number_id is not null) or
    (provider in ('zernio', 'zernio_social') and zernio_account_id is not null) or
    (provider = 'wacalls' and wacalls_session_id is not null) or
    (provider = 'datafy' and datafy_phone_number_id is not null) or
    (provider = 'telegram' and telegram_bot_id is not null) or
    (provider = 'email' and email_address is not null) or
    (provider = 'instagram' and instagram_account_id is not null) or
    (provider = 'tiktok' and tiktok_business_id is not null)
  );

-- 3. Alarga webhook_events_log_provider_check
alter table public.webhook_events_log
  drop constraint if exists webhook_events_log_provider_check;

alter table public.webhook_events_log
  add constraint webhook_events_log_provider_check check (provider in (
    'waha', 'nuvemshop', 'generic', 'meta_cloud', 'zernio', 'datafy', 'telegram', 'email', 'instagram', 'tiktok'
  ));

-- 4. Alarga conversations_channel_check
alter table public.conversations
  drop constraint if exists conversations_channel_check;

alter table public.conversations
  add constraint conversations_channel_check
    check (channel in ('whatsapp', 'instagram', 'facebook', 'telegram', 'email', 'tiktok'));

-- 5. Deduplica e cria índice único para instagram_account_id entre sessões ativas
with ativos as (
  select id,
         row_number() over (
           partition by instagram_account_id
           order by created_at desc nulls last, id desc
         ) as posicao
    from public.channel_sessions
   where archived_at is null
     and instagram_account_id is not null
)
update public.channel_sessions s
   set instagram_account_id = s.instagram_account_id || '-conflito-' || s.id::text
  from ativos a
 where a.id = s.id
   and a.posicao > 1;

create unique index if not exists channel_sessions_instagram_account_id_ativo_unique
  on public.channel_sessions (instagram_account_id)
  where archived_at is null and instagram_account_id is not null;

-- 6. Deduplica e cria índice único para tiktok_business_id entre sessões ativas
with ativos as (
  select id,
         row_number() over (
           partition by tiktok_business_id
           order by created_at desc nulls last, id desc
         ) as posicao
    from public.channel_sessions
   where archived_at is null
     and tiktok_business_id is not null
)
update public.channel_sessions s
   set tiktok_business_id = s.tiktok_business_id || '-conflito-' || s.id::text
  from ativos a
 where a.id = s.id
   and a.posicao > 1;

create unique index if not exists channel_sessions_tiktok_business_id_ativo_unique
  on public.channel_sessions (tiktok_business_id)
  where archived_at is null and tiktok_business_id is not null;

-- 7. Tabela de automação Comment-to-DM do Instagram
create table if not exists public.instagram_comment_rules (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  channel_session_id uuid not null,
  name text not null,
  active boolean not null default true,
  post_id text,
  keyword_mode text not null default 'any' check (keyword_mode in ('any', 'contains', 'exact')),
  keywords text[] not null default '{}',
  reply_comment text,
  dm_message text not null,
  agent_id uuid,
  constraint instagram_comment_rules_session_org_fk foreign key (organization_id, channel_session_id) references public.channel_sessions(organization_id, id) on delete cascade,
  constraint instagram_comment_rules_agent_org_fk foreign key (organization_id, agent_id) references public.ai_agents(organization_id, id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.instagram_comment_rules enable row level security;

drop policy if exists "instagram_comment_rules_tenant" on public.instagram_comment_rules;
create policy "instagram_comment_rules_tenant" on public.instagram_comment_rules
  for all using (organization_id in (select public.fn_user_org_ids()));

create index if not exists idx_instagram_comment_rules_session
  on public.instagram_comment_rules (channel_session_id)
  where active is true;

select public.fn_aplicar_travas_de_suporte();

notify pgrst, 'reload schema';
