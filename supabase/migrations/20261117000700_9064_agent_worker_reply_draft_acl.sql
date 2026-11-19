-- 9064 — grants mínimos para respostas revisadas geradas pelo runtime.
-- A pool da API autentica como agent_worker. A role lê rascunhos da conversa,
-- atualiza estado/conteúdo e começa a geração pelas duas funções SECURITY DEFINER;
-- INSERT continua encapsulado em fn_reply_begin e DELETE não é necessário.

revoke all on table public.ai_reply_drafts from agent_worker;
grant select, update on table public.ai_reply_drafts to agent_worker;

revoke all on function public.fn_reply_begin(uuid, uuid, uuid, uuid, uuid) from agent_worker;
grant execute on function public.fn_reply_begin(uuid, uuid, uuid, uuid, uuid) to agent_worker;

revoke all on function public.fn_reply_context_current(uuid, uuid) from agent_worker;
grant execute on function public.fn_reply_context_current(uuid, uuid) to agent_worker;
