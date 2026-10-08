/**
 * Verificações críticas pós-migração e pós-adoção do Clientix Standalone Migrator.
 * Valida existência de objetos estruturais, RLS nas tabelas essenciais,
 * triggers de quota/agenda e ausência de divergências graves.
 */

-- 1. Extensões Obrigatórias
do $$
begin
  if not exists (select 1 from pg_extension where extname = 'vector') then
    raise exception 'VERIFY_FAILED: extensao vector ausente';
  end if;
  if not exists (select 1 from pg_extension where extname = 'citext') then
    raise exception 'VERIFY_FAILED: extensao citext ausente';
  end if;
  if not exists (select 1 from pg_extension where extname = 'pg_trgm') then
    raise exception 'VERIFY_FAILED: extensao pg_trgm ausente';
  end if;
end $$;

-- 2. Tabelas Críticas da Plataforma
do $$
declare
  t text;
  tabelas text[] := array[
    'organizations',
    'user_organizations',
    'platform_admins',
    'contacts',
    'crm_pipelines',
    'crm_stages',
    'crm_leads',
    'channel_sessions',
    'conversations',
    'messages',
    'ai_agents',
    'ai_agent_versions',
    'ai_knowledge_sources',
    'calendar_appointments',
    'campaigns'
  ];
begin
  foreach t in array tabelas loop
    if not exists (
      select 1 from information_schema.tables
      where table_schema = 'public' and table_name = t
    ) then
      raise exception 'VERIFY_FAILED: tabela critica % ausente', t;
    end if;
  end loop;
end $$;

-- 3. RLS Ativada nas Tabelas Críticas
do $$
declare
  t text;
  tabelas_rls text[] := array[
    'organizations',
    'user_organizations',
    'contacts',
    'crm_leads',
    'channel_sessions',
    'conversations',
    'messages',
    'ai_agents',
    'calendar_appointments',
    'campaigns'
  ];
begin
  foreach t in array tabelas_rls loop
    if not exists (
      select 1 from pg_class c
      join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'public'
        and c.relname = t
        and c.relrowsecurity = true
    ) then
      raise exception 'VERIFY_FAILED: RLS desativada na tabela %', t;
    end if;
  end loop;
end $$;

-- 4. Triggers Críticas de Quota e Concorrência (0508, 0509, 0510)
do $$
begin
  -- 0508: quota de conexões de canal
  if not exists (
    select 1 from pg_trigger
    where tgname = 'trg_check_channel_session_quota'
  ) then
    raise exception 'VERIFY_FAILED: trigger trg_check_channel_session_quota (0508) ausente';
  end if;

  -- 0509: quota atômica de assentos
  if not exists (
    select 1 from pg_trigger
    where tgname = 'trg_check_user_seat_quota_invites'
  ) and not exists (
    select 1 from pg_trigger
    where tgname = 'trg_check_user_seat_quota'
  ) then
    raise exception 'VERIFY_FAILED: trigger de quota de assentos (0509) ausente';
  end if;

  -- 0510: sobreposição de agenda
  if not exists (
    select 1 from pg_trigger
    where tgname = 'trg_check_appointment_overlap'
  ) then
    raise exception 'VERIFY_FAILED: trigger trg_check_appointment_overlap (0510) ausente';
  end if;
end $$;

-- 5. Funções Críticas de RBAC e Helper
do $$
declare
  f text;
  funcoes text[] := array[
    'fn_user_org_ids',
    'fn_is_platform_admin',
    'fn_user_role_in_org',
    'fn_check_channel_session_quota',
    'fn_check_user_seat_quota',
    'fn_check_appointment_overlap'
  ];
begin
  foreach f in array funcoes loop
    if not exists (
      select 1 from pg_proc p
      join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'public' and p.proname = f
    ) then
      raise exception 'VERIFY_FAILED: funcao critica % ausente', f;
    end if;
  end loop;
end $$;
