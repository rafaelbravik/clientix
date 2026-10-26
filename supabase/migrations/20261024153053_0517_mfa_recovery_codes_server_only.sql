-- SEC-01: recovery-code hashes are server-owned authentication secrets.
-- The authenticated session is used only to prove the caller's identity and AAL2;
-- all table reads/writes happen through the server's service-role client.
ALTER TABLE public.user_recovery_codes ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS recovery_codes_self ON public.user_recovery_codes;

REVOKE ALL PRIVILEGES ON TABLE public.user_recovery_codes FROM PUBLIC, anon, authenticated;
GRANT ALL PRIVILEGES ON TABLE public.user_recovery_codes TO service_role;

DO $recovery_codes_acl$
BEGIN
  IF has_table_privilege('anon', 'public.user_recovery_codes', 'SELECT')
     OR has_table_privilege('anon', 'public.user_recovery_codes', 'INSERT')
     OR has_table_privilege('anon', 'public.user_recovery_codes', 'UPDATE')
     OR has_table_privilege('anon', 'public.user_recovery_codes', 'DELETE')
     OR has_table_privilege('authenticated', 'public.user_recovery_codes', 'SELECT')
     OR has_table_privilege('authenticated', 'public.user_recovery_codes', 'INSERT')
     OR has_table_privilege('authenticated', 'public.user_recovery_codes', 'UPDATE')
     OR has_table_privilege('authenticated', 'public.user_recovery_codes', 'DELETE')
     OR has_column_privilege('anon', 'public.user_recovery_codes', 'code_hash', 'SELECT')
     OR has_column_privilege('authenticated', 'public.user_recovery_codes', 'code_hash', 'SELECT') THEN
    RAISE EXCEPTION 'recovery-code ACL still exposes user_recovery_codes to anon/authenticated';
  END IF;

  IF NOT has_table_privilege('service_role', 'public.user_recovery_codes', 'SELECT')
     OR NOT has_table_privilege('service_role', 'public.user_recovery_codes', 'INSERT')
     OR NOT has_table_privilege('service_role', 'public.user_recovery_codes', 'UPDATE')
     OR NOT has_table_privilege('service_role', 'public.user_recovery_codes', 'DELETE') THEN
    RAISE EXCEPTION 'service_role recovery-code access is incomplete';
  END IF;
END
$recovery_codes_acl$;
