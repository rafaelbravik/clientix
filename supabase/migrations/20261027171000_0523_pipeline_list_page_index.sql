-- manifest: Lista paginada do funil — índice alinhado à consulta por organization_id + pipeline_id e à ordem position_in_stage + id. Permite ao banco percorrer a página em ordem estável sem ordenar todas as linhas do funil. O custo é uma escrita adicional por lead; sem migration, a paginação limita a resposta mas não o trabalho de ordenação.

create index if not exists idx_crm_leads_org_pipeline_position_id
  on public.crm_leads (organization_id, pipeline_id, position_in_stage, id);

comment on index public.idx_crm_leads_org_pipeline_position_id is
  'Página da aba Lista do funil (#3172): (organization_id, pipeline_id) por igualdade e (position_in_stage, id) na ordem da consulta. `id` é o desempate que torna a paginação determinística quando dois negócios têm a mesma position_in_stage.';
