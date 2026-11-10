import crypto from "node:crypto";

export interface SignerProvisioningDatabase {
  query<R = Record<string, unknown>>(
    sql: string,
    params?: unknown[],
  ): Promise<{ rows: R[]; rowCount?: number | null }>;
}

export interface SignerKeyRow {
  key_id: string;
  algorithm: string;
  public_key_pem: string;
  is_active: boolean;
}

export type SignerProvisioningResult = "PROVISIONED" | "NO_CHANGE";

export class SignerKeyProvisioningError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = "SignerKeyProvisioningError";
  }
}

const SIGNER_KEY_ID_PATTERN = /^[A-Za-z0-9._:-]{1,100}$/;

/** Derives a canonical Ed25519 SPKI public key without exposing the private key. */
export function deriveSignerPublicKey(privateKeyPem: string): string {
  let privateKey: crypto.KeyObject;
  try {
    privateKey = crypto.createPrivateKey(privateKeyPem);
  } catch {
    throw new SignerKeyProvisioningError("SIGNER_PRIVATE_KEY_INVALID");
  }
  if (privateKey.asymmetricKeyType !== "ed25519") {
    throw new SignerKeyProvisioningError("SIGNER_PRIVATE_KEY_ALGORITHM_INVALID");
  }
  return crypto.createPublicKey(privateKey).export({ type: "spki", format: "pem" }).toString();
}

/** Ensures the separately stored public PEM is the one derived from the private key. */
export function assertSignerKeyPairMatches(
  privateKeyPem: string,
  configuredPublicKeyPem: string,
): string {
  const derivedPublicKeyPem = deriveSignerPublicKey(privateKeyPem);
  if (!publicKeysMatch(derivedPublicKeyPem, configuredPublicKeyPem)) {
    throw new SignerKeyProvisioningError("SIGNER_PUBLIC_KEY_MISMATCH");
  }
  return derivedPublicKeyPem;
}

/**
 * Registers only the public half of the configured signer.
 *
 * The first run inserts a key only into an empty registry. Re-runs accept the
 * same single active key without changing it. Existing retired keys, another
 * active key, or a mismatch require explicit operator action and fail closed.
 */
export async function provisionActiveSignerPublicKey(
  db: SignerProvisioningDatabase,
  params: {
    keyId: string;
    privateKeyPem: string;
    configuredPublicKeyPem: string;
  },
): Promise<SignerProvisioningResult> {
  if (!SIGNER_KEY_ID_PATTERN.test(params.keyId)) {
    throw new SignerKeyProvisioningError("SIGNER_KEY_ID_INVALID");
  }
  const publicKeyPem = assertSignerKeyPairMatches(
    params.privateKeyPem,
    params.configuredPublicKeyPem,
  );

  await db.query("begin;");
  try {
    // Serialize only this owner provisioning operation; it does not mutate
    // other Control Plane workflows or activate retired keys.
    await db.query("select pg_advisory_xact_lock(17228, 18776);");
    const { rows } = await db.query<SignerKeyRow>(
      `select key_id, algorithm, public_key_pem, is_active
         from control_plane.licensing_signer_keys
        order by key_id
        for update;`,
    );
    const activeKeys = rows.filter((row) => row.is_active);

    if (rows.length === 0) {
      await db.query(
        `insert into control_plane.licensing_signer_keys
          (key_id, algorithm, public_key_pem, is_active)
         values ($1, 'Ed25519', $2, true);`,
        [params.keyId, publicKeyPem],
      );
      await db.query("commit;");
      return "PROVISIONED";
    }

    if (activeKeys.length !== 1) {
      throw new SignerKeyProvisioningError(
        activeKeys.length === 0
          ? "SIGNER_REGISTRY_HAS_NO_ACTIVE_KEY"
          : "SIGNER_REGISTRY_HAS_MULTIPLE_ACTIVE_KEYS",
      );
    }

    const activeKey = activeKeys[0];
    if (!activeKey || activeKey.key_id !== params.keyId) {
      throw new SignerKeyProvisioningError("SIGNER_ACTIVE_KEY_ID_MISMATCH");
    }
    if (activeKey.algorithm !== "Ed25519") {
      throw new SignerKeyProvisioningError("SIGNER_ACTIVE_KEY_ALGORITHM_MISMATCH");
    }
    if (!publicKeysMatch(activeKey.public_key_pem, publicKeyPem)) {
      throw new SignerKeyProvisioningError("SIGNER_ACTIVE_KEY_MATERIAL_MISMATCH");
    }

    await db.query("commit;");
    return "NO_CHANGE";
  } catch (error) {
    await db.query("rollback;").catch(() => undefined);
    throw error;
  }
}

function publicKeysMatch(firstPem: string, secondPem: string): boolean {
  try {
    const first = crypto.createPublicKey(firstPem);
    const second = crypto.createPublicKey(secondPem);
    if (first.asymmetricKeyType !== "ed25519" || second.asymmetricKeyType !== "ed25519") {
      return false;
    }
    const firstDer = first.export({ type: "spki", format: "der" });
    const secondDer = second.export({ type: "spki", format: "der" });
    return firstDer.length === secondDer.length && crypto.timingSafeEqual(firstDer, secondDer);
  } catch {
    return false;
  }
}
