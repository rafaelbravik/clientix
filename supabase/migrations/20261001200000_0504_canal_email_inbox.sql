-- 0504 · Canal E-mail no Inbox (Atendimento e Suporte)
--
-- Adiciona suporte ao canal de e-mail integrado ao Inbox do CRM, com constraints
-- de integridade, colunas dedicadas em channel_sessions e suporte a threading.

alter table public.channel_sessions
  add column if not exists email_address text,
  add column if not exists email_inbound_token text;

comment on column public.channel_sessions.email_address is
  'Endereço de e-mail de atendimento (ex: contato@empresa.com.br). É o sessionRef deste canal.';
comment on column public.channel_sessions.email_inbound_token is
  'Token secreto de identificação para ingestão inbound de e-mails.';

-- 1. Alarga channel_sessions_provider_check
alter table public.channel_sessions
  drop constraint if exists channel_sessions_provider_check;

alter table public.channel_sessions
  add constraint channel_sessions_provider_check
    check (provider in ('waha', 'meta_cloud', 'zernio', 'zernio_social', 'wacalls', 'datafy', 'telegram', 'email'));

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
    (provider = 'email' and email_address is not null)
  );

-- 3. Alarga webhook_events_log_provider_check
alter table public.webhook_events_log
  drop constraint if exists webhook_events_log_provider_check;

alter table public.webhook_events_log
  add constraint webhook_events_log_provider_check check (provider in (
    'waha', 'nuvemshop', 'generic', 'meta_cloud', 'zernio', 'datafy', 'telegram', 'email'
  ));

-- 4. Alarga conversations_channel_check
alter table public.conversations
  drop constraint if exists conversations_channel_check;

alter table public.conversations
  add constraint conversations_channel_check
    check (channel in ('whatsapp', 'instagram', 'facebook', 'telegram', 'email'));

-- 5. Deduplica e cria índice único para email_address entre sessões ativas
with ativos as (
  select id,
         row_number() over (
           partition by lower(email_address)
           order by created_at desc nulls last, id desc
         ) as posicao
    from public.channel_sessions
   where archived_at is null
     and email_address is not null
)
update public.channel_sessions s
   set email_address = s.email_address || '-conflito-' || s.id::text
  from ativos a
 where a.id = s.id
   and a.posicao > 1;

create unique index if not exists channel_sessions_email_address_ativo_unique
  on public.channel_sessions (lower(email_address))
  where archived_at is null and email_address is not null;

notify pgrst, 'reload schema';
