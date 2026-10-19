-- 0514 — contrato explícito de privilégios para o runtime do worker.
--
-- O runtime direto de PostgreSQL usa a role dedicada agent_worker (login +
-- BYPASSRLS), criada pelo provisionamento fora da migration. postgres/service_role
-- são autoridades de deploy/API e não devem ser a identidade do worker. A migration
-- exige agent_worker e falha se ela estiver ausente ou fora do contrato. Não recebe grants de schema inteiro. Grants
-- diretos de função fora da lista permitida bloqueiam a migration para que o
-- owner faça a limpeza sem tentar revogar funções de extensões/outros owners.
--
-- Inventário fonte: AST a partir de workers/agent-worker/main.ts (1.374 funções,
-- 238 arquivos), quatro consultas dinâmicas revisadas manualmente, triggers
-- invoker e funções invoker do caminho. platform_support_sessions fica excluída:
-- o ramo de suporte da auditoria exige ator humano/sessão, ausentes no worker.
--
-- DELETE só é necessário em lead_notes (substituição de notas antigas dentro do
-- orçamento de contexto) e messages (deduplicação de eco no reconciliador).
-- job_queue nunca precisa DELETE; claims, retry e conclusão são UPDATE/INSERT.
--
-- RLS permanece habilitada e inalterada. O worker é um principal confiável
-- BYPASSRLS e os loaders/queries tenant-aware mantêm filtro explícito de org.

