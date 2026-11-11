import { afterEach, describe, expect, it } from 'vitest';

import { resolveAgentEnginePostgresConnectionConfig } from './pool';

const originalIngressMode = process.env.CLIENTIX_INGRESS_MODE;

afterEach(() => {
  if (originalIngressMode === undefined) delete process.env.CLIENTIX_INGRESS_MODE;
  else process.env.CLIENTIX_INGRESS_MODE = originalIngressMode;
});

describe('TLS do pool do agent-engine', () => {
  it('aceita os hostnames exclusivos da stack Docker local quando o ingress é local', () => {
    process.env.CLIENTIX_INGRESS_MODE = 'local';

    const config = resolveAgentEnginePostgresConnectionConfig(
      'postgres://worker:synthetic@host.docker.internal/clientix?sslmode=require',
    );
    expect(config.ssl).toBe(false);
  });

  it('só permite hostname Docker fornecido pelo caller Vendor quando o ingress é local', () => {
    const url = 'postgres://worker:synthetic@control-plane-db/clientix?sslmode=require';
    process.env.CLIENTIX_INGRESS_MODE = 'local';
    expect(resolveAgentEnginePostgresConnectionConfig(url).ssl).toMatchObject({
      rejectUnauthorized: true,
    });
    expect(resolveAgentEnginePostgresConnectionConfig(url, ['control-plane-db']).ssl).toBe(false);

    process.env.CLIENTIX_INGRESS_MODE = 'production';
    expect(resolveAgentEnginePostgresConnectionConfig(url, ['control-plane-db']).ssl).toMatchObject({
      rejectUnauthorized: true,
    });
  });

  it('mantém TLS obrigatório fora do modo local e para hosts remotos', () => {
    process.env.CLIENTIX_INGRESS_MODE = 'production';
    const localGateway = resolveAgentEnginePostgresConnectionConfig(
      'postgres://worker:synthetic@host.docker.internal/clientix',
    );
    expect(localGateway.ssl).toMatchObject({ rejectUnauthorized: true });

    process.env.CLIENTIX_INGRESS_MODE = 'local';
    const remoteHost = resolveAgentEnginePostgresConnectionConfig(
      'postgres://worker:synthetic@10.0.0.2/clientix?sslmode=disable',
    );
    expect(remoteHost.ssl).toMatchObject({ rejectUnauthorized: true });
  });
});
