import * as Sentry from "@sentry/nextjs";

let licenseHeartbeatStarted = false;

export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    await import("./sentry.server.config");
    if (!licenseHeartbeatStarted) {
      licenseHeartbeatStarted = true;
      const { startLicenseHeartbeat } = await import("./lib/licensing/license-server-client");
      startLicenseHeartbeat();
    }
  }

  if (process.env.NEXT_RUNTIME === "edge") {
    await import("./sentry.edge.config");
  }
}

export const onRequestError = Sentry.captureRequestError;
