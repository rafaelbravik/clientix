import crypto from "node:crypto";
import path from "node:path";

import {
  createInstallationRequestSignature,
  computePublicKeyFingerprint,
  commitPendingInstallationPrivateKey,
  deriveInstallationPublicKey,
  getOrCreatePendingInstallationKeyPair,
  getOrCreateInstallationPrivateKey,
  DEFAULT_INSTALLATION_KEY_PATH,
  generateRequestNonce,
} from "./installation-auth";
import {
  getInstanceSession,
  rotateInstanceSessionAfterRecovery,
  rotateInstanceSessionAfterServerTermination,
  type InstanceSession,
} from "./instance-session";
import {
  DEFAULT_INSTALLATION_ID_PATH,
  DEFAULT_LICENSE_PATH,
  getInstallationLicenseStatus,
  installLicenseFile,
} from "./enforcement";
import {
  defaultOnlineValidationCachePath,
  verifyAttestationChallenge,
  verifyInstallationRecoveryResponse,
  verifyLicenseServerResponse,
  writeOnlineValidationCache,
  type SignedLicenseServerResponse,
} from "./online-cache";

export interface LicenseServerClientResult {
  response: SignedLicenseServerResponse;
  status: Awaited<ReturnType<typeof getInstallationLicenseStatus>>;
}

export class LicenseServerClientError extends Error {
  constructor(
    readonly code:
      | "NOT_CONFIGURED"
      | "UNAVAILABLE"
      | "REJECTED"
      | "INVALID_RESPONSE"
      | "SESSION_ENDED",
  ) {
    super(
      code === "NOT_CONFIGURED"
        ? "O License Server ainda não está configurado nesta instalação."
        : code === "UNAVAILABLE"
          ? "O License Server está indisponível; a licença local continua sujeita à tolerância offline."
          : code === "REJECTED"
            ? "O License Server não autorizou esta operação."
            : code === "SESSION_ENDED"
              ? "A sessão desta instalação foi encerrada pelo License Server."
              : "A resposta do License Server foi recusada por não passar na verificação criptográfica.",
    );
    this.name = "LicenseServerClientError";
  }
}

export function resolveLicenseServerUrl(raw = process.env.CLIENTIX_LICENSE_SERVER_URL ?? ""): URL {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    throw new LicenseServerClientError("NOT_CONFIGURED");
  }
  const hostname = url.hostname.toLowerCase();
  const isLocalhost = ["localhost", "127.0.0.1", "::1", "[::1]"].includes(hostname);
  const isLocalVendorService = process.env.DESKCOMM_ENV_MODE === "local" && hostname === "vendor";
  if (
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    (url.protocol !== "https:" &&
      !(url.protocol === "http:" && (isLocalVendorService || (process.env.NODE_ENV !== "production" && isLocalhost))))
  ) {
    throw new LicenseServerClientError("NOT_CONFIGURED");
  }
  url.pathname = `${url.pathname.replace(/\/+$/, "")}/`;
  return url;
}

export async function activate(params: {
  activationCode: string;
}): Promise<LicenseServerClientResult> {
  if (!params.activationCode.trim()) throw new LicenseServerClientError("REJECTED");
  const installationId = await getInstallationId();
  const privateKeyPem = await getInstallationPrivateKey();
  const publicKeyPem = deriveInstallationPublicKey(privateKeyPem);
  const timestamp = Math.floor(Date.now() / 1000);
  const nonce = generateRequestNonce();
  const body = JSON.stringify({
    installation_id: installationId,
    installation_public_key: publicKeyPem,
    activation_code: params.activationCode.trim(),
    timestamp,
    nonce,
    clientix_version: getClientixVersion(),
  });

  const response = await post("api/v1/licensing/activate", body);
  await acceptResponse(response, installationId, nonce, "activation");
  return onlineValidate();
}

export async function onlineValidate(): Promise<LicenseServerClientResult> {
  return onlineValidateWithSessionRecovery();
}

async function onlineValidateWithSessionRecovery(
  retryAfterSessionEnd = false,
): Promise<LicenseServerClientResult> {
  const session = getInstanceSession();
  try {
    return await onlineValidateAttempt(session);
  } catch (error) {
    if (
      retryAfterSessionEnd ||
      !(error instanceof LicenseServerClientError) ||
      error.code !== "SESSION_ENDED"
    ) {
      throw error;
    }
    rotateInstanceSessionAfterServerTermination(session.instance_session_id);
    return onlineValidateWithSessionRecovery(true);
  }
}

