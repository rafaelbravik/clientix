import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  session: {
    instance_session_id: "sess_00000000-0000-4000-8000-000000000001",
    boot_started_at: "2026-11-10T12:00:00.000Z",
  },
  getInstanceSession: vi.fn(),
  rotateAfterServerTermination: vi.fn(),
  getInstallationLicenseStatus: vi.fn(),
  installLicenseFile: vi.fn(),
  createInstallationRequestSignature: vi.fn(),
  verifyAttestationChallenge: vi.fn(),
  verifyLicenseServerResponse: vi.fn(),
  writeOnlineValidationCache: vi.fn(),
}));

vi.mock("./installation-auth", () => ({
  createInstallationRequestSignature: mocks.createInstallationRequestSignature,
  computePublicKeyFingerprint: vi.fn(),
  commitPendingInstallationPrivateKey: vi.fn(),
  deriveInstallationPublicKey: vi.fn(),
  getOrCreatePendingInstallationKeyPair: vi.fn(),
  getOrCreateInstallationPrivateKey: vi.fn(),
  DEFAULT_INSTALLATION_KEY_PATH: "/opt/clientix/licenses/installation.key",
  generateRequestNonce: vi.fn(() => "test-nonce-0123456789abcdef"),
}));

vi.mock("./instance-session", () => ({
  getInstanceSession: mocks.getInstanceSession,
  rotateInstanceSessionAfterRecovery: vi.fn(),
  rotateInstanceSessionAfterServerTermination: mocks.rotateAfterServerTermination,
}));

vi.mock("./enforcement", () => ({
  DEFAULT_INSTALLATION_ID_PATH: "/opt/clientix/state/installation_id",
  DEFAULT_LICENSE_PATH: "/opt/clientix/licenses/license.json",
  getInstallationLicenseStatus: mocks.getInstallationLicenseStatus,
  installLicenseFile: mocks.installLicenseFile,
}));

vi.mock("./online-cache", () => ({
  defaultOnlineValidationCachePath: vi.fn(() => "/tmp/license-validation.json"),
  verifyAttestationChallenge: mocks.verifyAttestationChallenge,
  verifyInstallationRecoveryResponse: vi.fn(),
  verifyLicenseServerResponse: mocks.verifyLicenseServerResponse,
  writeOnlineValidationCache: mocks.writeOnlineValidationCache,
}));

import { LicenseServerClientError, onlineValidate } from "./license-server-client";

const OLD_SESSION_ID = "sess_00000000-0000-4000-8000-000000000001";
const NEW_SESSION_ID = "sess_00000000-0000-4000-8000-000000000002";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("license validation session recovery", () => {
  let requests: Array<{ url: string; body: Record<string, unknown> }>;
  let responses: Response[];

  beforeEach(() => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("DESKCOMM_ENV_MODE", "local");
    vi.stubEnv("CLIENTIX_LICENSE_SERVER_URL", "http://vendor:3000");
    vi.stubEnv("CLIENTIX_VERSION", "reactivation-test");

    mocks.session = {
      instance_session_id: OLD_SESSION_ID,
      boot_started_at: "2026-11-10T12:00:00.000Z",
    };
    mocks.getInstanceSession.mockImplementation(() => mocks.session);
    mocks.rotateAfterServerTermination.mockImplementation((endedSessionId: string) => {
      if (mocks.session.instance_session_id === endedSessionId) {
        mocks.session = {
          instance_session_id: NEW_SESSION_ID,
          boot_started_at: "2026-11-10T12:01:00.000Z",
        };
      }
      return mocks.session;
    });
    mocks.getInstallationLicenseStatus.mockResolvedValue({
      license_id: "license-synthetic",
      commercial_status: "SUSPENDED",
      installation_id_expected: "inst_11111111-1111-4111-8111-111111111111",
    });
    mocks.installLicenseFile.mockResolvedValue({ success: true });
    mocks.createInstallationRequestSignature.mockReturnValue("synthetic-installation-signature");
    mocks.verifyAttestationChallenge.mockImplementation((_candidate, options) => ({
      valid: true,
      challenge: {
        payload: {
          challenge: `challenge-for-${options.expectedSessionId}`,
        },
      },
    }));
    mocks.verifyLicenseServerResponse.mockReturnValue({
      valid: true,
      response: {
        payload: {
          response_type: "validation",
          server_time: "2026-11-10T12:01:00.000Z",
          signed_license: { synthetic: true },
        },
      },
    });
    mocks.writeOnlineValidationCache.mockResolvedValue(undefined);

    requests = [];
    responses = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        requests.push({
          url: String(input),
          body: JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>,
        });
        const response = responses.shift();
        if (!response) throw new Error("Unexpected License Server request.");
        return response;
      }),
    );
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  it("creates one fresh authenticated session after the server confirms the old one ended", async () => {
    responses = [
      jsonResponse({ data: { signed_challenge: true } }),
      jsonResponse({ error: { code: "installation_session_ended" } }, 409),
      jsonResponse({ data: { signed_challenge: true } }),
      jsonResponse({ data: { signed_validation: true } }),
    ];

    const result = await onlineValidate();

    expect(result.response.payload.response_type).toBe("validation");
    expect(mocks.rotateAfterServerTermination).toHaveBeenCalledTimes(1);
    expect(mocks.rotateAfterServerTermination).toHaveBeenCalledWith(OLD_SESSION_ID);
    expect(requests).toHaveLength(4);
    expect(requests[0]?.body.instance_session_id).toBe(OLD_SESSION_ID);
    expect(requests[1]?.body.instance_session_id).toBe(OLD_SESSION_ID);
    expect(requests[2]?.body.instance_session_id).toBe(NEW_SESSION_ID);
    expect(requests[3]?.body.instance_session_id).toBe(NEW_SESSION_ID);
    expect(requests[3]?.body.challenge).toBe(`challenge-for-${NEW_SESSION_ID}`);
    expect(mocks.installLicenseFile).toHaveBeenCalledTimes(1);
  });

  it("does not rotate on generic authorization or replay failures", async () => {
    responses = [
      jsonResponse({ data: { signed_challenge: true } }),
      jsonResponse({ error: { code: "unauthorized" } }, 401),
    ];

    await expect(onlineValidate()).rejects.toMatchObject({ code: "REJECTED" });
    expect(mocks.rotateAfterServerTermination).not.toHaveBeenCalled();
    expect(requests).toHaveLength(2);
  });

  it("does not loop if a newly created session is also rejected as ended", async () => {
    responses = [
      jsonResponse({ data: { signed_challenge: true } }),
      jsonResponse({ error: { code: "installation_session_ended" } }, 409),
      jsonResponse({ data: { signed_challenge: true } }),
      jsonResponse({ error: { code: "installation_session_ended" } }, 409),
    ];

    await expect(onlineValidate()).rejects.toMatchObject({ code: "SESSION_ENDED" });
    expect(mocks.rotateAfterServerTermination).toHaveBeenCalledTimes(1);
    expect(requests).toHaveLength(4);
  });
});
