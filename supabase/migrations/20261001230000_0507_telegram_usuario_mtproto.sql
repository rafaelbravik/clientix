-- 0507 · Telegram Usuário / Userbot (MTProto)
--
-- Adiciona suporte nativo ao canal de usuário/atendente do Telegram via protocolo MTProto,
-- permitindo conexão via número de telefone, autenticação por código SMS/Telegram e 2FA,
-- armazenamento seguro de string de sessão e acoplamento ao motor de pacing anti-flood.

alter table public.channel_sessions
  add column if not exists telegram_user_id text,
  add column if not exists telegram_phone text,
  add column if not exists telegram_session_encrypted bytea,
  add column if not exists telegram_api_id integer,
  add column if not exists telegram_api_hash_encrypted bytea;

comment on column public.channel_sessions.telegram_user_id is
  'ID numérico do usuário do Telegram (MTProto). É o sessionRef deste canal.';
comment on column public.channel_sessions.telegram_phone is
  'Número de telefone internacional da conta do Telegram (+55...).';
comment on column public.channel_sessions.telegram_session_encrypted is
  'String de sessão MTProto cifrada por fn_encrypt_oauth.';
comment on column public.channel_sessions.telegram_api_id is
  'App API ID do Telegram.';
comment on column public.channel_sessions.telegram_api_hash_encrypted is
  'App API Hash do Telegram cifrado por fn_encrypt_oauth.';

-- 1. Alarga channel_sessions_provider_check
alter table public.channel_sessions
  drop constraint if exists channel_sessions_provider_check;

alter table public.channel_sessions
  add constraint channel_sessions_provider_check
    check (provider in (
      'waha', 'meta_cloud', 'zernio', 'zernio_social', 'wacalls', 'datafy', 'telegram', 'email', 'instagram', 'tiktok', 'telegram_user'
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
    (provider = 'tiktok' and tiktok_business_id is not null) or
    (provider = 'telegram_user' and telegram_user_id is not null)
  );

-- 3. Alarga webhook_events_log_provider_check
alter table public.webhook_events_log
  drop constraint if exists webhook_events_log_provider_check;

alter table public.webhook_events_log
  add constraint webhook_events_log_provider_check check (provider in (
    'waha', 'nuvemshop', 'generic', 'meta_cloud', 'zernio', 'datafy', 'telegram', 'email', 'instagram', 'tiktok', 'telegram_user'
  ));

-- 4. Deduplica e cria índice único para telegram_user_id entre sessões ativas
with ativos as (
  select id,
         row_number() over (
           partition by telegram_user_id
           order by created_at desc nulls last, id desc
         ) as posicao
    from public.channel_sessions
   where archived_at is null
     and telegram_user_id is not null
)
update public.channel_sessions s
   set telegram_user_id = s.telegram_user_id || '-conflito-' || s.id::text
  from ativos a
 where a.id = s.id
   and a.posicao > 1;

create unique index if not exists channel_sessions_telegram_user_id_ativo_unique
  on public.channel_sessions (telegram_user_id)
  where archived_at is null and telegram_user_id is not null;

notify pgrst, 'reload schema';