async function onlineValidateAttempt(session: InstanceSession): Promise<LicenseServerClientResult> {
  const installationId = await getInstallationId();
  const privateKeyPem = await getInstallationPrivateKey();
  const localStatus = await getInstallationLicenseStatus();
  if (!localStatus.license_id) throw new LicenseServerClientError("REJECTED");
  const clientixVersion = getClientixVersion();
  const challengeTimestamp = Math.floor(Date.now() / 1000);
  const challengeRequestNonce = generateRequestNonce();
  const challengeBody = JSON.stringify({
    installation_id: installationId,
    license_id: localStatus.license_id,
    instance_session_id: session.instance_session_id,
    boot_started_at: session.boot_started_at,
    clientix_version: clientixVersion,
    timestamp: challengeTimestamp,
    nonce: challengeRequestNonce,
  });
  const challengeSignature = createInstallationRequestSignature({
    installationId,
    timestamp: challengeTimestamp,
    nonce: challengeRequestNonce,
    method: "POST",
    path: "/api/v1/licensing/challenge",
    body: challengeBody,
    privateKeyPem,
  });
  const challengeResponse = await post("api/v1/licensing/challenge", challengeBody, {
    "X-Installation-Signature": challengeSignature,
  });
  const challengeCandidate = await readResponseBody(challengeResponse);
  const challengeVerified = verifyAttestationChallenge(challengeCandidate, {
    expectedInstallationId: installationId,
    expectedLicenseId: localStatus.license_id,
    expectedSessionId: session.instance_session_id,
    expectedNonce: challengeRequestNonce,
  });
  if (!challengeVerified.valid) throw new LicenseServerClientError("INVALID_RESPONSE");

  const timestamp = Math.floor(Date.now() / 1000);
  const nonce = generateRequestNonce();
  const body = JSON.stringify({
    installation_id: installationId,
    license_id: localStatus.license_id,
    instance_session_id: session.instance_session_id,
    boot_started_at: session.boot_started_at,
    clientix_version: clientixVersion,
    local_license_status: localStatus.commercial_status,
    challenge: challengeVerified.challenge.payload.challenge,
    timestamp,
    nonce,
  });
  const signature = createInstallationRequestSignature({
    installationId,
    timestamp,
    nonce,
    method: "POST",
    path: "/api/v1/licensing/validate-attestation",
    body,
    privateKeyPem,
  });
  const response = await post("api/v1/licensing/validate-attestation", body, {
    "X-Installation-Signature": signature,
  });
  return acceptResponse(response, installationId, nonce, "validation");
}

/** Sends low-frequency boot-session heartbeats; never called from request handlers. */
export function startLicenseHeartbeat(): () => void {
  const intervalSeconds = Number(process.env.CLIENTIX_LICENSE_HEARTBEAT_INTERVAL_SECONDS ?? "300");
  const intervalMs =
    Number.isInteger(intervalSeconds) && intervalSeconds >= 60 && intervalSeconds <= 3600
      ? intervalSeconds * 1000
      : 300_000;
  let stopped = false;
  const heartbeat = async () => {
    if (stopped) return;
    try {
      const state = await getInstallationLicenseStatus();
      if (state.license_id && process.env.CLIENTIX_LICENSE_SERVER_URL) await onlineValidate();
    } catch {
      // Offline tolerance remains authoritative; absence of a heartbeat is not a clone signal.
    }
  };
  void heartbeat();
  const timer = setInterval(() => void heartbeat(), intervalMs);
  timer.unref?.();
  return () => {
    stopped = true;
    clearInterval(timer);
  };
}

async function readResponseBody(response: Response): Promise<unknown> {
  let candidate: unknown;
  try {
    candidate = await response.json();
  } catch {
    throw new LicenseServerClientError("INVALID_RESPONSE");
  }
  return typeof candidate === "object" && candidate !== null && "data" in candidate
    ? (candidate as { data: unknown }).data
    : candidate;
}

/** Fetches the current signed document from the License Server and atomically refreshes local state. */
export async function refreshLicense(): Promise<LicenseServerClientResult> {
  return onlineValidate();
}

