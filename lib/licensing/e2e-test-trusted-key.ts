/**
 * Public key slot for an E2E-only production build. `scripts/e2e-build.sh`
 * writes a per-run public key here, builds the app, then restores this file.
 * Keep the committed value null. The matching private key exists only in
 * memory while generating the disposable E2E license.
 */
export const E2E_TEST_LICENSE_KEY_ID = "clientix-e2e-ephemeral";
export const E2E_TEST_LICENSE_PUBLIC_KEY: string | null = null;
