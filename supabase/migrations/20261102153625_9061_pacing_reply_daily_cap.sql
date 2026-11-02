-- 9061 — respostas a quem escreveu não consomem o teto diário de disparos.
-- A janela de resposta e o espaçamento continuam aplicáveis. O default false
-- preserva o comportamento das linhas e escritores anteriores.
alter table public.pacing_ledger
  add column if not exists resposta boolean not null default false;

comment on column public.pacing_ledger.resposta is
  'true = resposta a quem escreveu: vale para espaçamento, mas não consome o teto diário de disparos (9061).';

notify pgrst, 'reload schema';