/** Rotates the local identity only after a vendor-authorized server response is verified. */
export async function recoverInstallationIdentity(params: {
  recoveryCode: string;
}): Promise<LicenseServerClientResult> {
  if (!/^REC_[A-Za-z0-9_-]{40,48}$/.test(params.recoveryCode))
    throw new LicenseServerClientError("REJECTED");
  const installationId = await getInstallationId();
  const keyPath = getInstallationPrivateKeyPath();
  const candidate = await getOrCreatePendingInstallationKeyPair(keyPath);
  const fingerprint = computePublicKeyFingerprint(candidate.publicKeyPem);
  const timestamp = Math.floor(Date.now() / 1000);
  const nonce = generateRequestNonce();
  const body = JSON.stringify({
    installation_id: installationId,
    installation_public_key: candidate.publicKeyPem,
    recovery_code: params.recoveryCode,
    timestamp,
    nonce,
  });
  const signature = createInstallationRequestSignature({
    installationId,
    timestamp,
    nonce,
    method: "POST",
    path: "/api/v1/licensing/recover-installation",
    body,
    privateKeyPem: candidate.privateKeyPem,
  });
  const response = await post("api/v1/licensing/recover-installation", body, {
    "X-Installation-Signature": signature,
  });
  const signedRecovery = await readResponseBody(response);
  if (
    !verifyInstallationRecoveryResponse(signedRecovery, {
      installationId,
      requestNonce: nonce,
      publicKeyFingerprint: fingerprint,
    })
  )
    throw new LicenseServerClientError("INVALID_RESPONSE");

  await commitPendingInstallationPrivateKey(keyPath);
  rotateInstanceSessionAfterRecovery();
  return onlineValidate();
}

async function post(
  pathname: string,
  body: string,
  headers: Record<string, string> = {},
): Promise<Response> {
  const url = resolveLicenseServerUrl(process.env.CLIENTIX_LICENSE_SERVER_URL);
  url.pathname = `${url.pathname.replace(/\/+$/, "")}/${pathname.replace(/^\/+/, "")}`;
  let response: Response;
  try {
    response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...headers },
      body,
      cache: "no-store",
      redirect: "error",
      signal: AbortSignal.timeout(8_000),
    });
  } catch {
    throw new LicenseServerClientError("UNAVAILABLE");
  }
  if (response.status === 429 || response.status >= 500) {
    throw new LicenseServerClientError("UNAVAILABLE");
  }
  if (!response.ok) {
    if (
      pathname === "api/v1/licensing/validate-attestation" &&
      response.status === 409 &&
      (await readApiErrorCode(response)) === "installation_session_ended"
    ) {
      throw new LicenseServerClientError("SESSION_ENDED");
    }
    throw new LicenseServerClientError("REJECTED");
  }
  return response;
}

async function readApiErrorCode(response: Response): Promise<string | null> {
  try {
    const body = (await response.clone().json()) as {
      error?: { code?: unknown };
    };
    return typeof body.error?.code === "string" ? body.error.code : null;
  } catch {
    return null;
  }
}

async function acceptResponse(
  httpResponse: Response,
  installationId: string,
  nonce: string,
  expectedType: "activation" | "validation",
): Promise<LicenseServerClientResult> {
  const candidate = await readResponseBody(httpResponse);
  const verified = verifyLicenseServerResponse(candidate, {
    expectedInstallationId: installationId,
    expectedNonce: nonce,
  });
  if (!verified.valid || verified.response.payload.response_type !== expectedType) {
    throw new LicenseServerClientError("INVALID_RESPONSE");
  }

  const response = verified.response;
  const now = new Date();
  const cachePath = defaultOnlineValidationCachePath(DEFAULT_LICENSE_PATH);
  await writeOnlineValidationCache(response, cachePath, response.payload.server_time);
  await installLicenseFile(response.payload.signed_license, {
    installationIdPath: DEFAULT_INSTALLATION_ID_PATH,
    targetPath: DEFAULT_LICENSE_PATH,
    allowSignedRestriction: true,
  });
  const status = await getInstallationLicenseStatus({ now });
  return { response, status };
}

async function getInstallationId(): Promise<string> {
  const status = await getInstallationLicenseStatus({
    installationIdPath: DEFAULT_INSTALLATION_ID_PATH,
  });
  const installationId = status.installation_id_expected;
  if (!installationId) throw new LicenseServerClientError("INVALID_RESPONSE");
  return installationId;
}

async function getInstallationPrivateKey(): Promise<string> {
  const keyPath = getInstallationPrivateKeyPath();
  try {
    return await getOrCreateInstallationPrivateKey(keyPath);
  } catch {
    throw new LicenseServerClientError("UNAVAILABLE");
  }
}

function getInstallationPrivateKeyPath(): string {
  return (
    process.env.CLIENTIX_INSTALLATION_KEY_PATH?.trim() ||
    (process.env.NODE_ENV === "production"
      ? DEFAULT_INSTALLATION_KEY_PATH
      : path.join(path.dirname(DEFAULT_INSTALLATION_ID_PATH), "installation.key"))
  );
}

function getClientixVersion(): string {
  const value = process.env.CLIENTIX_VERSION || process.env.npm_package_version || "unknown";
  return value.slice(0, 80);
}

export function getLicenseServerRequestIdempotencyKey(seed = crypto.randomUUID()): string {
  return seed;
}
