-- manifest: Cada resposta rápida escolhe se aparece na barra do composer; omissão preserva a barra por padrão e não afeta o menu `/`.

alter table public.message_templates
  add column if not exists mostrar_na_barra boolean not null default true;

comment on column public.message_templates.mostrar_na_barra is
  'Exibe o template na barra de respostas rápidas do Inbox. O menu / continua incluindo todos os templates permitidos.';
