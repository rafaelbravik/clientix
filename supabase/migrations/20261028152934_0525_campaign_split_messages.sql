-- 0525 — campanhas podem dividir texto em até três mensagens físicas.
-- Desligado por padrão para preservar literalmente o envio atual em instalações
-- e campanhas já existentes. Campanhas do Clientix são texto; modelos aprovados
-- não fazem parte do contrato atual de campanhas.
alter table public.campaigns
  add column if not exists split_messages boolean not null default false;

comment on column public.campaigns.split_messages is
  'Quando true, campanhas WhatsApp de texto dividem parágrafos em até três mensagens sequenciais, respeitando pacing e quotas.';

-- O worker persiste o próximo índice antes de encerrar uma rodada, para que
-- pacing longo/timeout/restart nunca reenvie os balões já aceitos pelo canal.
alter table public.campaign_recipients
  add column if not exists split_bubble_count smallint,
  add column if not exists next_bubble_index smallint not null default 0;

do $constraint$
begin
  if not exists (
    select 1 from pg_constraint
     where conrelid = 'public.campaign_recipients'::regclass
       and conname = 'campaign_recipients_split_bubbles_check'
  ) then
    alter table public.campaign_recipients
      add constraint campaign_recipients_split_bubbles_check
      check (
        (split_bubble_count is null and next_bubble_index = 0)
        or (
          split_bubble_count is not null
          and
          split_bubble_count between 2 and 3
          and next_bubble_index between 0 and split_bubble_count
        )
      );
  end if;
end
$constraint$;

comment on column public.campaign_recipients.split_bubble_count is
  'Quantidade fixa de mensagens na sequência WhatsApp deste destinatário; NULL quando não há sequência em andamento.';
comment on column public.campaign_recipients.next_bubble_index is
  'Índice zero-based do próximo balão; avanço atômico após cada mensagem para evitar reenvio após retomada.';