do $worker_acl$
declare
  v_contract text[][] := array[
    ARRAY['agent_case_events','INSERT,SELECT'],
    ARRAY['agent_cases','INSERT,SELECT,UPDATE'],
    ARRAY['agent_inbox_items','INSERT,SELECT,UPDATE'],
    ARRAY['ai_agent_versions','SELECT'],
    ARRAY['ai_agents','SELECT'],
    ARRAY['ai_budgets','SELECT'],
    ARRAY['ai_models','SELECT'],
    ARRAY['ai_provider_credentials','SELECT'],
    ARRAY['ai_purpose_bindings','SELECT'],
    ARRAY['ai_router_decisions','INSERT'],
    ARRAY['ai_router_members','SELECT'],
    ARRAY['ai_routers','SELECT'],
    ARRAY['api_audit_log','INSERT'],
    ARRAY['api_tokens','INSERT,SELECT,UPDATE'],
    ARRAY['attendant_availability','SELECT'],
    ARRAY['before_send_traces','INSERT'],
    ARRAY['calendar_appointments','SELECT'],
    ARRAY['catalog_products','SELECT'],
    ARRAY['channel_knobs','SELECT'],
    ARRAY['channel_session_health','SELECT,UPDATE'],
    ARRAY['channel_sessions','SELECT,UPDATE'],
    ARRAY['contacts','SELECT,UPDATE'],
    ARRAY['conversations','SELECT,UPDATE'],
    ARRAY['crm_lead_activities','INSERT,SELECT'],
    ARRAY['crm_lead_scores','INSERT,SELECT,UPDATE'],
    ARRAY['crm_leads','SELECT,UPDATE'],
    ARRAY['crm_pipelines','SELECT'],
    ARRAY['crm_proposals','SELECT'],
    ARRAY['crm_stages','SELECT'],
    ARRAY['cron_jobs','INSERT,SELECT,UPDATE'],
    ARRAY['demanda_conversas','SELECT'],
    ARRAY['demandas','SELECT'],
    ARRAY['disclosure_template_pointers','SELECT'],
    ARRAY['disclosure_template_versions','SELECT'],
    ARRAY['event_log','INSERT,SELECT,UPDATE'],
    ARRAY['flywheel_distiller_proposals','INSERT'],
    ARRAY['flywheel_judge_verdicts','INSERT'],
    ARRAY['followup_enrollment_events','INSERT,SELECT'],
    ARRAY['followup_enrollments','INSERT,SELECT,UPDATE'],
    ARRAY['followup_flow_pointers','SELECT'],
    ARRAY['followup_flow_versions','SELECT'],
    ARRAY['golden_candidates','INSERT'],
    ARRAY['jev_observacoes','INSERT'],
    ARRAY['job_queue','INSERT,SELECT,UPDATE'],
    ARRAY['knowledge_searches','INSERT'],
    ARRAY['lead_checkpoints','INSERT,SELECT'],
    ARRAY['lead_notes','DELETE,INSERT,SELECT'],
    ARRAY['lead_state','INSERT,SELECT,UPDATE'],
    ARRAY['lead_state_transitions','INSERT'],
    ARRAY['llm_calls','INSERT,SELECT'],
    ARRAY['message_templates','SELECT'],
    ARRAY['messages','DELETE,INSERT,SELECT,UPDATE'],
    ARRAY['meta_templates','SELECT'],
    ARRAY['metrics','INSERT,SELECT'],
    ARRAY['modulos_instalados','SELECT'],
    ARRAY['org_guardrail_layers','SELECT'],
    ARRAY['org_memory_entries','SELECT'],
    ARRAY['org_memory_pointers','SELECT'],
    ARRAY['org_memory_versions','SELECT'],
    ARRAY['organizations','SELECT'],
    ARRAY['outbound_copies','INSERT,SELECT'],
    ARRAY['pacing_ledger','INSERT,SELECT'],
    ARRAY['passagens_de_atendimento','INSERT'],
    ARRAY['people','SELECT'],
    ARRAY['platform_config','SELECT'],
    ARRAY['platform_settings','SELECT'],
    ARRAY['playbook_pointers','INSERT,SELECT'],
    ARRAY['playbook_versions','INSERT,SELECT'],
    ARRAY['promise_table_pointers','SELECT'],
    ARRAY['promise_table_versions','SELECT'],
    ARRAY['prospecting_campaigns','SELECT'],
    ARRAY['prospecting_candidates','SELECT'],
    ARRAY['reentry_template_pointers','SELECT'],
    ARRAY['reentry_template_versions','SELECT'],
    ARRAY['send_ledger','INSERT,SELECT,UPDATE'],
    ARRAY['skill_activations','INSERT'],
    ARRAY['skill_pointers','SELECT'],
    ARRAY['skill_versions','SELECT'],
    ARRAY['user_organizations','SELECT'],
    ARRAY['voice_calls','INSERT,UPDATE']
  ];
  v_service_functions regprocedure[] := array[
    'public.emit_event(text,text,uuid,jsonb,jsonb,uuid)'::regprocedure,
    'public.fn_appointment_enrollment_current(uuid,uuid,text)'::regprocedure,
    'public.fn_buscar_trechos_das_fontes(uuid,uuid[],vector,integer,real,text)'::regprocedure,
    'public.fn_claim_due_followup_enrollments(integer,integer)'::regprocedure,
    'public.fn_decrypt_oauth(bytea)'::regprocedure,
    'public.fn_followup_apply_step(uuid,uuid,bigint,jsonb,jsonb)'::regprocedure,
    'public.fn_followup_claim_current(uuid,uuid,text,timestamptz)'::regprocedure,
    'public.fn_followup_job_current(uuid,uuid,uuid,text)'::regprocedure,
    'public.fn_followup_patch(uuid,uuid,bigint,jsonb)'::regprocedure,
    'public.fn_followup_turno_descartado(uuid,uuid)'::regprocedure,
    'public.fn_gasto_de_ia_do_mes(uuid)'::regprocedure,
    'public.fn_meet_delivery_policy(uuid,uuid,text,timestamptz)'::regprocedure,
    'public.fn_meet_delivery_settle(uuid,uuid,text,timestamptz,text,timestamptz)'::regprocedure,
    'public.fn_org_operante(uuid)'::regprocedure,
    'public.fn_reply_delivery_policy(uuid,uuid,text,timestamptz)'::regprocedure,
    'public.fn_reply_prepare(uuid,uuid,text,timestamptz)'::regprocedure,
    'public.fn_reply_receipt_policy(uuid,uuid,text,timestamptz)'::regprocedure,
    'public.fn_reply_record_receipt(uuid,uuid,text,timestamptz,uuid,text,text[])'::regprocedure,
    'public.fn_reply_settle(uuid,uuid,text,timestamptz,text,text)'::regprocedure,
    'public.fn_service_boundary(uuid,uuid)'::regprocedure,
    'public.fn_service_observe_command(uuid,uuid)'::regprocedure
  ];
  v_worker_functions regprocedure[] := array[
    'public.fn_appointment_enrollment_current(uuid,uuid,text)'::regprocedure,
    'public.fn_buscar_trechos_das_fontes(uuid,uuid[],vector,integer,real,text)'::regprocedure,
    'public.fn_claim_due_followup_enrollments(integer,integer)'::regprocedure,
    'public.fn_followup_apply_step(uuid,uuid,bigint,jsonb,jsonb)'::regprocedure,
    'public.fn_followup_claim_current(uuid,uuid,text,timestamptz)'::regprocedure,
    'public.fn_followup_job_current(uuid,uuid,uuid,text)'::regprocedure,
    'public.fn_followup_patch(uuid,uuid,bigint,jsonb)'::regprocedure,
    'public.fn_followup_turno_descartado(uuid,uuid)'::regprocedure,
    'public.fn_gasto_de_ia_do_mes(uuid)'::regprocedure,
    'public.fn_meet_delivery_policy(uuid,uuid,text,timestamptz)'::regprocedure,
    'public.fn_meet_delivery_settle(uuid,uuid,text,timestamptz,text,timestamptz)'::regprocedure,
    'public.fn_org_operante(uuid)'::regprocedure,
    'public.fn_reply_delivery_policy(uuid,uuid,text,timestamptz)'::regprocedure,
    'public.fn_reply_receipt_policy(uuid,uuid,text,timestamptz)'::regprocedure,
    'public.fn_reply_settle(uuid,uuid,text,timestamptz,text,text)'::regprocedure
  ];
  v_entry text[];
  v_privilege text;
  v_function regprocedure;
  v_sequence regclass;
  v_worker record;
