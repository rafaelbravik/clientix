-- 0512 — ACL explícita para o catálogo de tipos de agendamento.
--
-- A baseline pode ser aplicada por `supabase_admin`, enquanto os privilégios
-- padrão abaixo foram declarados para `postgres`. Nesse caminho, o trigger de
-- criação da organização roda como `service_role` e não herda acesso à tabela.
-- A migration 0185 manteve a função como SECURITY INVOKER, então a permissão
-- necessária deve ser concedida diretamente à role que executa o bootstrap.
--
-- O runtime atual usa SELECT/INSERT/UPDATE via service_role; DELETE não é usado.
-- Usuários autenticados conservam as operações CRUD previstas pelas policies
-- tenant-aware existentes. `anon` não acessa a tabela.

revoke all on table public.calendar_event_types from anon, authenticated, service_role;

grant select, insert, update, delete
  on table public.calendar_event_types to authenticated;

grant select, insert, update
  on table public.calendar_event_types to service_role;
