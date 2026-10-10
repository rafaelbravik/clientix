import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "fs/promises";
import path from "path";
import os from "os";
import {
  isValidCanonicalInstallationId,
  generateInstallationKeyPair,
  isValidInstallationPrivateKey,
  isValidInstallationPublicKey,
  deriveInstallationPublicKey,
  getOrCreateInstallationPrivateKey,
  generateActivationCode,
  deriveActivationCodeDigest,
  timingSafeEqualDigests,
  normalizeCanonicalPath,
  computeRawBodySha256,
  generateRequestNonce,
  createInstallationRequestSignature,
  verifyInstallationRequestSignature,
  MemoryNonceStore,
  resolveTemporalLicenseState,
  computePublicKeyFingerprint,
} from "@/lib/licensing/installation-auth";

describe("L8.1B Installation Auth & Crypto Primitives", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "clientix-inst-auth-test-"));
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  describe("1. Installation ID canonical format", () => {
    it("validates canonical inst_<UUIDv4> format strictly", () => {
      expect(isValidCanonicalInstallationId("inst_123e4567-e89b-42d3-a456-426614174000")).toBe(true);
      expect(isValidCanonicalInstallationId("inst_aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee")).toBe(true);
      // Non-UUID or not UUIDv4
      expect(isValidCanonicalInstallationId("inst_123e4567-e89b-12d3-a456-426614174000")).toBe(false); // UUID v1
      expect(isValidCanonicalInstallationId("inst_invalid-uuid")).toBe(false);
      expect(isValidCanonicalInstallationId("123e4567-e89b-42d3-a456-426614174000")).toBe(false);
      expect(isValidCanonicalInstallationId("")).toBe(false);
    });
  });

  describe("2. Keypair generation and validation", () => {
    it("generates valid Ed25519 PKCS8 private key and SPKI public key", () => {
      const pair = generateInstallationKeyPair();
      expect(isValidInstallationPrivateKey(pair.privateKeyPem)).toBe(true);
      expect(isValidInstallationPublicKey(pair.publicKeyPem)).toBe(true);
      expect(pair.privateKeyPem).toMatch(/^-----BEGIN [A-Z ]+-----/);
      expect(pair.publicKeyPem).toContain("-----BEGIN PUBLIC KEY-----");
    });

    it("derives public key deterministically from private key", () => {
      const pair = generateInstallationKeyPair();
      const derivedPub = deriveInstallationPublicKey(pair.privateKeyPem);
      expect(derivedPub.trim()).toBe(pair.publicKeyPem.trim());
    });
  });

  describe("3. Key persistence, reuse, and fail-closed corruption checks", () => {
    it("creates key on first run, reuses on second run with mode 0600", async () => {
      const keyFile = path.join(tempDir, "installation.key");

      // First run: creates
      const key1 = await getOrCreateInstallationPrivateKey(keyFile);
      expect(isValidInstallationPrivateKey(key1)).toBe(true);

      const stats = await fs.stat(keyFile);
      // Permissions check: on Windows mode mask behaves differently, but on POSIX it's 0600
      if (process.platform !== "win32") {
        expect(stats.mode & 0o777).toBe(0o600);
      }

      // Second run: reuses same key
      const key2 = await getOrCreateInstallationPrivateKey(keyFile);
      expect(key2).toBe(key1);
    });

    it("fails closed if key file exists but is empty", async () => {
      const keyFile = path.join(tempDir, "installation.key");
      await fs.writeFile(keyFile, "   \n");

      await expect(getOrCreateInstallationPrivateKey(keyFile)).rejects.toThrow(
        /empty or truncated/i
      );
    });

    it("fails closed if key file exists but is corrupted/malformed", async () => {
      const keyFile = path.join(tempDir, "installation.key");
      await fs.writeFile(keyFile, "not-a-valid-ed25519-key");

      await expect(getOrCreateInstallationPrivateKey(keyFile)).rejects.toThrow(
        /malformed or corrupted/i
      );
    });
  });

  describe("4. Activation code entropy and digest", () => {
    it("generates activation code with 256 bits of entropy preserving all bits", () => {
      const code1 = generateActivationCode();
      const code2 = generateActivationCode();

      expect(code1.startsWith("ACT_")).toBe(true);
      expect(code2.startsWith("ACT_")).toBe(true);
      expect(code1).not.toBe(code2);

      // ACT_ + 43 characters base64url (32 bytes = 256 bits)
      const b64part = code1.slice(4);
      expect(b64part.length).toBe(43);
    });

    it("derives HMAC-SHA256 digest using pepper and timing-safe compare", () => {
      const code = generateActivationCode();
      const pepper = "super-secret-control-plane-pepper-32-chars";

      const digest1 = deriveActivationCodeDigest(code, pepper);
      const digest2 = deriveActivationCodeDigest(code, pepper);
      const diffDigest = deriveActivationCodeDigest(code, "other-pepper");

      expect(digest1).toHaveLength(64);
      expect(digest1).toBe(digest2);
      expect(digest1).not.toBe(diffDigest);

      expect(timingSafeEqualDigests(digest1, digest2)).toBe(true);
      expect(timingSafeEqualDigests(digest1, diffDigest)).toBe(false);
      expect(timingSafeEqualDigests(digest1, "invalid_len")).toBe(false);
    });
  });

  describe("5. Canonical path and body hashing", () => {
    it("normalizes path with query sorting, stripping redundant slashes", () => {
      expect(normalizeCanonicalPath("/api//v1/installations///heartbeat/")).toBe(
        "/api/v1/installations/heartbeat"
      );
      expect(normalizeCanonicalPath("/api/v1/resource?b=2&a=1&c=3")).toBe(
        "/api/v1/resource?a=1&b=2&c=3"
      );
    });

    it("hashes raw body bytes without JSON mutation", () => {
      const rawJson = '{"b":2,"a":1}';
      const hash1 = computeRawBodySha256(rawJson);
      const hashEmpty = computeRawBodySha256(null);

      expect(hash1).toHaveLength(64);
      expect(hashEmpty).toHaveLength(64);
      expect(hash1).not.toBe(hashEmpty);
    });
  });

  describe("6. Request signature and verification matrix", () => {
    const instId = "inst_123e4567-e89b-42d3-a456-426614174000";
    const pair = generateInstallationKeyPair();
    const otherPair = generateInstallationKeyPair();
    const now = 1760000000;
    const nonce = generateRequestNonce();
    const method = "POST";
    const reqPath = "/api/v1/installations/heartbeat";
    const body = '{"status":"ok"}';

    it("verifies a completely valid request", async () => {
      const nonceStore = new MemoryNonceStore();
      const sig = createInstallationRequestSignature({
        installationId: instId,
        timestamp: now,
        nonce,
        method,
        path: reqPath,
        body,
        privateKeyPem: pair.privateKeyPem,
      });

      const res = await verifyInstallationRequestSignature({
        installationId: instId,
        timestamp: now,
        nonce,
        method,
        path: reqPath,
        body,
        signatureBase64url: sig,
        publicKeyPem: pair.publicKeyPem,
        nonceStore,
        currentTimestampUnixSeconds: now,
      });

      expect(res.ok).toBe(true);
    });

    it("fails on wrong installation_id format or mismatch", async () => {
      const sig = createInstallationRequestSignature({
        installationId: instId,
        timestamp: now,
        nonce,
        method,
        path: reqPath,
        body,
        privateKeyPem: pair.privateKeyPem,
      });

      const res = await verifyInstallationRequestSignature({
        installationId: "not-a-valid-inst-id",
        timestamp: now,
        nonce,
        method,
        path: reqPath,
        body,
        signatureBase64url: sig,
        publicKeyPem: pair.publicKeyPem,
        currentTimestampUnixSeconds: now,
      });

      expect(res.ok).toBe(false);
      expect(res.code).toBe("INVALID_INSTALLATION_ID");
    });

    it("fails when verified with wrong public key", async () => {
      const sig = createInstallationRequestSignature({
        installationId: instId,
        timestamp: now,
        nonce,
        method,
        path: reqPath,
        body,
        privateKeyPem: pair.privateKeyPem,
      });

      const res = await verifyInstallationRequestSignature({
        installationId: instId,
        timestamp: now,
        nonce,
        method,
        path: reqPath,
        body,
        signatureBase64url: sig,
        publicKeyPem: otherPair.publicKeyPem,
        currentTimestampUnixSeconds: now,
      });

      expect(res.ok).toBe(false);
      expect(res.code).toBe("INVALID_SIGNATURE");
    });

    it("fails on modified method", async () => {
      const sig = createInstallationRequestSignature({
        installationId: instId,
        timestamp: now,
        nonce,
        method: "POST",
        path: reqPath,
        body,
        privateKeyPem: pair.privateKeyPem,
      });

      const res = await verifyInstallationRequestSignature({
        installationId: instId,
        timestamp: now,
        nonce,
        method: "GET",
        path: reqPath,
        body,
        signatureBase64url: sig,
        publicKeyPem: pair.publicKeyPem,
        currentTimestampUnixSeconds: now,
      });

      expect(res.ok).toBe(false);
      expect(res.code).toBe("INVALID_SIGNATURE");
    });

    it("fails on modified path", async () => {
      const sig = createInstallationRequestSignature({
        installationId: instId,
        timestamp: now,
        nonce,
        method,
        path: reqPath,
        body,
        privateKeyPem: pair.privateKeyPem,
      });

      const res = await verifyInstallationRequestSignature({
        installationId: instId,
        timestamp: now,
        nonce,
        method,
        path: "/api/v1/installations/other",
        body,
        signatureBase64url: sig,
        publicKeyPem: pair.publicKeyPem,
        currentTimestampUnixSeconds: now,
      });

      expect(res.ok).toBe(false);
      expect(res.code).toBe("INVALID_SIGNATURE");
    });

    it("fails on modified body", async () => {
      const sig = createInstallationRequestSignature({
        installationId: instId,
        timestamp: now,
        nonce,
        method,
        path: reqPath,
        body,
        privateKeyPem: pair.privateKeyPem,
      });

      const res = await verifyInstallationRequestSignature({
        installationId: instId,
        timestamp: now,
        nonce,
        method,
        path: reqPath,
        body: '{"tampered":true}',
        signatureBase64url: sig,
        publicKeyPem: pair.publicKeyPem,
        currentTimestampUnixSeconds: now,
      });

      expect(res.ok).toBe(false);
      expect(res.code).toBe("INVALID_SIGNATURE");
    });

    it("fails on expired timestamp (past window)", async () => {
      const sig = createInstallationRequestSignature({
        installationId: instId,
        timestamp: now - 301,
        nonce,
        method,
        path: reqPath,
        body,
        privateKeyPem: pair.privateKeyPem,
      });

      const res = await verifyInstallationRequestSignature({
        installationId: instId,
        timestamp: now - 301,
        nonce,
        method,
        path: reqPath,
        body,
        signatureBase64url: sig,
        publicKeyPem: pair.publicKeyPem,
        currentTimestampUnixSeconds: now,
        allowedClockSkewSeconds: 300,
      });

      expect(res.ok).toBe(false);
      expect(res.code).toBe("INVALID_TIMESTAMP");
    });

    it("fails on future timestamp outside window", async () => {
      const sig = createInstallationRequestSignature({
        installationId: instId,
        timestamp: now + 301,
        nonce,
        method,
        path: reqPath,
        body,
        privateKeyPem: pair.privateKeyPem,
      });

      const res = await verifyInstallationRequestSignature({
        installationId: instId,
        timestamp: now + 301,
        nonce,
        method,
        path: reqPath,
        body,
        signatureBase64url: sig,
        publicKeyPem: pair.publicKeyPem,
        currentTimestampUnixSeconds: now,
        allowedClockSkewSeconds: 300,
      });

      expect(res.ok).toBe(false);
      expect(res.code).toBe("INVALID_TIMESTAMP");
    });

    it("rejects reused nonce (replay attack)", async () => {
      const nonceStore = new MemoryNonceStore();
      const sig = createInstallationRequestSignature({
        installationId: instId,
        timestamp: now,
        nonce,
        method,
        path: reqPath,
        body,
        privateKeyPem: pair.privateKeyPem,
      });

      // First call succeeds
      const res1 = await verifyInstallationRequestSignature({
        installationId: instId,
        timestamp: now,
        nonce,
        method,
        path: reqPath,
        body,
        signatureBase64url: sig,
        publicKeyPem: pair.publicKeyPem,
        nonceStore,
        currentTimestampUnixSeconds: now,
      });
      expect(res1.ok).toBe(true);

      // Replay fails
      const res2 = await verifyInstallationRequestSignature({
        installationId: instId,
        timestamp: now,
        nonce,
        method,
        path: reqPath,
        body,
        signatureBase64url: sig,
        publicKeyPem: pair.publicKeyPem,
        nonceStore,
        currentTimestampUnixSeconds: now,
      });
      expect(res2.ok).toBe(false);
      expect(res2.code).toBe("REPLAY_DETECTED");
    });
  });

  describe("7. Temporal state resolver", () => {
    it("correctly resolves temporal states without persistent admin status drift", () => {
      const validFrom = "2026-10-01T00:00:00Z";
      const expiresAt = "2026-10-10T00:00:00Z";
      const graceDays = 7;

      // 1. Before valid_from
      expect(
        resolveTemporalLicenseState({
          validFrom,
          expiresAt,
          graceDays,
          now: new Date("2026-09-30T23:59:59Z"),
        })
      ).toBe("NOT_YET_VALID");

      // 2. Exactly at valid_from
      expect(
        resolveTemporalLicenseState({
          validFrom,
          expiresAt,
          graceDays,
          now: new Date("2026-10-01T00:00:00Z"),
        })
      ).toBe("VALID");

      // 3. Before expires_at
      expect(
        resolveTemporalLicenseState({
          validFrom,
          expiresAt,
          graceDays,
          now: new Date("2026-10-09T23:59:59Z"),
        })
      ).toBe("VALID");

      // 4. Exactly at expires_at (transitions immediately into GRACE)
      expect(
        resolveTemporalLicenseState({
          validFrom,
          expiresAt,
          graceDays,
          now: new Date("2026-10-10T00:00:00Z"),
        })
      ).toBe("GRACE");

      // 5. Inside grace period
      expect(
        resolveTemporalLicenseState({
          validFrom,
          expiresAt,
          graceDays,
          now: new Date("2026-10-12T00:00:00Z"),
        })
      ).toBe("GRACE");

      // 6. 1 millisecond before grace ends (2026-10-17T00:00:00Z - 1ms)
      expect(
        resolveTemporalLicenseState({
          validFrom,
          expiresAt,
          graceDays,
          now: new Date("2026-10-16T23:59:59.999Z"),
        })
      ).toBe("GRACE");

      // 7. Exactly at grace end (transitions into EXPIRED)
      expect(
        resolveTemporalLicenseState({
          validFrom,
          expiresAt,
          graceDays,
          now: new Date("2026-10-17T00:00:00Z"),
        })
      ).toBe("EXPIRED");

      // 8. After grace period
      expect(
        resolveTemporalLicenseState({
          validFrom,
          expiresAt,
          graceDays,
          now: new Date("2026-10-17T00:00:01Z"),
        })
      ).toBe("EXPIRED");

      // 9. Perpetual license (expiresAt = null)
      expect(
        resolveTemporalLicenseState({
          validFrom,
          expiresAt: null,
          graceDays,
          now: new Date("2050-01-01T00:00:00Z"),
        })
      ).toBe("VALID");
    });
  });

  describe("8. Public key fingerprint", () => {
    it("computes 64-hex char SHA-256 fingerprint for public key", () => {
      const pair = generateInstallationKeyPair();
      const fp = computePublicKeyFingerprint(pair.publicKeyPem);
      expect(fp).toHaveLength(64);
      expect(/^[0-9a-f]{64}$/.test(fp)).toBe(true);

      // Re-computing for same key is deterministic
      const fp2 = computePublicKeyFingerprint(pair.publicKeyPem);
      expect(fp2).toBe(fp);
    });
  });
});
