import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const mocks = vi.hoisted(() => ({ validateAttestation: vi.fn() }));

vi.mock("@/control-plane/src/license-server-provider", () => ({
  withControlPlaneLicenseService: (callback: (service: unknown, config: unknown) => unknown) =>
    callback({ validateAttestation: mocks.validateAttestation }, {}),
}));

import { POST } from "./route";

function request() {
  return new NextRequest("http://localhost/api/v1/licensing/validate-attestation", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-installation-signature": "synthetic-signature",
    },
    body: JSON.stringify({
      installation_id: "inst_11111111-1111-4111-8111-111111111111",
      license_id: "license-test",
      instance_session_id: "sess_22222222-2222-4222-8222-222222222222",
      boot_started_at: "2026-11-10T12:00:00.000Z",
      challenge: "c".repeat(32),
      timestamp: Math.floor(Date.now() / 1000),
      nonce: "n".repeat(32),
    }),
  });
}

describe("POST /api/v1/licensing/validate-attestation", () => {
  beforeEach(() => mocks.validateAttestation.mockReset());

  it("exposes an ended-session signal only for the signed installation recovery flow", async () => {
    mocks.validateAttestation.mockResolvedValue({
      ok: false,
      status: 409,
      error: { code: "INSTANCE_SESSION_ENDED", message: "Attestation could not be completed." },
    });

    const response = await POST(request());

    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({
      error: { code: "installation_session_ended", message: "Installation session has ended." },
    });
  });

  it("keeps unrelated replay and authorization failures generic and fail-closed", async () => {
    mocks.validateAttestation.mockResolvedValue({
      ok: false,
      status: 409,
      error: { code: "REPLAY_DETECTED", message: "Attestation could not be completed." },
    });

    const response = await POST(request());

    expect(response.status).toBe(401);
    expect(await response.json()).toMatchObject({ error: { code: "unauthorized" } });
  });
});
