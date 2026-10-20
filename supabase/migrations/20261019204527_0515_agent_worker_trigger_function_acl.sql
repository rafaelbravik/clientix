-- 0515 — EXECUTE pontual para as funções aninhadas nos triggers alcançados
-- pelas escritas já permitidas ao agent_worker no contrato 0514.
--
-- Os triggers de event_log, messages, crm_leads e channel_sessions são
-- SECURITY INVOKER. Em execução pelo worker, seus helpers também precisam
-- estar na allowlist direta da role. fn_log_event é SECURITY DEFINER, com
-- search_path fixo, referências public qualificadas e sem SQL dinâmico; o
-- worker já possui INSERT explícito em event_log e BYPASSRLS intencional.
GRANT EXECUTE ON FUNCTION public.fn_event_log_e_registro(text) TO agent_worker;
GRANT EXECUTE ON FUNCTION public.fn_log_event(uuid, text, jsonb) TO agent_worker;

DO $worker_trigger_acl$
BEGIN
  IF NOT has_function_privilege('agent_worker', 'public.fn_event_log_e_registro(text)', 'EXECUTE') THEN
    RAISE EXCEPTION 'agent_worker trigger ACL not installed: fn_event_log_e_registro(text)';
  END IF;

  IF NOT has_function_privilege('agent_worker', 'public.fn_log_event(uuid,text,jsonb)', 'EXECUTE') THEN
    RAISE EXCEPTION 'agent_worker trigger ACL not installed: fn_log_event(uuid,text,jsonb)';
  END IF;
END
$worker_trigger_acl$;
