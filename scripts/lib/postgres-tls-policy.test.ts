import { describe, expect, it } from 'vitest';

import {
  classifyPostgresHost,
  redactPostgresDiagnostic,
  resolveExternalPostgresSsl,
  resolvePostgresConnectionConfig,
} from './postgres-tls-policy.cjs';

const TEST_CA = Buffer.from(
  '-----BEGIN CERTIFICATE-----\nZmFrZS1jYS1maXh0dXJl\n-----END CERTIFICATE-----\n',
).toString('base64');

describe('política TLS de PostgreSQL', () => {
  it.each(['localhost', '127.0.0.1', '127.42.8.9', '::1', '0:0:0:0:0:0:0:1'])('classifica loopback canônico: %s', (host) => {
    expect(classifyPostgresHost(host)).toBe('LOCAL_LOOPBACK');
  });

  it('classifica apenas o hostname Docker documentado como rede local isolada', () => {
    expect(classifyPostgresHost('supabase-db')).toBe('LOCAL_DOCKER_NETWORK');
    expect(classifyPostgresHost('db')).toBe('REMOTE');
    expect(classifyPostgresHost('10.0.4.2')).toBe('REMOTE');
    expect(classifyPostgresHost('2001:db8::2')).toBe('REMOTE');
  });

  it('força TLS e valida cadeia/hostname para URL remota mesmo sem sslmode', () => {
    const config = resolvePostgresConnectionConfig('postgresql://worker:synthetic@db.example.test/clientix');
    expect(config.ssl).toMatchObject({ rejectUnauthorized: true });
  });

  it('não deixa query string enfraquecer a política TLS e aplica a CA de runtime', () => {
    const config = resolvePostgresConnectionConfig(
      'postgres://worker:synthetic@10.20.0.15/clientix?sslmode=disable&sslrootcert=%2Ftmp%2Fwrong.pem',
      TEST_CA,
    );
    expect(config.ssl).toMatchObject({ rejectUnauthorized: true, ca: expect.stringContaining('BEGIN CERTIFICATE') });
    expect(config.connectionString).not.toMatch(/sslmode|sslrootcert/i);
  });

  it('recusa CA malformada antes de abrir uma conexão remota', () => {
    expect(() => resolvePostgresConnectionConfig('postgres://u:p@db.example.test/x', 'not-base64!'))
      .toThrow('POSTGRES_SSL_ROOT_CERT');
    expect(() => resolvePostgresConnectionConfig('postgres://u:p@db.example.test/x', Buffer.from('no cert').toString('base64')))
      .toThrow('PEM certificate');
  });

  it('permite plaintext somente nos hosts locais explícitos', () => {
    expect(resolvePostgresConnectionConfig('postgres://u:p@localhost/x').ssl).toBe(false);
    expect(resolvePostgresConnectionConfig('postgres://u:p@supabase-db/x?sslmode=require').ssl).toBe(false);
    expect(resolvePostgresConnectionConfig('postgres://u:p@10.0.0.2/x').ssl).toMatchObject({ rejectUnauthorized: true });
  });

  it('permite os hostnames da stack Docker local somente com opt-in', () => {
    const localOptions = { allowLocalDockerHosts: true };
    for (const host of ['host.docker.internal', 'control-plane-db']) {
      const url = `postgres://worker:synthetic@${host}/clientix?sslmode=require`;
      expect(resolvePostgresConnectionConfig(url).ssl).toMatchObject({ rejectUnauthorized: true });
      expect(resolvePostgresConnectionConfig(url, undefined, localOptions).ssl).toBe(false);
    }

    expect(
      resolvePostgresConnectionConfig(
        'postgres://worker:synthetic@10.0.0.2/clientix?sslmode=disable',
        undefined,
        localOptions,
      ).ssl,
    ).toMatchObject({ rejectUnauthorized: true });
  });

  it('nega disable para banco externo e valida TLS para require/prefer remoto', () => {
    expect(() => resolveExternalPostgresSsl('db.example.test', 'disable'))
      .toThrow('REMOTE_DATABASE_TLS_REQUIRED');
    expect(resolveExternalPostgresSsl('db.example.test', 'require')).toMatchObject({ rejectUnauthorized: true });
    expect(resolveExternalPostgresSsl('db.example.test', 'prefer')).toMatchObject({ rejectUnauthorized: true });
  });

  it('preserva o escape plaintext para o Postgres local do Compose', () => {
    expect(resolveExternalPostgresSsl('supabase-db', 'disable')).toBe(false);
    expect(resolveExternalPostgresSsl('127.0.0.1', 'disable')).toBe(false);
  });

  it('redige connection string completa de diagnósticos', () => {
    const diagnostic = redactPostgresDiagnostic('failed: postgresql://user:password@db.example.test:5432/app?sslmode=require');
    expect(diagnostic).not.toContain('password');
    expect(diagnostic).not.toContain('db.example.test');
    expect(diagnostic).toContain('[redacted PostgreSQL URL]');
  });
});
