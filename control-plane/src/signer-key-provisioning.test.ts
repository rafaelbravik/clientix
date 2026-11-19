import crypto from "node:crypto";
import { describe, expect, it } from "vitest";

import {
  assertSignerKeyPairMatches,
  deriveSignerPublicKey,
  provisionActiveSignerPublicKey,
  SignerKeyProvisioningError,
  type SignerKeyRow,
  type SignerProvisioningDatabase,
} from "./signer-key-provisioning";

function generateKeyPair(): { privateKeyPem: string; publicKeyPem: string } {
  const pair = crypto.generateKeyPairSync("ed25519");
  return {
    privateKeyPem: pair.privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
    publicKeyPem: pair.publicKey.export({ type: "spki", format: "pem" }).toString(),
  };
}

class FakeSignerDatabase implements SignerProvisioningDatabase {
  readonly statements: string[] = [];
  readonly insertedValues: unknown[][] = [];

  constructor(public rows: SignerKeyRow[] = []) {}

  async query<R = Record<string, unknown>>(
    sql: string,
    params: unknown[] = [],
  ): Promise<{ rows: R[]; rowCount?: number }> {
    const normalized = sql.trim().toLowerCase();
    this.statements.push(normalized);
    if (normalized.startsWith("select key_id")) {
      return { rows: this.rows.map((row) => ({ ...row })) as R[] };
    }
    if (normalized.startsWith("insert into control_plane.licensing_signer_keys")) {
      this.insertedValues.push(params);
      this.rows.push({
        key_id: String(params[0]),
        algorithm: "Ed25519",
        public_key_pem: String(params[1]),
        is_active: true,
      });
    }
    return { rows: [] as R[] };
  }
}

const KEY_ID = "clientix-certification-test-fixture";

function provisioningParams(
  pair: { privateKeyPem: string; publicKeyPem: string },
  keyId = KEY_ID,
): { keyId: string; privateKeyPem: string; configuredPublicKeyPem: string } {
  return {
    keyId,
    privateKeyPem: pair.privateKeyPem,
    configuredPublicKeyPem: pair.publicKeyPem,
  };
}

describe("local Control Plane signer provisioning", () => {
  it("derives and transactionally registers the public key on an empty registry", async () => {
    const pair = generateKeyPair();
    const db = new FakeSignerDatabase();

    const result = await provisionActiveSignerPublicKey(db, provisioningParams(pair));

    expect(result).toBe("PROVISIONED");
    expect(db.rows).toHaveLength(1);
    expect(db.rows[0]).toMatchObject({
      key_id: KEY_ID,
      algorithm: "Ed25519",
      is_active: true,
    });
    expect(db.rows[0]?.public_key_pem).toBe(deriveSignerPublicKey(pair.privateKeyPem));
    expect(db.insertedValues[0]).not.toContain(pair.privateKeyPem);
    expect(db.statements[0]).toBe("begin;");
    expect(
      db.statements.some((statement) => statement.startsWith("select pg_advisory_xact_lock")),
    ).toBe(true);
    expect(db.statements.at(-1)).toBe("commit;");
  });

  it("is idempotent and leaves the existing matching active key unchanged", async () => {
    const pair = generateKeyPair();
    const db = new FakeSignerDatabase();

    expect(await provisionActiveSignerPublicKey(db, provisioningParams(pair))).toBe("PROVISIONED");
    const storedPublicKey = db.rows[0]?.public_key_pem;
    expect(await provisionActiveSignerPublicKey(db, provisioningParams(pair))).toBe("NO_CHANGE");

    expect(db.rows).toHaveLength(1);
    expect(db.rows[0]?.public_key_pem).toBe(storedPublicKey);
    expect(db.insertedValues).toHaveLength(1);
  });

  it("rejects a mismatched private/public pair before opening a transaction", async () => {
    const signer = generateKeyPair();
    const wrongPublic = generateKeyPair();
    const db = new FakeSignerDatabase();

    expect(() =>
      assertSignerKeyPairMatches(signer.privateKeyPem, wrongPublic.publicKeyPem),
    ).toThrow(new SignerKeyProvisioningError("SIGNER_PUBLIC_KEY_MISMATCH"));
    await expect(
      provisionActiveSignerPublicKey(db, {
        keyId: KEY_ID,
        privateKeyPem: signer.privateKeyPem,
        configuredPublicKeyPem: wrongPublic.publicKeyPem,
      }),
    ).rejects.toThrow("SIGNER_PUBLIC_KEY_MISMATCH");
    expect(db.statements).toHaveLength(0);
  });

  it("fails closed when the private key is missing or invalid", async () => {
    const pair = generateKeyPair();
    expect(() => deriveSignerPublicKey("")).toThrow("SIGNER_PRIVATE_KEY_INVALID");
    const db = new FakeSignerDatabase();
    await expect(
      provisionActiveSignerPublicKey(db, {
        keyId: KEY_ID,
        privateKeyPem: "",
        configuredPublicKeyPem: pair.publicKeyPem,
      }),
    ).rejects.toThrow("SIGNER_PRIVATE_KEY_INVALID");
    expect(db.statements).toHaveLength(0);
  });

  it("refuses to proceed when more than one signer key is active", async () => {
    const pair = generateKeyPair();
    const other = generateKeyPair();
    const db = new FakeSignerDatabase([
      { key_id: KEY_ID, algorithm: "Ed25519", public_key_pem: pair.publicKeyPem, is_active: true },
      {
        key_id: "other-owner-key",
        algorithm: "Ed25519",
        public_key_pem: other.publicKeyPem,
        is_active: true,
      },
    ]);

    await expect(provisionActiveSignerPublicKey(db, provisioningParams(pair))).rejects.toThrow(
      "SIGNER_REGISTRY_HAS_MULTIPLE_ACTIVE_KEYS",
    );
    expect(db.statements.at(-1)).toBe("rollback;");
    expect(db.rows).toHaveLength(2);
  });

  it("refuses key replacement, reactivation of retired-only rows, and a foreign active key", async () => {
    const pair = generateKeyPair();
    const other = generateKeyPair();
    const scenarios: SignerKeyRow[][] = [
      [
        {
          key_id: KEY_ID,
          algorithm: "Ed25519",
          public_key_pem: other.publicKeyPem,
          is_active: true,
        },
      ],
      [
        {
          key_id: "retired-key",
          algorithm: "Ed25519",
          public_key_pem: pair.publicKeyPem,
          is_active: false,
        },
      ],
      [
        {
          key_id: "other-owner-key",
          algorithm: "Ed25519",
          public_key_pem: other.publicKeyPem,
          is_active: true,
        },
      ],
    ];

    for (const rows of scenarios) {
      const db = new FakeSignerDatabase(rows);
      await expect(
        provisionActiveSignerPublicKey(db, provisioningParams(pair)),
      ).rejects.toBeInstanceOf(SignerKeyProvisioningError);
      expect(db.insertedValues).toHaveLength(0);
      expect(db.statements.at(-1)).toBe("rollback;");
    }
  });
});
