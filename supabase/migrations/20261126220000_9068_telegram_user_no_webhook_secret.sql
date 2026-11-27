-- 9068 · Telegram User/MTProto não recebe webhook e, portanto, não possui segredo de webhook.
-- A sessão usa o listener MTProto do worker e as credenciais do app configuradas pelo Owner.

alter table public.channel_sessions
  drop constraint if exists channel_sessions_webhook_secret_provider_check;

alter table public.channel_sessions
  add constraint channel_sessions_webhook_secret_provider_check
  check (provider in ('webchat', 'telegram_user') or webhook_secret_encrypted is not null);

comment on constraint channel_sessions_webhook_secret_provider_check on public.channel_sessions is
  'Providers que recebem webhooks exigem webhook_secret_encrypted; WebChat e Telegram User/MTProto não recebem webhooks.';
