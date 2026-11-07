import crypto from "crypto";
import type {
  ArtifactStorageBackend,
  ArtifactStoragePublisher,
  ArtifactStorageReader,
  StorageObjectMetadata,
} from "./artifact-storage";

export interface S3ArtifactStorageConfig {
  endpoint: string; // e.g. "https://<account_id>.r2.cloudflarestorage.com" or "https://s3.us-east-1.amazonaws.com"
  region?: string; // defaults to "auto"
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken?: string;
  forcePathStyle?: boolean; // defaults to true
  fetchFn?: typeof fetch; // injectable fetch for staging/unit test certification
}

export type S3GatewayCredentials = Pick<
  S3ArtifactStorageConfig,
  | "endpoint"
  | "region"
  | "bucket"
  | "accessKeyId"
  | "secretAccessKey"
  | "sessionToken"
  | "forcePathStyle"
  | "fetchFn"
>;

export type S3PublisherCredentials = S3ArtifactStorageConfig;

/**
 * AWS Signature Version 4 (SigV4) Signer
 * Native implementation using Node.js crypto and standard Fetch API.
 * Compatible with AWS S3, Cloudflare R2, MinIO, Wasabi, and Ceph.
 */
export function signS3Request(params: {
  method: string;
  url: URL;
  headers: Record<string, string>;
  body?: Buffer;
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken?: string;
  region: string;
  service?: string;
  timestamp?: Date;
}): Record<string, string> {
  const {
    method,
    url,
    headers,
    body,
    accessKeyId,
    secretAccessKey,
    sessionToken,
    region,
    service = "s3",
    timestamp = new Date(),
  } = params;

  const amzDate = timestamp.toISOString().replace(/[:-]|\.\d{3}/g, "");
  const dateStamp = amzDate.slice(0, 8);

  const payloadHash = body
    ? crypto.createHash("sha256").update(body).digest("hex")
    : "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"; // Empty string SHA256

  const signedHeadersMap: Record<string, string> = {
    ...headers,
    host: url.host,
    "x-amz-date": amzDate,
    "x-amz-content-sha256": payloadHash,
  };

  if (sessionToken) {
    signedHeadersMap["x-amz-security-token"] = sessionToken;
  }

  // Canonicalize headers
  const sortedHeaderKeys = Object.keys(signedHeadersMap)
    .map((k) => k.toLowerCase())
    .sort();

  const canonicalHeaders = sortedHeaderKeys
    .map((k) => `${k}:${signedHeadersMap[k]!.trim().replace(/ +/g, " ")}\n`)
    .join("");

  const signedHeadersString = sortedHeaderKeys.join(";");

  // Canonical URI (URI-encode each segment without double-encoding slashes)
  const canonicalUri = url.pathname
    .split("/")
    .map((segment) => encodeURIComponent(decodeURIComponent(segment)))
    .join("/");

  // Canonical Query String
  const searchParams = new URLSearchParams(url.search);
  const sortedParams = Array.from(searchParams.entries()).sort(([a], [b]) => a.localeCompare(b));
  const canonicalQueryString = sortedParams
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
    .join("&");

  // Canonical Request
  const canonicalRequest = [
    method,
    canonicalUri || "/",
    canonicalQueryString,
    canonicalHeaders,
    signedHeadersString,
    payloadHash,
  ].join("\n");

  const credentialScope = `${dateStamp}/${region}/${service}/aws4_request`;
  const hashedCanonicalRequest = crypto
    .createHash("sha256")
    .update(canonicalRequest, "utf-8")
    .digest("hex");

  const stringToSign = ["AWS4-HMAC-SHA256", amzDate, credentialScope, hashedCanonicalRequest].join(
    "\n",
  );

  // Derive signing key
  const kDate = crypto
    .createHmac("sha256", `AWS4${secretAccessKey}`)
    .update(dateStamp, "utf-8")
    .digest();
  const kRegion = crypto.createHmac("sha256", kDate).update(region, "utf-8").digest();
  const kService = crypto.createHmac("sha256", kRegion).update(service, "utf-8").digest();
  const kSigning = crypto.createHmac("sha256", kService).update("aws4_request", "utf-8").digest();

  const signature = crypto
    .createHmac("sha256", kSigning)
    .update(stringToSign, "utf-8")
    .digest("hex");

  const authorizationHeader = `AWS4-HMAC-SHA256 Credential=${accessKeyId}/${credentialScope}, SignedHeaders=${signedHeadersString}, Signature=${signature}`;

  return {
    ...signedHeadersMap,
    authorization: authorizationHeader,
  };
}

/**
 * Builds the canonical S3 object URL given bucket and key.
 */
