import crypto from "node:crypto";
import { z } from "zod";

import { createPool } from "@/lib/agent-engine/db/pool";
import type { DatabaseClient } from "../scripts/migrator";
import { PostgresNonceStore } from "./nonce-store";
import { PostgresRateLimiter } from "./rate-limiter";
import { KeySelectionVendorSignerProvider, type KeyRegistryEntry } from "./signer";
import { ControlPlaneService } from "./service";
import {
  resolveControlPlaneConfig,
  ControlPlaneConfigurationError,
} from "./admin-service-provider";
import {
  attachAttestationChallengeSignature,
  attachInstallationRecoverySignature,
  attachLicenseServerResponseSignature,
  type AttestationChallengePayload,
  type InstallationRecoveryPayload,
  type SignedInstallationRecovery,
  type SignedAttestationChallenge,
  type LicenseServerResponsePayload,
  type SignedLicenseServerResponse,
} from "@/lib/licensing/online-cache";

const operationalConfigSchema = z.object({
  CONTROL_PLANE_LICENSE_SIGNING_KEYS_JSON: z.string().min(2),
  CONTROL_PLANE_ACTIVE_LICENSE_KEY_ID: z.string().min(1).max(100),
  CONTROL_PLANE_NEXT_CHECK_HOURS: z.coerce.number().int().min(1).max(720).default(24),
  CONTROL_PLANE_OFFLINE_VALIDATION_TOLERANCE_DAYS: z.coerce
    .number()
    .int()
    .min(0)
    .max(30)
    .default(7),
  CONTROL_PLANE_CLONE_SESSION_WINDOW_SECONDS: z.coerce
    .number()
    .int()
    .min(60)
    .max(86_400)
    .default(900),
});

export interface LicenseServerEnvironment {
  [key: string]: string | undefined;
  CONTROL_PLANE_DATABASE_URL?: string;
  CONTROL_PLANE_PEPPER?: string;
  CONTROL_PLANE_LICENSE_SIGNING_KEYS_JSON?: string;
  CONTROL_PLANE_ACTIVE_LICENSE_KEY_ID?: string;
  CONTROL_PLANE_NEXT_CHECK_HOURS?: string;
  CONTROL_PLANE_OFFLINE_VALIDATION_TOLERANCE_DAYS?: string;
  CONTROL_PLANE_CLONE_SESSION_WINDOW_SECONDS?: string;
  SUPABASE_DB_URL?: string;
}

export interface LicenseServerRuntimeConfig {
  databaseUrl: string;
  pepper: string;
  activeKeyId: string;
  signingKeys: KeyRegistryEntry[];
  nextCheckHours: number;
  offlineValidationToleranceDays: number;
  cloneSessionWindowSeconds: number;
}

export function resolveLicenseServerRuntimeConfig(
  source: LicenseServerEnvironment,
  customerDatabaseUrl: string | undefined = source.SUPABASE_DB_URL,
): LicenseServerRuntimeConfig {
  try {
    const database = resolveControlPlaneConfig(source, customerDatabaseUrl);
    const operational = operationalConfigSchema.parse(source);
    const parsedKeys: unknown = JSON.parse(operational.CONTROL_PLANE_LICENSE_SIGNING_KEYS_JSON);
    const keysSchema = z.record(z.string().min(1).max(100), z.string().min(1));
    const privateKeyMap = keysSchema.parse(parsedKeys);
    if (!privateKeyMap[operational.CONTROL_PLANE_ACTIVE_LICENSE_KEY_ID]) {
      throw new Error("configured active key missing");
    }
    const signingKeys = Object.entries(privateKeyMap).map(([keyId, privateKeyPem]) => {
      const privateKey = crypto.createPrivateKey(privateKeyPem);
      if (privateKey.asymmetricKeyType !== "ed25519") throw new Error("unsupported key algorithm");
      return { keyId, privateKeyPem, isActive: true, algorithm: "Ed25519" };
    });
    return {
      ...database,
      activeKeyId: operational.CONTROL_PLANE_ACTIVE_LICENSE_KEY_ID,
      signingKeys,
      nextCheckHours: operational.CONTROL_PLANE_NEXT_CHECK_HOURS,
      offlineValidationToleranceDays: operational.CONTROL_PLANE_OFFLINE_VALIDATION_TOLERANCE_DAYS,
      cloneSessionWindowSeconds: operational.CONTROL_PLANE_CLONE_SESSION_WINDOW_SECONDS,
    };
  } catch {
    throw new ControlPlaneConfigurationError();
  }
}

interface QueryClient {
  query<R = Record<string, unknown>>(
    sql: string,
    params?: unknown[],
  ): Promise<{ rows: R[]; rowCount?: number | null }>;
  release(): void;
}

