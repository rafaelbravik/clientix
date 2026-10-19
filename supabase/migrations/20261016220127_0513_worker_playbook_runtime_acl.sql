-- 0513 — ACL mínima para seed e leitura dos playbooks pelo worker.
--
-- O worker usa PostgreSQL direto. A instalação observada conecta como
-- `postgres`, membro de `service_role`; deployments dedicados podem usar
-- `agent_worker`. Nenhuma das duas roles tinha INSERT em `playbook_versions`.
-- O worker só precisa ler versões/ponteiros e inserir a seed de plataforma.
-- O conteúdo das versões é imutável e o worker não move nem apaga ponteiros.
--
-- service_role tem BYPASSRLS por desenho; o loader mantém o filtro explícito
-- de organization_id. As policies tenant-aware permanecem inalteradas.

revoke all on table public.playbook_versions, public.playbook_pointers
  from public, anon, service_role;

grant select, insert on table public.playbook_versions to service_role;
grant select, insert on table public.playbook_pointers to service_role;

-- A role dedicada é criada fora das migrations em instalações self-host.
-- Se já existir, restrinja estes objetos ao mesmo contrato mínimo do worker.
do $$
begin
  if to_regrole('agent_worker') is not null then
    execute 'revoke all on table public.playbook_versions, public.playbook_pointers from agent_worker';
    execute 'grant select, insert on table public.playbook_versions, public.playbook_pointers to agent_worker';
  end if;
end
$$;
