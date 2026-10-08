import crypto from "crypto";
import type { SignedReleaseManifest, TargetArchitecture } from "./distribution-types";
import { verifyReleaseManifest } from "./manifest-signer";

export interface OfflineBundlePayload {
  manifest: SignedReleaseManifest;
  artifacts: Record<string, Buffer>; // filename or artifactId -> binary Buffer
}

export type OfflineVerificationErrorCode =
  | "MANIFEST_SIGNATURE_INVALID"
  | "ARCHITECTURE_UNSUPPORTED"
  | "SCHEMA_INCOMPATIBLE"
  | "ARTIFACT_MISSING"
  | "ARTIFACT_DIGEST_MISMATCH"
  | "SOURCE_CODE_DETECTED";

export interface OfflineVerificationResult {
  valid: boolean;
  code?: OfflineVerificationErrorCode;
  reason?: string;
}

export function verifyOfflineBundle(params: {
  bundle: OfflineBundlePayload;
  trustedManifestKeys: Record<string, string>;
  targetArchitecture: TargetArchitecture;
  clientSchemaVersion?: string;
}): OfflineVerificationResult {
  const { bundle, trustedManifestKeys, targetArchitecture, clientSchemaVersion } = params;

  // 1. Verify Manifest Signature
  const manifestVerif = verifyReleaseManifest(bundle.manifest, trustedManifestKeys);
  if (!manifestVerif.valid) {
    return {
      valid: false,
      code: "MANIFEST_SIGNATURE_INVALID",
      reason: manifestVerif.reason,
    };
  }

  const payload = bundle.manifest.payload;

  // 2. Schema Compatibility Check
  if (clientSchemaVersion) {
    const clientVer = parseInt(clientSchemaVersion, 10);
    const minVer = parseInt(payload.minSchemaVersion, 10);
    if (!isNaN(clientVer) && !isNaN(minVer) && clientVer < minVer) {
      return {
        valid: false,
        code: "SCHEMA_INCOMPATIBLE",
        reason: `Client schema ${clientSchemaVersion} is below minimum ${payload.minSchemaVersion}`,
      };
    }
    if (payload.maxSchemaVersion) {
      const maxVer = parseInt(payload.maxSchemaVersion, 10);
      if (!isNaN(clientVer) && !isNaN(maxVer) && clientVer > maxVer) {
        return {
          valid: false,
          code: "SCHEMA_INCOMPATIBLE",
          reason: `Client schema ${clientSchemaVersion} exceeds maximum ${payload.maxSchemaVersion}`,
        };
      }
    }
  }

  // 3. Filter artifacts for target architecture
  const expectedArtifacts = payload.artifacts.filter((a) => a.architecture === targetArchitecture);
  if (expectedArtifacts.length === 0) {
    return {
      valid: false,
      code: "ARCHITECTURE_UNSUPPORTED",
      reason: `No artifacts in manifest for architecture "${targetArchitecture}"`,
    };
  }

  // 4. Verify artifact digest byte-by-byte & verify absence of source code
  for (const art of expectedArtifacts) {
    const rawBuffer = bundle.artifacts[art.filename] || bundle.artifacts[art.artifactId];
    if (!rawBuffer) {
      return {
        valid: false,
        code: "ARTIFACT_MISSING",
        reason: `Artifact file "${art.filename}" missing from bundle`,
      };
    }

    // SHA-256 Digest match
    const computedDigest = `sha256:${crypto.createHash("sha256").update(rawBuffer).digest("hex")}`;
    if (computedDigest !== art.digest) {
      return {
        valid: false,
        code: "ARTIFACT_DIGEST_MISMATCH",
        reason: `Digest mismatch for artifact "${art.filename}". Expected ${art.digest}, got ${computedDigest}`,
      };
    }

    // Source code leakage scan: Ensure bundle is compiled container/archive, not source repo
    const bufferStr = rawBuffer.subarray(0, 4096).toString("utf-8");
    if (bufferStr.includes("import React") || bufferStr.includes(".git/HEAD") || bufferStr.includes("export default function")) {
      return {
        valid: false,
        code: "SOURCE_CODE_DETECTED",
        reason: "Source code files detected in bundle payload. Distribution denied.",
      };
    }
  }

  return { valid: true };
}
