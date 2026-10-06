-- 0503 · Canal Telegram Bot Oficial
--
-- Adiciona suporte nativo ao Telegram Bot API como provedor de canal de mensagem,
-- com armazenamento seguro de credenciais, constraints de integridade e unicidade.

alter table public.channel_sessions
  add column if not exists telegram_bot_id text,
  add column if not exists telegram_bot_username text,
  add column if not exists telegram_bot_token_encrypted bytea;

comment on column public.channel_sessions.telegram_bot_id is
  'ID numérico do bot do Telegram. É o sessionRef deste canal.';
comment on column public.channel_sessions.telegram_bot_username is
  'Username do bot no Telegram (ex: meu_bot).';
comment on column public.channel_sessions.telegram_bot_token_encrypted is
  'Token da Telegram Bot API cifrado por fn_encrypt_oauth. Nunca volta à tela depois de gravado.';

-- 1. Alarga channel_sessions_provider_check
alter table public.channel_sessions
  drop constraint if exists channel_sessions_provider_check;

alter table public.channel_sessions
  add constraint channel_sessions_provider_check
    check (provider in ('waha', 'meta_cloud', 'zernio', 'zernio_social', 'wacalls', 'datafy', 'telegram'));

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
    (provider = 'telegram' and telegram_bot_id is not null)
  );

-- 3. Alarga webhook_events_log_provider_check
alter table public.webhook_events_log
  drop constraint if exists webhook_events_log_provider_check;

alter table public.webhook_events_log
  add constraint webhook_events_log_provider_check check (provider in (
    'waha', 'nuvemshop', 'generic', 'meta_cloud', 'zernio', 'datafy', 'telegram'
  ));

-- 4. Alarga conversations_channel_check
alter table public.conversations
  drop constraint if exists conversations_channel_check;

alter table public.conversations
  add constraint conversations_channel_check
    check (channel in ('whatsapp', 'instagram', 'facebook', 'telegram'));

-- 5. Deduplica e cria índice único para telegram_bot_id entre sessões ativas
with ativos as (
  select id,
         row_number() over (
           partition by telegram_bot_id
           order by created_at desc nulls last, id desc
         ) as posicao
    from public.channel_sessions
   where archived_at is null
     and telegram_bot_id is not null
)
update public.channel_sessions s
   set telegram_bot_id = s.telegram_bot_id || '-conflito-' || s.id::text
  from ativos a
 where a.id = s.id
   and a.posicao > 1;

create unique index if not exists channel_sessions_telegram_bot_id_ativo_unique
  on public.channel_sessions (telegram_bot_id)
  where archived_at is null and telegram_bot_id is not null;

notify pgrst, 'reload schema';