function buildS3Url(
  endpoint: string,
  bucket: string,
  key: string,
  forcePathStyle: boolean = true,
): URL {
  const cleanKey = key.replace(/^\/+/, "");
  const base = endpoint.replace(/\/+$/, "");

  if (forcePathStyle) {
    return new URL(`${base}/${bucket}/${cleanKey}`);
  }

  // Virtual-hosted style
  const endpointUrl = new URL(base);
  return new URL(`${endpointUrl.protocol}//${bucket}.${endpointUrl.host}/${cleanKey}`);
}

/**
 * S3ArtifactStorageReader
 *
 * Strictly Read-Only S3 adapter. Possesses ZERO mutation or deletion methods.
 * Satisfies the Principle of Least Privilege for the production Artifact Gateway.
 */
export class S3ArtifactStorageReader implements ArtifactStorageReader {
  protected readonly config: S3ArtifactStorageConfig;
  protected readonly fetcher: typeof fetch;
  protected readonly region: string;

  constructor(config: S3GatewayCredentials) {
    if (!config.endpoint || !config.bucket) {
      throw new Error("S3ArtifactStorageReader requires valid endpoint and bucket configuration.");
    }
    this.config = {
      ...config,
      region: config.region ?? "auto",
      forcePathStyle: config.forcePathStyle ?? true,
    };
    this.region = this.config.region!;
    this.fetcher = config.fetchFn ?? globalThis.fetch.bind(globalThis);
  }

  async getObjectMetadata(key: string): Promise<StorageObjectMetadata | null> {
    const url = buildS3Url(
      this.config.endpoint,
      this.config.bucket,
      key,
      this.config.forcePathStyle,
    );
    const headers = signS3Request({
      method: "HEAD",
      url,
      headers: {},
      accessKeyId: this.config.accessKeyId,
      secretAccessKey: this.config.secretAccessKey,
      sessionToken: this.config.sessionToken,
      region: this.region,
    });

    try {
      const res = await this.fetcher(url.toString(), { method: "HEAD", headers });
      if (res.status === 404) {
        return null;
      }
      if (!res.ok) {
        throw new Error(`S3 HEAD failed: HTTP ${res.status} ${res.statusText}`);
      }

      const contentLength = res.headers.get("content-length");
      const sizeBytes = contentLength ? parseInt(contentLength, 10) : 0;
      const contentType = res.headers.get("content-type") ?? undefined;
      const lastModifiedStr = res.headers.get("last-modified");
      const lastModified = lastModifiedStr ? new Date(lastModifiedStr) : new Date();

      // Look for custom sha256 metadata header
      const metaDigest = res.headers.get("x-amz-meta-sha256");
      let digest: `sha256:${string}`;
      if (metaDigest) {
        digest = metaDigest.startsWith("sha256:")
          ? (metaDigest as `sha256:${string}`)
          : `sha256:${metaDigest}`;
      } else {
        // Fallback: extract from key if key follows content-addressed pattern releases/.../.../<sha256>
        const parts = key.split("/");
        const lastPart = parts[parts.length - 1] ?? "";
        if (/^[a-f0-9]{64}$/i.test(lastPart)) {
          digest = `sha256:${lastPart.toLowerCase()}`;
        } else {
          // If metadata is not in header or key, read stream to compute
          const stream = await this.getObjectStream(key);
          if (!stream) return null;
          digest = `sha256:${crypto.createHash("sha256").update(stream).digest("hex")}`;
        }
      }

      return {
        key,
        sizeBytes,
        digest,
        contentType,
        lastModified,
      };
    } catch (err: unknown) {
      if (
        (err as Error).message?.includes("ECONNREFUSED") ||
        (err as Error).message?.includes("fetch failed")
      ) {
        throw new Error(
          `STORAGE_UNREACHABLE: S3 endpoint is unavailable (${this.config.endpoint})`,
        );
      }
      throw err;
    }
  }

  async getObjectStream(key: string): Promise<Buffer | null> {
    const url = buildS3Url(
      this.config.endpoint,
      this.config.bucket,
      key,
      this.config.forcePathStyle,
    );
    const headers = signS3Request({
      method: "GET",
      url,
      headers: {},
      accessKeyId: this.config.accessKeyId,
      secretAccessKey: this.config.secretAccessKey,
      sessionToken: this.config.sessionToken,
      region: this.region,
    });

    try {
      const res = await this.fetcher(url.toString(), { method: "GET", headers });
      if (res.status === 404) {
        return null;
      }
      if (!res.ok) {
        throw new Error(`S3 GET failed: HTTP ${res.status} ${res.statusText}`);
      }

      const arrayBuffer = await res.arrayBuffer();
      return Buffer.from(arrayBuffer);
    } catch (err: unknown) {
      if (
        (err as Error).message?.includes("ECONNREFUSED") ||
        (err as Error).message?.includes("fetch failed")
      ) {
        throw new Error(
          `STORAGE_UNREACHABLE: S3 endpoint is unavailable (${this.config.endpoint})`,
        );
      }
      throw err;
    }
  }

