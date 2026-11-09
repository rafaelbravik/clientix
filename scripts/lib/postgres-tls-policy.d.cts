import type { PoolConfig } from 'pg';

export type PostgresHostClass = 'LOCAL_LOOPBACK' | 'LOCAL_DOCKER_NETWORK' | 'REMOTE';
export interface PostgresConnectionOptions {
  allowLocalDockerHosts?: boolean;
}

export function classifyPostgresHost(hostname: string): PostgresHostClass;

export function resolvePostgresConnectionConfig(
  connectionString: string,
  rootCert?: string,
  options?: PostgresConnectionOptions,
): Pick<PoolConfig, 'connectionString' | 'ssl'>;

export function resolveExternalPostgresSsl(
  hostname: string,
  mode: 'disable' | 'prefer' | 'require' | 'verify-ca' | 'verify-full',
  rootCert?: string,
): PoolConfig['ssl'];

export function redactPostgresDiagnostic(message: unknown): string;