begin
  grant usage on schema public to service_role;

  foreach v_entry slice 1 in array v_contract loop
    foreach v_privilege in array string_to_array(v_entry[2], ',') loop
      execute format(
        'grant %s on table public.%I to service_role',
        v_privilege,
        v_entry[1]
      );
      if not has_table_privilege('service_role', format('public.%I', v_entry[1]), v_privilege) then
        raise exception 'worker ACL contract not installed: service_role lacks % on public.%',
          v_privilege, v_entry[1];
      end if;
    end loop;
  end loop;

  foreach v_function in array v_service_functions loop
    execute format('grant execute on function %s to service_role', v_function);
    if not has_function_privilege('service_role', v_function, 'EXECUTE') then
      raise exception 'worker ACL contract not installed: service_role lacks EXECUTE on %', v_function;
    end if;
  end loop;

  grant usage on sequence
    public.lead_checkpoints_seq_seq,
    public.lead_state_transitions_seq_seq
  to service_role;
  if not has_sequence_privilege('service_role', 'public.lead_checkpoints_seq_seq', 'USAGE')
     or not has_sequence_privilege('service_role', 'public.lead_state_transitions_seq_seq', 'USAGE') then
    raise exception 'worker ACL contract not installed: service_role lacks required sequence USAGE';
  end if;

  select * into v_worker from pg_roles where rolname = 'agent_worker';
  if not found then
    raise exception 'agent_worker must be provisioned before applying the worker runtime ACL contract';
  end if;

  if v_worker.rolsuper
       or not v_worker.rolcanlogin
       or v_worker.rolinherit
       or not v_worker.rolbypassrls
       or v_worker.rolcreatedb
       or v_worker.rolcreaterole
       or v_worker.rolreplication then
      raise exception 'agent_worker must be LOGIN, NOINHERIT, non-superuser, BYPASSRLS, and have no database/role/replication administration';
  end if;

  if exists (
      select 1 from pg_auth_members
       where member = v_worker.oid or roleid = v_worker.oid
  ) then
    raise exception 'agent_worker must not inherit from or be granted to another role';
  end if;

  if exists (
      select 1
        from pg_class c
        join pg_namespace n on n.oid = c.relnamespace
       where n.nspname = 'public'
         and c.relowner = v_worker.oid
    ) or exists (
      select 1
        from pg_proc p
        join pg_namespace n on n.oid = p.pronamespace
       where n.nspname = 'public'
         and p.proowner = v_worker.oid
    ) or exists (
      select 1
        from pg_namespace n
       where n.nspname = 'public'
         and n.nspowner = v_worker.oid
    ) or exists (
      select 1 from pg_database where datdba = v_worker.oid
  ) then
    raise exception 'agent_worker must not own database or public schema objects';
  end if;

  execute 'revoke all on all tables in schema public from agent_worker';
  execute 'revoke all on all sequences in schema public from agent_worker';
  for v_function in
      select p.oid::regprocedure
        from pg_proc p
        join pg_namespace n on n.oid = p.pronamespace
        cross join lateral aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) acl
       where n.nspname = 'public'
         and acl.grantee = v_worker.oid
         and acl.privilege_type = 'EXECUTE'
  loop
    execute format('revoke all on function %s from agent_worker', v_function);
  end loop;
  revoke create on schema public from agent_worker;
  grant usage on schema public to agent_worker;
  execute format('grant connect on database %I to agent_worker', current_database());

  if exists (
      select 1
        from pg_proc p
        join pg_namespace n on n.oid = p.pronamespace
        cross join lateral aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) acl
       where n.nspname = 'public'
         and acl.grantee = v_worker.oid
         and acl.privilege_type = 'EXECUTE'
         and not exists (
           select 1
             from unnest(v_worker_functions) allowed(function_oid)
            where allowed.function_oid::oid = p.oid
         )
  ) then
    raise exception 'agent_worker has direct EXECUTE grants outside the worker allowlist; remove them as the owning role before applying this contract';
  end if;

  foreach v_entry slice 1 in array v_contract loop
      foreach v_privilege in array string_to_array(v_entry[2], ',') loop
        execute format(
          'grant %s on table public.%I to agent_worker',
          v_privilege,
          v_entry[1]
        );
        if not has_table_privilege('agent_worker', format('public.%I', v_entry[1]), v_privilege) then
          raise exception 'worker ACL contract not installed: agent_worker lacks % on public.%',
            v_privilege, v_entry[1];
        end if;
      end loop;
  end loop;

  foreach v_function in array v_worker_functions loop
      execute format('grant execute on function %s to agent_worker', v_function);
      if not has_function_privilege('agent_worker', v_function, 'EXECUTE') then
        raise exception 'worker ACL contract not installed: agent_worker lacks EXECUTE on %', v_function;
      end if;
  end loop;

  foreach v_sequence in array array[
      'public.lead_checkpoints_seq_seq'::regclass,
      'public.lead_state_transitions_seq_seq'::regclass
    ] loop
      execute format('grant usage on sequence %s to agent_worker', v_sequence);
  end loop;
  if not has_sequence_privilege('agent_worker', 'public.lead_checkpoints_seq_seq', 'USAGE')
       or not has_sequence_privilege('agent_worker', 'public.lead_state_transitions_seq_seq', 'USAGE') then
    raise exception 'worker ACL contract not installed: agent_worker lacks required sequence USAGE';
  end if;
end
$worker_acl$;
