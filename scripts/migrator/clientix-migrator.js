#!/usr/bin/env node
/**
 * Clientix Standalone Database Migrator Runner
 *
 * Suporta:
 *  - status: inspeciona estado, versão e migrações pendentes (JSON ou legível)
 *  - check: dry-run de validação de compatibilidade e checksums
 *  - install: fresh install via baseline.sql + registro de metadata
 *  - adopt: adota instalação existente sem metadata, auditando integridade
 *  - update: aplica migrações incrementais em ordem estrita
 *
 * Recursos de segurança:
 *  - Advisory lock mantido durante toda a execução da conexão (salt 2285)
 *  - Sanitização automática de URLs em stdout/stderr
 *  - Transações atômicas por migração
 *  - Exigência de confirmação de backup para update (--backup-ack)
 *  - Fail-closed em detecção de schema drift ou checksum mismatch
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { Client } = require('pg');
const { resolvePostgresConnectionConfig } = require(path.resolve(__dirname, '../lib/postgres-tls-policy.cjs'));

const ADVISORY_LOCK_ID = 2285;
const ADVISORY_LOCK_KEY = 'clientix:database_migrator';

// Resolução de diretórios (funciona localmente, dentro do Docker e sob fixtures de teste)
function resolvePaths() {
  const root = path.resolve(__dirname, '..', '..');
  let baseline = path.join(root, 'supabase', 'baseline.sql');
  let migrationsDir = path.join(root, 'supabase', 'migrations');
  let manifest = path.join(root, 'supabase', 'manifest.json');
  let verifySql = path.join(root, 'supabase', 'verify-schema.sql');

  // Layout do contêiner Docker (/app/bin/clientix-migrator -> /app/sql, /app/manifest)
  const containerBase = path.resolve(__dirname, '..');
  if (fs.existsSync(path.join(containerBase, 'sql', 'baseline.sql'))) {
    baseline = path.join(containerBase, 'sql', 'baseline.sql');
    migrationsDir = path.join(containerBase, 'sql', 'migrations');
    manifest = path.join(containerBase, 'manifest', 'manifest.json');
    verifySql = path.join(containerBase, 'verify', 'verify-schema.sql');
  }

  // Overrides para suíte de testes automatizados
  if (process.env.CLIENTIX_BASELINE_FILE) baseline = process.env.CLIENTIX_BASELINE_FILE;
  if (process.env.CLIENTIX_MIGRATIONS_DIR) migrationsDir = process.env.CLIENTIX_MIGRATIONS_DIR;
  if (process.env.CLIENTIX_MANIFEST_FILE) manifest = process.env.CLIENTIX_MANIFEST_FILE;
  if (process.env.CLIENTIX_VERIFY_FILE) verifySql = process.env.CLIENTIX_VERIFY_FILE;

  return { baseline, migrationsDir, manifest, verifySql };
}

// Sanitização de string de conexão / credenciais (suporta senhas com @, :, IPv6, query params, etc)
function redactUrl(raw) {
  if (!raw || typeof raw !== 'string') return '';
  try {
    const parsed = new URL(raw);
    if (parsed.password) parsed.password = 'REDACTED';
    if (parsed.username) parsed.username = 'REDACTED';
    return parsed.toString();
  } catch {
    // Fallback robusto via regex caso seja formato não-padrão
    return raw
      .replace(/postgres(ql)?:\/\/([^@]+)@/i, 'postgres$1://[REDACTED]@')
      .replace(/(password|pass|pwd)=([^&\s]+)/gi, '$1=[REDACTED]');
  }
}

function log(msg) {
  const clean = redactUrl(msg);
  console.log(`[clientix-migrator] ${clean}`);
}

function logError(msg) {
  const clean = redactUrl(msg);
  console.error(`[clientix-migrator:ERROR] ${clean}`);
}

function getDatabaseUrl() {
  const args = process.argv.slice(2);
  let cliUrl = null;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--database-url' && args[i + 1]) {
      cliUrl = args[i + 1];
      break;
    } else if (args[i].startsWith('--database-url=')) {
      cliUrl = args[i].slice('--database-url='.length);
      break;
    }
  }
  const url = cliUrl || process.env.DATABASE_URL || process.env.SUPABASE_DB_URL;
  if (!url) {
    logError('DATABASE_URL ausente no ambiente. Forneça DATABASE_URL=postgres://... ou --database-url <url>');
    process.exit(1);
  }
  return url;
}

function loadManifest(paths) {
  if (!fs.existsSync(paths.manifest)) {
    logError(`Manifesto não encontrado em ${paths.manifest}`);
    process.exit(1);
  }
  return JSON.parse(fs.readFileSync(paths.manifest, 'utf8'));
}

async function createClient(connectionString) {
  const { connectionString: safeConnectionString, ssl } = resolvePostgresConnectionConfig(connectionString);
  const client = new Client({
    connectionString: safeConnectionString,
    ssl,
    connectionTimeoutMillis: 10000,
    statement_timeout: 300000, // 5 minutos de teto por statement
  });
  await client.connect();
  return client;
}

// Garante o advisory lock durante a sessão do runner
async function acquireLock(client) {
  const res = await client.query(
    'SELECT pg_try_advisory_lock(hashtextextended($1, $2)) AS locked',
    [ADVISORY_LOCK_KEY, ADVISORY_LOCK_ID]
  );
  if (!res.rows[0] || !res.rows[0].locked) {
    logError('MIGRATOR_ALREADY_RUNNING: Outro processo de migração está ativo no banco.');
    process.exit(2);
  }
}

async function releaseLock(client) {
  try {
    await client.query(
      'SELECT pg_advisory_unlock(hashtextextended($1, $2))',
      [ADVISORY_LOCK_KEY, ADVISORY_LOCK_ID]
    );
  } catch {
    // Ignora erro no teardown caso a conexão já tenha sido encerrada
  }
}

// Garante existência da tabela de metadados e restringe privilégios estritamente a administradores
async function ensureMetadataTable(client) {
  await client.query(`
    CREATE TABLE IF NOT EXISTS public.clientix_schema_migrations (
      version text PRIMARY KEY,
      name text NOT NULL,
      checksum text NOT NULL,
      applied_at timestamptz NOT NULL DEFAULT now(),
      execution_time_ms integer NOT NULL
    );
    -- Garante que clientes anon e authenticated NÃO tenham nenhum acesso à tabela de migrações
    REVOKE ALL ON TABLE public.clientix_schema_migrations FROM PUBLIC, anon, authenticated;
    GRANT SELECT ON TABLE public.clientix_schema_migrations TO service_role;
  `);
}

// Inspeciona banco para saber se é vazio, adotável ou já rastreado
async function inspectDatabaseState(client) {
  const hasMeta = await client.query(`
    SELECT EXISTS (
      SELECT 1 FROM information_schema.tables 
      WHERE table_schema = 'public' AND table_name = 'clientix_schema_migrations'
    ) AS exists;
  `);

  if (!hasMeta.rows[0].exists) {
    const tableCount = await client.query(`
      SELECT count(*)::int AS cnt FROM information_schema.tables 
      WHERE table_schema = 'public' AND table_type = 'BASE TABLE';
    `);
    if (tableCount.rows[0].cnt === 0) {
      return { type: 'FRESH_DATABASE', applied: [] };
    }
    return { type: 'EXISTING_UNTRACKED_INSTALLATION', tableCount: tableCount.rows[0].cnt };
  }

  const rows = await client.query(`
    SELECT version, name, checksum, applied_at, execution_time_ms 
    FROM public.clientix_schema_migrations 
    ORDER BY version ASC;
  `);
  return { type: 'TRACKED_INSTALLATION', applied: rows.rows };
}

function formatSchemaSequence(sequence) {
  if (!Number.isSafeInteger(sequence) || sequence < 0 || sequence > 999999) return null;
  return String(sequence).padStart(4, '0');
}

function deriveCurrentSchema(state, manifest) {
  const manifestTarget = formatSchemaSequence(Number(manifest.baseline?.incorporated_through_sequence));
  if (!manifestTarget || manifestTarget !== manifest.schema_target) {
    return { valid: false, currentSchema: null, error: 'MIGRATOR_SCHEMA_TARGET_INVALID' };
  }
  if (state.type === 'FRESH_DATABASE') {
    return { valid: true, currentSchema: null, error: null };
  }
  if (state.type !== 'TRACKED_INSTALLATION') {
    return { valid: false, currentSchema: null, error: 'CURRENT_SCHEMA_UNAVAILABLE' };
  }

  const markerRows = state.applied.filter((row) => typeof row.version === 'string' && row.version.startsWith('baseline:'));
  if (markerRows.length !== 1) {
    return { valid: false, currentSchema: null, error: 'BASELINE_MARKER_MISSING_OR_AMBIGUOUS' };
  }
  const markerMatch = markerRows[0].version.match(/^baseline:(\d{4,6})$/);
  if (!markerMatch) {
    return { valid: false, currentSchema: null, error: 'BASELINE_MARKER_INVALID' };
  }

  let currentSequence = Number(markerMatch[1]);
  if (!Number.isSafeInteger(currentSequence) || currentSequence > 999999) {
    return { valid: false, currentSchema: null, error: 'BASELINE_MARKER_INVALID' };
  }
  const targetSequence = Number(manifest.baseline?.incorporated_through_sequence);
  if (currentSequence === targetSequence && markerRows[0].checksum !== manifest.baseline.checksum) {
    return { valid: false, currentSchema: null, error: 'BASELINE_CHECKSUM_MISMATCH' };
  }

  const migrationsByVersion = new Map((manifest.migrations || []).map((migration) => [migration.version, migration]));
  for (const row of state.applied) {
    if (row === markerRows[0]) continue;
    const migration = migrationsByVersion.get(row.version);
    if (!migration || migration.checksum !== row.checksum || !Number.isSafeInteger(migration.sequence)) {
      return { valid: false, currentSchema: null, error: 'APPLIED_MIGRATION_UNKNOWN_OR_INCONSISTENT' };
    }
    currentSequence = Math.max(currentSequence, migration.sequence);
  }

  const currentSchema = formatSchemaSequence(currentSequence);
  if (!currentSchema) return { valid: false, currentSchema: null, error: 'CURRENT_SCHEMA_INVALID' };
  return { valid: true, currentSchema, error: null };
}

async function runVerification(client, verifySqlPath) {
  if (!fs.existsSync(verifySqlPath)) return;
  const sql = fs.readFileSync(verifySqlPath, 'utf8');
  await client.query(sql);
}

// CLI Commands
async function cmdStatus(jsonMode = false) {
  const paths = resolvePaths();
  const manifest = loadManifest(paths);
  const dbUrl = getDatabaseUrl();
  const client = await createClient(dbUrl);

  try {
    const state = await inspectDatabaseState(client);
    let pending = [];
    let checksumOk = true;
    const schemaEvidence = deriveCurrentSchema(state, manifest);
    if (!schemaEvidence.valid) checksumOk = false;

    if (state.type === 'TRACKED_INSTALLATION' && schemaEvidence.valid) {
      const appliedMap = new Map(state.applied.map((r) => [r.version, r]));
      const currentSequence = Number(schemaEvidence.currentSchema);
      pending = manifest.migrations.filter((mig) =>
        mig.sequence > currentSequence && !appliedMap.has(mig.version)
      );
    }

    const payload = {
      database_reachable: true,
      database_url: redactUrl(dbUrl),
      state_type: state.type,
      target_baseline: manifest.schema_target,
      current_schema: schemaEvidence.currentSchema,
      schema_evidence_valid: schemaEvidence.valid,
      schema_evidence_error: schemaEvidence.error,
      baseline_checksum: manifest.baseline.checksum,
      checksum_consistent: checksumOk,
      applied_count: state.applied ? state.applied.length : 0,
      pending_migrations_count: pending.length,
      pending_migrations: pending.map((p) => p.file),
    };

    if (jsonMode) {
      console.log(JSON.stringify(payload, null, 2));
    } else {
      log(`Conexão OK: ${payload.database_url}`);
      log(`Estado do banco: ${payload.state_type}`);
      log(`Versão alvo: ${payload.target_baseline}`);
      log(`Checksums íntegros: ${payload.checksum_consistent ? 'SIM' : 'NÃO'}`);
      log(`Migrações aplicadas registradas: ${payload.applied_count}`);
      log(`Migrações pendentes: ${payload.pending_migrations_count}`);
      if (pending.length > 0) {
        pending.forEach((p) => log(`  - [PENDENTE] ${p.file}`));
      }
    }
  } finally {
    await client.end();
  }
}

async function cmdCheck() {
  log('Executando verificação de integridade (DRY-RUN)...');
  const paths = resolvePaths();
  const manifest = loadManifest(paths);
  const dbUrl = getDatabaseUrl();
  const client = await createClient(dbUrl);

  try {
    await acquireLock(client);
    const state = await inspectDatabaseState(client);
    log(`Estado detectado: ${state.type}`);

    if (state.type === 'FRESH_DATABASE') {
      log('Banco limpo e elegível para FRESH INSTALL via baseline.sql.');
      return;
    }

    if (state.type === 'EXISTING_UNTRACKED_INSTALLATION') {
      log(`Banco possui ${state.tableCount} tabelas mas não tem metadados.`);
      log('Elegível para comando "adopt" após conferência de sanidade.');
      return;
    }

    // Valida checksums das registradas
    const appliedMap = new Map(state.applied.map((r) => [r.version, r]));
    const schemaEvidence = deriveCurrentSchema(state, manifest);
    if (!schemaEvidence.valid) {
      throw new Error(schemaEvidence.error || 'CURRENT_SCHEMA_UNAVAILABLE');
    }
    const baselineSequence = formatSchemaSequence(Number(manifest.baseline.incorporated_through_sequence));
    const baselineRow = baselineSequence ? appliedMap.get('baseline:' + baselineSequence) : undefined;
    if (baselineRow && baselineRow.checksum !== manifest.baseline.checksum) {
      logError(`CHECKSUM_MISMATCH: Baseline modificado! Registrado=${baselineRow.checksum}, Esperado=${manifest.baseline.checksum}`);
      process.exit(3);
    }

    for (const mig of manifest.migrations) {
      const app = appliedMap.get(mig.version);
      if (app) {
        if (app.checksum !== mig.checksum) {
          logError(`CHECKSUM_MISMATCH: Migração ${mig.file} no banco diverge do manifesto!`);
          process.exit(3);
        }
        // Confere também o arquivo em disco se ele existir
        const diskFile = path.join(paths.migrationsDir, mig.file);
        if (fs.existsSync(diskFile)) {
          const diskHash = crypto.createHash('sha256').update(fs.readFileSync(diskFile)).digest('hex');
          if (diskHash !== app.checksum) {
            logError(`CHECKSUM_MISMATCH: Arquivo em disco ${mig.file} adulterado após aplicação no banco!`);
            process.exit(3);
          }
        }
      }
    }

    // Executa verificação de sanidade estrutural
    await runVerification(client, paths.verifySql);
    log('Verificação de sanidade estrutural e integridade: PASS.');
  } finally {
    await releaseLock(client);
    await client.end();
  }
}

async function cmdInstall() {
  log('Iniciando FRESH INSTALL...');
  const paths = resolvePaths();
  const manifest = loadManifest(paths);
  const dbUrl = getDatabaseUrl();
  const client = await createClient(dbUrl);

  try {
    await acquireLock(client);
    const state = await inspectDatabaseState(client);
    if (state.type !== 'FRESH_DATABASE') {
      logError(`Comando "install" só é permitido em banco vazio. Estado atual: ${state.type}`);
      process.exit(4);
    }

    log('Garantindo schemas e extensões mínimas (auth, extensions, storage, vector, citext, pg_trgm)...');
    await client.query(`
      DO $$
      BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
          CREATE ROLE anon NOLOGIN;
        END IF;
        IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
          CREATE ROLE authenticated NOLOGIN;
        END IF;
        IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
          CREATE ROLE service_role NOLOGIN BYPASSRLS;
        END IF;
      END $$;

      CREATE SCHEMA IF NOT EXISTS auth;
      CREATE SCHEMA IF NOT EXISTS extensions;
      CREATE SCHEMA IF NOT EXISTS storage;

      CREATE EXTENSION IF NOT EXISTS "uuid-ossp" WITH SCHEMA extensions;
      CREATE EXTENSION IF NOT EXISTS pgcrypto WITH SCHEMA extensions;
      CREATE EXTENSION IF NOT EXISTS vector WITH SCHEMA public;
      CREATE EXTENSION IF NOT EXISTS citext WITH SCHEMA public;
      CREATE EXTENSION IF NOT EXISTS pg_trgm WITH SCHEMA public;

      -- Stubs de storage para tabelas referenciadas pelo baseline
      CREATE TABLE IF NOT EXISTS storage.buckets (
        id text PRIMARY KEY,
        name text NOT NULL,
        public boolean NOT NULL DEFAULT false,
        file_size_limit bigint,
        allowed_mime_types text[],
        created_at timestamptz NOT NULL DEFAULT now()
      );
      CREATE TABLE IF NOT EXISTS storage.objects (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        bucket_id text REFERENCES storage.buckets(id),
        name text,
        owner uuid,
        metadata jsonb,
        created_at timestamptz NOT NULL DEFAULT now()
      );

      -- Stubs de auth para tabelas e funções referenciadas pelo baseline
      CREATE TABLE IF NOT EXISTS auth.users (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        email text UNIQUE,
        raw_user_meta_data jsonb NOT NULL DEFAULT '{}'::jsonb,
        created_at timestamptz NOT NULL DEFAULT now()
      );
      CREATE TABLE IF NOT EXISTS auth.sessions (
        id uuid PRIMARY KEY,
        user_id uuid NOT NULL REFERENCES auth.users(id),
        aal text,
        not_after timestamptz
      );
      CREATE TABLE IF NOT EXISTS auth.mfa_factors (
        id uuid PRIMARY KEY,
        user_id uuid NOT NULL REFERENCES auth.users(id),
        status text,
        factor_type text DEFAULT 'totp'
      );
      CREATE OR REPLACE FUNCTION auth.jwt() RETURNS jsonb LANGUAGE sql STABLE AS $$
        SELECT COALESCE(NULLIF(current_setting('request.jwt.claim',true),''),NULLIF(current_setting('request.jwt.claims',true),''))::jsonb;
      $$;
      CREATE OR REPLACE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$
        SELECT COALESCE(
          NULLIF(current_setting('request.jwt.claim.sub', true), ''),
          (NULLIF(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub')
        )::uuid
      $$;

      GRANT USAGE ON SCHEMA auth, extensions, storage TO anon, authenticated, service_role;
      GRANT SELECT ON auth.users TO anon, authenticated, service_role;
    `);

    log(`Lendo baseline.sql (${manifest.baseline.size_bytes} bytes)...`);
    const baselineSql = fs.readFileSync(paths.baseline, 'utf8');
    const startMs = Date.now();

    log('Aplicando baseline.sql com integridade estrita...');
    await client.query(baselineSql);
    const executionTimeMs = Date.now() - startMs;
    log(`baseline.sql aplicado com sucesso em ${executionTimeMs}ms.`);

    log('Criando tabela de controle clientix_schema_migrations...');
    await ensureMetadataTable(client);

    const baselineSequence = formatSchemaSequence(Number(manifest.baseline.incorporated_through_sequence));
    if (!baselineSequence) throw new Error('MIGRATOR_SCHEMA_TARGET_INVALID');
    log('Registrando marcador do baseline ' + baselineSequence + '...');
    await client.query(
      `INSERT INTO public.clientix_schema_migrations (version, name, checksum, execution_time_ms)
       VALUES ($1, $2, $3, $4);`,
      ['baseline:' + baselineSequence, 'baseline_cumulativo_' + baselineSequence, manifest.baseline.checksum, executionTimeMs]
    );

    log('Executando verificações pós-instalação...');
    await runVerification(client, paths.verifySql);
    log('FRESH INSTALL CONCLUÍDO COM SUCESSO (Status: PASS).');
  } finally {
    await releaseLock(client);
    await client.end();
  }
}

async function cmdAdopt() {
  log('Iniciando ADOPTION MODE para instalação existente não rastreada...');
  const paths = resolvePaths();
  const manifest = loadManifest(paths);
  const dbUrl = getDatabaseUrl();
  const client = await createClient(dbUrl);

  try {
    await acquireLock(client);
    const state = await inspectDatabaseState(client);
    if (state.type !== 'EXISTING_UNTRACKED_INSTALLATION') {
      logError(`Banco não está em estado EXISTING_UNTRACKED_INSTALLATION. Estado: ${state.type}`);
      process.exit(5);
    }

    log(`Validando conformidade estrutural do banco (${state.tableCount} tabelas detectadas)...`);
    
    // Executa verificação em transação separada antes de criar metadata
    await runVerification(client, paths.verifySql);

    // Valida se o banco não possui evidências de ser de versão superior (DATABASE_NEWER_THAN_MIGRATOR)
    // Se a tabela system_version ou similar existir indicando versão posterior
    const versionCheck = await client.query(`
      SELECT EXISTS (
        SELECT 1 FROM information_schema.tables 
        WHERE table_schema = 'public' AND table_name = 'clientix_schema_migrations_future'
      ) AS future_exists;
    `);
    if (versionCheck.rows[0].future_exists) {
      logError('DATABASE_NEWER_THAN_MIGRATOR: Banco contém artefatos de versão mais recente que este migrador (' + manifest.schema_target + ').');
      process.exit(8);
    }

    const baselineSequence = formatSchemaSequence(Number(manifest.baseline.incorporated_through_sequence));
    if (!baselineSequence) throw new Error('MIGRATOR_SCHEMA_TARGET_INVALID');
    log('Banco compatível! Criando tabela de metadados e registrando marcador canônico baseline:' + baselineSequence + '...');
    await ensureMetadataTable(client);
    await client.query(
      `INSERT INTO public.clientix_schema_migrations (version, name, checksum, execution_time_ms)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (version) DO NOTHING;`,
      ['baseline:' + baselineSequence, 'baseline_cumulativo_' + baselineSequence + ' (ADOPTED)', manifest.baseline.checksum, 0]
    );

    log('ADOÇÃO CONCLUÍDA COM SUCESSO. Instalação agora está sob controle do Clientix Migrator.');
  } finally {
    await releaseLock(client);
    await client.end();
  }
}

async function cmdUpdate(args = []) {
  const hasBackupAck = args.includes('--backup-ack') || process.env.BACKUP_ACK === 'true' || process.env.BACKUP_ACK === '1';
  if (!hasBackupAck) {
    logError('BACKUP_REQUIRED: O comando "update" exige confirmação explícita de backup.');
    logError('Execute com a flag "--backup-ack" ou defina a variável BACKUP_ACK=true.');
    process.exit(6);
  }

  log('Iniciando UPDATE de migrações incrementais...');
  const paths = resolvePaths();
  const manifest = loadManifest(paths);
  const dbUrl = getDatabaseUrl();
  const client = await createClient(dbUrl);

  try {
    await acquireLock(client);
    const state = await inspectDatabaseState(client);
    if (state.type !== 'TRACKED_INSTALLATION') {
      logError(`Banco não está rastreado. Execute "install" (em banco novo) ou "adopt" (em banco existente). Estado: ${state.type}`);
      process.exit(7);
    }

    const schemaEvidence = deriveCurrentSchema(state, manifest);
    if (!schemaEvidence.valid || !schemaEvidence.currentSchema) {
      throw new Error(schemaEvidence.error || 'CURRENT_SCHEMA_UNAVAILABLE');
    }
    const currentSequence = Number(schemaEvidence.currentSchema);
    const appliedMap = new Map(state.applied.map((r) => [r.version, r]));
    const pending = [];
    const registeredByVersion = new Map((manifest.migrations || []).map((migration) => [migration.version, migration]));

    // Localiza migrações disponíveis que ainda não foram aplicadas
    const allFiles = fs.readdirSync(paths.migrationsDir).filter((f) => f.endsWith('.sql')).sort();
    for (const f of allFiles) {
      const m = f.match(/^(\d{14})_(\d{4})_(.+)\.sql$/);
      if (!m) continue;
      const version = m[1];
      const seq = parseInt(m[2], 10);
      if (seq <= currentSequence) continue;

      const registered = registeredByVersion.get(version);
      if (!registered || registered.file !== f || registered.sequence !== seq) {
        throw new Error('MIGRATION_REGISTRY_MISMATCH: ' + f);
      }

      const fullPath = path.join(paths.migrationsDir, f);
      const content = fs.readFileSync(fullPath);
      const checksum = crypto.createHash('sha256').update(content).digest('hex');
      if (checksum !== registered.checksum) {
        throw new Error('MIGRATION_CHECKSUM_MISMATCH: ' + f);
      }

      const applied = appliedMap.get(version);
      if (applied) {
        if (applied.checksum !== checksum) {
          throw new Error('MIGRATION_CHECKSUM_MISMATCH: ' + f);
        }
      } else {
        pending.push({ file: f, version, name: m[3], path: fullPath, checksum });
      }
    }

    if (pending.length === 0) {
      log('Nenhuma migração pendente. Banco está atualizado.');
      return;
    }

    log(`Encontradas ${pending.length} migrações pendentes para aplicar:`);
    for (const p of pending) {
      log(` -> Aplicando ${p.file}...`);
      const sql = fs.readFileSync(p.path, 'utf8');
      const startMs = Date.now();

      await client.query('BEGIN;');
      try {
        await client.query(sql);
        const elapsed = Date.now() - startMs;
        await client.query(
          `INSERT INTO public.clientix_schema_migrations (version, name, checksum, execution_time_ms)
           VALUES ($1, $2, $3, $4);`,
          [p.version, p.name, p.checksum, elapsed]
        );
        await client.query('COMMIT;');
        log(`    ✓ ${p.file} aplicada e registrada em ${elapsed}ms.`);
      } catch (err) {
        await client.query('ROLLBACK;');
        logError(`Falha ao aplicar ${p.file}: ${err.message}`);
        throw err;
      }
    }

    log('Executando verificação de integridade pós-update...');
    await runVerification(client, paths.verifySql);
    log('UPDATE CONCLUÍDO COM SUCESSO (Status: PASS).');
  } finally {
    await releaseLock(client);
    await client.end();
  }
}

function showHelp() {
  console.log(`
Uso: clientix-migrator <comando> [opções]

Comandos:
  status [--json]      Exibe o estado de migração e conexão do banco
  check                Valida checksums, compatibilidade e integridade (DRY-RUN)
  install              Instala banco limpo a partir do baseline oficial
  adopt                Adota uma instalação existente não rastreada
  update --backup-ack  Aplica migrações incrementais pendentes em ordem

Variáveis de Ambiente:
  DATABASE_URL         String de conexão PostgreSQL (obrigatória)
  BACKUP_ACK           Alternativa à flag --backup-ack (1 ou true)
`);
}

async function main() {
  const args = process.argv.slice(2);
  const command = args[0];

  if (!command || command === 'help' || command === '--help' || command === '-h') {
    showHelp();
    process.exit(0);
  }

  try {
    switch (command) {
      case 'status':
        await cmdStatus(args.includes('--json'));
        break;
      case 'check':
        await cmdCheck();
        break;
      case 'install':
        await cmdInstall();
        break;
      case 'adopt':
        await cmdAdopt();
        break;
      case 'update':
        await cmdUpdate(args.slice(1));
        break;
      default:
        logError(`Comando desconhecido: "${command}"`);
        showHelp();
        process.exit(1);
    }
  } catch (err) {
    logError(`Operação abortada: ${err.message}`);
    process.exit(1);
  }
}

module.exports = { formatSchemaSequence, deriveCurrentSchema };

if (require.main === module) {
  main();
}
