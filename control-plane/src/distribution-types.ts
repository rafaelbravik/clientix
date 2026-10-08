/**
 * Clientix L8.1G — Distribution Engine Types & Contracts
 */

export type ReleaseChannel = "stable" | "candidate" | "security";
export type ReleaseStatus = "PUBLISHED" | "RETRACTED";
export type ArtifactType = "oci-image" | "oci-bundle" | "tarball" | "manifest";
export type TargetArchitecture = "amd64" | "arm64";

export interface ArtifactMetadata {
  artifactId: string;
  releaseId: string;
  architecture: TargetArchitecture;
  artifactType: ArtifactType;
  digest: `sha256:${string}`;
  sizeBytes: number;
  filename: string;
  createdAt: string;
}

export interface ReleaseMetadata {
  releaseId: string;
  version: string;
  channel: ReleaseChannel;
  status: ReleaseStatus;
  publishedAt: string;
  minSchemaVersion: string;
  maxSchemaVersion?: string;
  requiredMaintenanceDate?: string;
  artifacts: ArtifactMetadata[];
}

export interface ReleaseManifestPayload {
  manifestVersion: 1;
  version: string;
  channel: ReleaseChannel;
  publishedAt: string;
  minSchemaVersion: string;
  maxSchemaVersion?: string;
  artifacts: ArtifactMetadata[];
}

export interface SignedReleaseManifest {
  payload: ReleaseManifestPayload;
  keyId: string;
  algorithm: "Ed25519";
  purpose: "release_manifest";
  signature: string; // Base64URL
}

export interface DistributionTokenClaims {
  grantId: string;
  installationId: string;
  licenseId: string;
  releaseId: string;
  architecture: TargetArchitecture;
  allowedArtifactIds: string[];
  expiresAt: number; // Unix seconds
  createdAt: number; // Unix seconds
}

export interface DistributionGrant {
  grantId: string;
  tokenHash: string;
  claims: DistributionTokenClaims;
  remainingUses: Map<string, number>; // artifactId -> remaining downloads
}

export interface DistributionTokenRequest {
  installation_id: string;
  release_id: string;
  architecture: TargetArchitecture;
  client_schema_version?: string;
  timestamp: number;
  nonce: string;
  signatureBase64url: string;
  rawBody?: string;
}

export interface DistributionTokenResponseData {
  distribution_token: string;
  grant_id: string;
  release_id: string;
  architecture: TargetArchitecture;
  expires_in: number;
  expires_at: string;
}

export type DistributionErrorCode =
  | "DISTRIBUTION_NOT_ALLOWED"
  | "RELEASE_NOT_FOUND"
  | "RELEASE_RETRACTED"
  | "RELEASE_NOT_ENTITLED"
  | "SCHEMA_INCOMPATIBLE"
  | "MAINTENANCE_NOT_ENTITLED"
  | "ARTIFACT_NOT_FOUND"
  | "TOKEN_EXPIRED"
  | "TOKEN_INVALID"
  | "TOKEN_SCOPE_MISMATCH"
  | "ARTIFACT_DIGEST_MISMATCH"
  | "MANIFEST_SIGNATURE_INVALID"
  | "INVALID_INSTALLATION_SIGNATURE"
  | "REPLAY_DETECTED"
  | "CLOCK_SKEW_EXCEEDED"
  | "RATE_LIMITED"
  | "ARTIFACT_GRANT_EXHAUSTED"
  | "DISTRIBUTION_TEMPORARILY_UNAVAILABLE"
  | "PATH_TRAVERSAL_DETECTED"
  | "UNAUTHORIZED";

export interface DistributionServiceResult<T> {
  ok: boolean;
  status: number;
  data?: T;
  error?: {
    code: DistributionErrorCode;
    message: string;
  };
}
