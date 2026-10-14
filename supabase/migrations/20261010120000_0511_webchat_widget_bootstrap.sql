-- 0511 · WebChat anônimo com identidade e sessão limitadas por conversa.
--
-- channel_sessions já é a unidade tenant-aware de conexão/inbox. O UUID público
-- dedicado do widget não é credencial; o backend resolve a org pela própria
-- linha. `status = WORKING` habilita a entrada e `STOPPED` a desliga.
-- WebChat não recebe webhooks, então somente este provider pode omitir o segredo
-- criptografado do webhook. Os demais providers continuam obrigados a gravá-lo.

alter table public.channel_sessions
  add column if not exists webchat_public_id uuid;

alter table public.channel_sessions
  alter column webhook_secret_encrypted drop not null;

alter table public.channel_sessions
  drop constraint if exists channel_sessions_webhook_secret_provider_check;
alter table public.channel_sessions
  add constraint channel_sessions_webhook_secret_provider_check
  check (provider = 'webchat' or webhook_secret_encrypted is not null);

alter table public.channel_sessions
  drop constraint if exists channel_sessions_provider_check;
alter table public.channel_sessions
  add constraint channel_sessions_provider_check
  check (provider in (
    'waha', 'meta_cloud', 'zernio', 'zernio_social', 'wacalls', 'datafy',
    'telegram', 'email', 'instagram', 'tiktok', 'telegram_user', 'webchat'
  ));

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
    (provider = 'telegram_user' and telegram_user_id is not null) or
    (provider = 'webchat' and webchat_public_id is not null)
  );

alter table public.channel_sessions
  drop constraint if exists channel_sessions_webchat_public_id_provider_check;
alter table public.channel_sessions
  add constraint channel_sessions_webchat_public_id_provider_check
  check (provider = 'webchat' or webchat_public_id is null);

create unique index if not exists channel_sessions_webchat_public_id_unique
  on public.channel_sessions (webchat_public_id)
  where webchat_public_id is not null;

create unique index if not exists channel_sessions_webchat_org_active_unique
  on public.channel_sessions (organization_id)
  where provider = 'webchat' and archived_at is null;

alter table public.conversations
  drop constraint if exists conversations_channel_check;
alter table public.conversations
  add constraint conversations_channel_check
  check (channel in ('whatsapp', 'instagram', 'facebook', 'telegram', 'email', 'tiktok', 'webchat'));

comment on column public.channel_sessions.status is
  'Para provider webchat, WORKING habilita o widget e STOPPED desabilita; não há provedor externo.';
comment on column public.channel_sessions.webchat_public_id is
  'Identificador público não secreto do widget. Resolve uma única sessão WebChat; o tenant vem da linha, nunca do request.';
comment on constraint channel_sessions_webhook_secret_provider_check on public.channel_sessions is
  'Todos os providers que recebem webhook exigem webhook_secret_encrypted; WebChat não recebe webhooks.';

grant select (webchat_public_id) on public.channel_sessions to authenticated;

-- O id é público e usado somente para resolver a sessão do canal pelo seam.
-- Nenhuma credencial de webhook nem chave criptografada fica disponível à sessão.
notify pgrst, 'reload schema';