  async objectExists(key: string): Promise<boolean> {
    const meta = await this.getObjectMetadata(key);
    return meta !== null;
  }
}

/**
 * S3ArtifactStoragePublisher
 *
 * Implements write/publish capabilities for the release pipeline.
 * Enforces strict immutability: overwriting existing content-addressed keys with differing bytes is strictly DENIED.
 */
export class S3ArtifactStoragePublisher implements ArtifactStoragePublisher {
  protected readonly config: S3ArtifactStorageConfig;
  protected readonly fetcher: typeof fetch;
  protected readonly region: string;
  protected readonly reader: S3ArtifactStorageReader;

  constructor(config: S3PublisherCredentials) {
    this.config = {
      ...config,
      region: config.region ?? "auto",
      forcePathStyle: config.forcePathStyle ?? true,
    };
    this.region = this.config.region!;
    this.fetcher = config.fetchFn ?? globalThis.fetch.bind(globalThis);
    this.reader = new S3ArtifactStorageReader(config);
  }

  async putObject(key: string, data: Buffer, contentType?: string): Promise<StorageObjectMetadata> {
    const newDigestHex = crypto.createHash("sha256").update(data).digest("hex");
    const newDigest = `sha256:${newDigestHex}` as `sha256:${string}`;

    // 1. Strict Immutability Guard: Check if key already exists in S3
    const existing = await this.reader.getObjectMetadata(key);
    if (existing) {
      if (existing.digest === newDigest) {
        // Idempotent write
        return existing;
      }
      throw new Error(
        `IMMUTABLE_OBJECT_CONFLICT: Object already exists at key "${key}" with digest ${existing.digest}, cannot overwrite with different digest ${newDigest}.`,
      );
    }

    // 2. Perform authenticated PUT to S3
    const url = buildS3Url(
      this.config.endpoint,
      this.config.bucket,
      key,
      this.config.forcePathStyle,
    );
    const ct = contentType ?? "application/octet-stream";
    const headers = signS3Request({
      method: "PUT",
      url,
      headers: {
        "content-type": ct,
        "x-amz-meta-sha256": newDigestHex,
      },
      body: data,
      accessKeyId: this.config.accessKeyId,
      secretAccessKey: this.config.secretAccessKey,
      sessionToken: this.config.sessionToken,
      region: this.region,
    });

    const res = await this.fetcher(url.toString(), {
      method: "PUT",
      headers,
      body: new Uint8Array(data),
    });

    if (res.status === 403) {
      throw new Error("S3_ACCESS_DENIED: Credential does not have PutObject permissions.");
    }

    if (!res.ok) {
      throw new Error(`S3 PUT failed: HTTP ${res.status} ${res.statusText}`);
    }

    return {
      key,
      sizeBytes: data.length,
      digest: newDigest,
      contentType: ct,
      lastModified: new Date(),
    };
  }

  async deleteObject(key: string): Promise<boolean> {
    const url = buildS3Url(
      this.config.endpoint,
      this.config.bucket,
      key,
      this.config.forcePathStyle,
    );
    const headers = signS3Request({
      method: "DELETE",
      url,
      headers: {},
      accessKeyId: this.config.accessKeyId,
      secretAccessKey: this.config.secretAccessKey,
      sessionToken: this.config.sessionToken,
      region: this.region,
    });

    const res = await this.fetcher(url.toString(), {
      method: "DELETE",
      headers,
    });

    if (res.status === 403) {
      throw new Error("S3_ACCESS_DENIED: Credential does not have DeleteObject permissions.");
    }

    return res.ok || res.status === 204;
  }
}

/**
 * S3ArtifactStorageBackend
 *
 * Full S3 backend combining reader and publisher for complete backend abstraction.
 */
export class S3ArtifactStorageBackend
  extends S3ArtifactStorageReader
  implements ArtifactStorageBackend
{
  private readonly publisher: S3ArtifactStoragePublisher;

  constructor(config: S3ArtifactStorageConfig) {
    super(config);
    this.publisher = new S3ArtifactStoragePublisher(config);
  }

  async putObject(key: string, data: Buffer, contentType?: string): Promise<StorageObjectMetadata> {
    return this.publisher.putObject(key, data, contentType);
  }

  async deleteObject(key: string): Promise<boolean> {
    return this.publisher.deleteObject(key);
  }
}