class PinnedDatabaseClient implements DatabaseClient {
  constructor(private readonly client: QueryClient) {}

  async query<R = Record<string, unknown>>(
    sql: string,
    params: unknown[] = [],
  ): Promise<{ rows: R[]; rowCount?: number }> {
    const result = await this.client.query<R>(sql, params);
    return { rows: result.rows, rowCount: result.rowCount ?? undefined };
  }
}

let pool: ReturnType<typeof createPool> | null = null;

export async function withControlPlaneLicenseService<T>(
  operation: (
    service: ControlPlaneService,
    runtime: Pick<
      LicenseServerRuntimeConfig,
      "activeKeyId" | "nextCheckHours" | "offlineValidationToleranceDays"
    > & {
      signResponse(payload: LicenseServerResponsePayload): SignedLicenseServerResponse;
      signAttestationChallenge(payload: AttestationChallengePayload): SignedAttestationChallenge;
      signInstallationRecovery(payload: InstallationRecoveryPayload): SignedInstallationRecovery;
    },
  ) => Promise<T>,
): Promise<T> {
  const config = resolveLicenseServerRuntimeConfig(process.env);
  pool ??= createPool(config.databaseUrl, undefined, { max: 8 });
  const client = await pool.connect();
  const db = new PinnedDatabaseClient(client);
  try {
    const keyResult = await db.query<{
      key_id: string;
      public_key_pem: string;
      is_active: boolean;
    }>(
      `select key_id, public_key_pem, is_active from control_plane.licensing_signer_keys order by key_id;`,
    );
    const activeKeys = keyResult.rows.filter((key) => key.is_active);
    if (activeKeys.length !== 1 || activeKeys[0]?.key_id !== config.activeKeyId) {
      throw new ControlPlaneConfigurationError();
    }
    const publicKeys: Record<string, string> = {};
    for (const key of keyResult.rows) {
      const configuredPrivateKey = config.signingKeys.find(
        (candidate) => candidate.keyId === key.key_id,
      );
      if (configuredPrivateKey)
        assertKeyPairMatches(configuredPrivateKey.privateKeyPem, key.public_key_pem);
      publicKeys[key.key_id] = key.public_key_pem;
    }

    const signerKeys = config.signingKeys.map((key) => ({
      ...key,
      isActive:
        keyResult.rows.find((registered) => registered.key_id === key.keyId)?.is_active === true,
    }));
    const signerProvider = new KeySelectionVendorSignerProvider(signerKeys);
    const service = new ControlPlaneService({
      db,
      signerProvider,
      trustedPublicKeyMap: publicKeys,
      pepper: config.pepper,
      nonceStore: new PostgresNonceStore(db),
      rateLimiter: new PostgresRateLimiter(db, config.pepper),
      cloneSessionWindowSeconds: config.cloneSessionWindowSeconds,
    });
    return await operation(service, {
      activeKeyId: config.activeKeyId,
      nextCheckHours: config.nextCheckHours,
      offlineValidationToleranceDays: config.offlineValidationToleranceDays,
      signResponse: (payload) => {
        const activeKey = config.signingKeys.find((key) => key.keyId === config.activeKeyId);
        if (!activeKey) throw new ControlPlaneConfigurationError();
        return attachLicenseServerResponseSignature(
          payload,
          activeKey.privateKeyPem,
          activeKey.keyId,
        );
      },
      signAttestationChallenge: (payload) => {
        const activeKey = config.signingKeys.find((key) => key.keyId === config.activeKeyId);
        if (!activeKey) throw new ControlPlaneConfigurationError();
        return attachAttestationChallengeSignature(
          payload,
          activeKey.privateKeyPem,
          activeKey.keyId,
        );
      },
      signInstallationRecovery: (payload) => {
        const activeKey = config.signingKeys.find((key) => key.keyId === config.activeKeyId);
        if (!activeKey) throw new ControlPlaneConfigurationError();
        return attachInstallationRecoverySignature(
          payload,
          activeKey.privateKeyPem,
          activeKey.keyId,
        );
      },
    });
  } finally {
    client.release();
  }
}

function assertKeyPairMatches(privateKeyPem: string, publicKeyPem: string): void {
  const privateKey = crypto.createPrivateKey(privateKeyPem);
  const derivedPublicKey = crypto
    .createPublicKey(privateKey)
    .export({ type: "spki", format: "der" });
  const configuredPublicKey = crypto
    .createPublicKey(publicKeyPem)
    .export({ type: "spki", format: "der" });
  if (
    derivedPublicKey.length !== configuredPublicKey.length ||
    !crypto.timingSafeEqual(derivedPublicKey, configuredPublicKey)
  ) {
    throw new ControlPlaneConfigurationError();
  }
}
