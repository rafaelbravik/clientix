-- 0505 · Central de Campanhas Multicanal Unificada (WhatsApp, Telegram e E-mail)
--
-- Expande o motor de campanhas para suportar múltiplos canais de disparo,
-- adicionando seletor de canal e metadados específicos de e-mail (assunto).

alter table public.campaigns
  add column if not exists channel text not null default 'whatsapp',
  add column if not exists email_subject text;

comment on column public.campaigns.channel is
  'Canal de envio da campanha: whatsapp, telegram ou email.';
comment on column public.campaigns.email_subject is
  'Assunto personalizado para disparos via canal de e-mail.';

alter table public.campaigns
  drop constraint if exists campaigns_channel_check;

alter table public.campaigns
  add constraint campaigns_channel_check
    check (channel in ('whatsapp', 'telegram', 'email'));

alter table public.campaign_recipients
  add column if not exists channel text;

comment on column public.campaign_recipients.channel is
  'Canal específico pelo qual este destinatário foi abordado.';

notify pgrst, 'reload schema';
