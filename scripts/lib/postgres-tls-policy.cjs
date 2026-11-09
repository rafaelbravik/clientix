/* eslint-disable @typescript-eslint/no-require-imports -- CommonJS helper shared by the app, migrator and shell tooling. */
'use strict';

const net = require('node:net');

const LOCAL_DOCKER_DATABASE_HOSTS = new Set(['supabase-db']);
const LOCAL_DOCKER_DATABASE_HOSTS_WITH_LOCAL_INGRESS = new Set([
  'control-plane-db',
  'host.docker.internal',
]);
const TLS_QUERY_PARAMETERS = ['sslmode', 'sslrootcert', 'sslcert', 'sslkey', 'sslpassword'];

function normalizeHost(hostname) {
  let host = hostname.toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '');
  if (net.isIP(host) === 6) {
    try {
      host = new URL(`postgres://[${host}]/`).hostname.replace(/^\[|\]$/g, '');
    } catch {
      // An invalid address remains remote and therefore requires verified TLS.
    }
  }
  return host;
}

function classifyPostgresHost(hostname) {
  const host = normalizeHost(String(hostname || ''));
  if (host === 'localhost' || host.endsWith('.localhost')) return 'LOCAL_LOOPBACK';

  const ipVersion = net.isIP(host);
  if (ipVersion === 4 && Number(host.split('.')[0]) === 127) return 'LOCAL_LOOPBACK';
  if (ipVersion === 6 && host === '::1') return 'LOCAL_LOOPBACK';

  if (LOCAL_DOCKER_DATABASE_HOSTS.has(host)) return 'LOCAL_DOCKER_NETWORK';
  return 'REMOTE';
}

function caFromEnvironment(encoded) {
  if (!encoded) return undefined;
  const compact = encoded.replace(/\s+/g, '');
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(compact)) {
    throw new Error('POSTGRES_SSL_ROOT_CERT must be base64-encoded PEM certificate data');
  }
  const pem = Buffer.from(compact, 'base64').toString('utf8');
  if (!pem.includes('-----BEGIN CERTIFICATE-----') || !pem.includes('-----END CERTIFICATE-----')) {
    throw new Error('POSTGRES_SSL_ROOT_CERT must contain a PEM certificate');
  }
  return pem;
}

function removeTlsQueryParameters(url) {
  for (const key of [...url.searchParams.keys()]) {
    if (TLS_QUERY_PARAMETERS.includes(key.toLowerCase())) url.searchParams.delete(key);
  }
}

function resolvePostgresConnectionConfig(
  connectionString,
  rootCert = process.env.POSTGRES_SSL_ROOT_CERT,
  options = {},
) {
  let url;
  try {
    url = new URL(connectionString);
  } catch {
    throw new Error('PostgreSQL connection URL is invalid');
  }
  if (url.protocol !== 'postgres:' && url.protocol !== 'postgresql:') {
    throw new Error('PostgreSQL connection URL must use postgres or postgresql');
  }
  if (!url.hostname) throw new Error('PostgreSQL connection URL must include a host');

  const host = normalizeHost(url.hostname);
  const localDockerHostWithOptIn =
    options.allowLocalDockerHosts === true &&
    LOCAL_DOCKER_DATABASE_HOSTS_WITH_LOCAL_INGRESS.has(host);
  const connectionClass = localDockerHostWithOptIn
    ? 'LOCAL_DOCKER_NETWORK'
    : classifyPostgresHost(host);
  removeTlsQueryParameters(url);
  if (connectionClass !== 'REMOTE') return { connectionString: url.toString(), ssl: false };

  const ca = caFromEnvironment(rootCert);
  return {
    connectionString: url.toString(),
    ssl: { rejectUnauthorized: true, ...(ca ? { ca } : {}) },
  };
}

function resolveExternalPostgresSsl(hostname, mode, rootCert = process.env.POSTGRES_SSL_ROOT_CERT) {
  const connectionClass = classifyPostgresHost(hostname);
  if (connectionClass !== 'REMOTE') {
    switch (mode) {
      case 'disable':
        return false;
      case 'prefer':
      case 'require':
        return { rejectUnauthorized: false };
      case 'verify-ca':
      case 'verify-full': {
        const ca = caFromEnvironment(rootCert);
        return { rejectUnauthorized: true, ...(ca ? { ca } : {}) };
      }
      default:
        throw new Error('Unsupported PostgreSQL TLS mode');
    }
  }

  if (mode === 'disable') {
    throw new Error('REMOTE_DATABASE_TLS_REQUIRED: remote PostgreSQL connections cannot disable TLS');
  }

  const ca = caFromEnvironment(rootCert);
  return { rejectUnauthorized: true, ...(ca ? { ca } : {}) };
}

function redactPostgresDiagnostic(message) {
  return String(message).replace(/\bpostgres(?:ql)?:\/\/[^\s"'<>]+/gi, '[redacted PostgreSQL URL]');
}

module.exports = {
  classifyPostgresHost,
  resolvePostgresConnectionConfig,
  resolveExternalPostgresSsl,
  redactPostgresDiagnostic,
};
