import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import {
  CUSTOMER_ARTIFACT_FORBIDDEN_MARKERS,
  CUSTOMER_BUILD_EXCLUDED_PATHS,
  CUSTOMER_BUILD_SOURCE_REPLACEMENTS,
  findCustomerArtifactMarkerHits,
  findCustomerArtifactPathHits,
  findCustomerArtifactPrivateMaterialHits,
  findCustomerArtifactSourceMapHits,
  findCustomerVendorRouteEntries,
  isCustomerBuildExcludedPath,
  sanitizeCustomerPackageManifest,
} from "@/scripts/customer-build-policy";

describe("customer build boundary", () => {
  it("excludes local operational backups and runtime data from Docker build context", () => {
    const dockerIgnoreEntries = readFileSync(".dockerignore", "utf8").split(/\r?\n/);

    expect(dockerIgnoreEntries).toContain(".clientix-local");
  });

  it("disables application browser, server and prerender source maps", () => {
    const nextConfig = readFileSync("next.config.ts", "utf8");

    expect(nextConfig).toMatch(
      /const isCustomerBuild = process\.env\.NEXT_PUBLIC_CLIENTIX_BUILD_TARGET === "customer"/,
    );
    expect(nextConfig).toMatch(
      /productionBrowserSourceMaps:\s*isCustomerBuild \? false : undefined/,
    );
    expect(nextConfig).toMatch(/serverSourceMaps:\s*isCustomerBuild \? false : undefined/);
    expect(nextConfig).toMatch(/enablePrerenderSourceMaps:\s*isCustomerBuild \? false : undefined/);
  });

  it("excludes global platform administration, support impersonation and vendor licensing", () => {
    expect(CUSTOMER_BUILD_EXCLUDED_PATHS).toEqual([
      "app/admin",
      "app/api/v1/admin",
      "app/api/v1/billing",
      "app/api/v1/licensing",
      "app/api/v1/licenses",
      "app/api/v1/auth/support",
      "app/support-ended",
      "components/admin",
      "components/app/ImpersonateBanner.tsx",
      "control-plane",
      "hooks/useAdminDashboardKPIs.ts",
      "hooks/useAdminUsage.ts",
      "hooks/useAlertsRealtime.ts",
      "hooks/useTenantAgent.ts",
      "hooks/useTenantHealth.ts",
      "lib/impersonate",
      "lib/auth/support-context-provider.customer.ts",
      "lib/auth/support-readonly-provider.customer.ts",
      "scripts/licensing",
    ]);
    expect(isCustomerBuildExcludedPath("app/admin/(protected)/tenants/page.tsx")).toBe(true);
    expect(isCustomerBuildExcludedPath("app/admin/license/page.tsx")).toBe(false);
    expect(isCustomerBuildExcludedPath("app/admin/license/_client.tsx")).toBe(false);
    expect(isCustomerBuildExcludedPath("app/api/v1/admin/tenants/route.ts")).toBe(true);
    expect(isCustomerBuildExcludedPath("app/api/v1/billing/webhooks/stripe/route.ts")).toBe(true);
    expect(isCustomerBuildExcludedPath("app/api/v1/admin/license/route.ts")).toBe(false);
    expect(isCustomerBuildExcludedPath("app/api/v1/admin/license/validate/route.ts")).toBe(false);
    expect(isCustomerBuildExcludedPath("app/api/v1/admin/license/update/route.ts")).toBe(false);
    expect(isCustomerBuildExcludedPath("app/api/v1/admin/license/activate/route.ts")).toBe(false);
    expect(isCustomerBuildExcludedPath("app/api/v1/admin/license/recover/route.ts")).toBe(false);
    expect(isCustomerBuildExcludedPath("app/api/v1/admin/licensing/licenses/route.ts")).toBe(true);
    expect(isCustomerBuildExcludedPath("app/api/v1/licensing/activate/route.ts")).toBe(true);
    expect(isCustomerBuildExcludedPath("app/api/v1/licenses/activate/route.ts")).toBe(true);
    expect(isCustomerBuildExcludedPath("app/api/v1/auth/support/route.ts")).toBe(true);
    expect(isCustomerBuildExcludedPath("app/support-ended/page.tsx")).toBe(true);
    expect(isCustomerBuildExcludedPath("components/admin/ImpersonateButton.tsx")).toBe(true);
    expect(isCustomerBuildExcludedPath("components/app/ImpersonateBanner.tsx")).toBe(true);
    expect(isCustomerBuildExcludedPath("hooks/useAdminDashboardKPIs.ts")).toBe(true);
    expect(isCustomerBuildExcludedPath("hooks/useTenantAgent.ts")).toBe(true);
    expect(isCustomerBuildExcludedPath("control-plane/src/admin-service-provider.ts")).toBe(true);
    expect(isCustomerBuildExcludedPath("lib/impersonate/cookie.ts")).toBe(true);
    expect(isCustomerBuildExcludedPath("lib/auth/support-context-provider.customer.ts")).toBe(true);
    expect(isCustomerBuildExcludedPath("lib/auth/support-readonly-provider.customer.ts")).toBe(
      true,
    );
    expect(isCustomerBuildExcludedPath("scripts/licensing/sign-license.ts")).toBe(true);
  });

  it("keeps customer-local licensing and tenant administration", () => {
    expect(isCustomerBuildExcludedPath("app/api/v1/system/license/route.ts")).toBe(false);
    expect(isCustomerBuildExcludedPath("lib/legal/perfil-do-pais.ts")).toBe(false);
    expect(isCustomerBuildExcludedPath("hooks/reports/useActivityReport.ts")).toBe(false);
    expect(isCustomerBuildExcludedPath("app/app/settings/team/page.tsx")).toBe(false);
    expect(isCustomerBuildExcludedPath("app/api/v1/team/route.ts")).toBe(false);
  });

  it("does not copy credentials, signing material or local audit/report inputs", () => {
    expect(isCustomerBuildExcludedPath(".env.local")).toBe(true);
    expect(isCustomerBuildExcludedPath(".npmrc")).toBe(true);
    expect(isCustomerBuildExcludedPath("packages/.netrc")).toBe(true);
    expect(isCustomerBuildExcludedPath(".clientix-local/backups/private-db.sql")).toBe(true);
    expect(
      isCustomerBuildExcludedPath(".clientix-local/runtime/control-plane-signing-key.pem"),
    ).toBe(true);
    expect(isCustomerBuildExcludedPath(".clientix-customer-build-abcd/project/app/page.tsx")).toBe(
      true,
    );
    expect(isCustomerBuildExcludedPath("distribution/private-signing-key.pem")).toBe(true);
    expect(isCustomerBuildExcludedPath("C:\\Clientix-Secrets\\signing\\key.pem")).toBe(true);
    expect(isCustomerBuildExcludedPath("reports/G1.3-local-report.md")).toBe(true);
    expect(isCustomerBuildExcludedPath("legal/contract.md")).toBe(true);
  });

  it("detects any remaining global admin or support impersonation route", () => {
    expect(
      findCustomerVendorRouteEntries([
        "/admin/(protected)/licensing/licenses/page",
        "/admin/license/page",
        "/api/v1/admin/licensing/licenses/route",
        "/api/v1/admin/license/route",
        "/api/v1/admin/license/validate/route",
        "/api/v1/admin/license/update/route",
        "/api/v1/admin/license/recover/route",
        "/api/v1/system/license/route",
        "/admin/tenants/page",
        "/api/v1/admin/tenants/route",
        "/api/v1/billing/webhooks/stripe/route",
        "/api/v1/auth/support/route",
        "/support-ended/page",
        "/app/settings/team/page",
      ]),
    ).toEqual([
      "/admin/(protected)/licensing/licenses/page",
      "/api/v1/admin/licensing/licenses/route",
      "/admin/tenants/page",
      "/api/v1/admin/tenants/route",
      "/api/v1/billing/webhooks/stripe/route",
      "/api/v1/auth/support/route",
      "/support-ended/page",
    ]);
  });

  it("scans customer artifacts for control-plane database and issuance markers", () => {
    expect(findCustomerArtifactMarkerHits("customer route is clean")).toEqual([]);
    expect(CUSTOMER_ARTIFACT_FORBIDDEN_MARKERS).toContain("control_plane.");
    expect(CUSTOMER_ARTIFACT_FORBIDDEN_MARKERS).toContain("CLIENTIX_SIGNING_PRIVATE_KEY");
    expect(CUSTOMER_ARTIFACT_FORBIDDEN_MARKERS).toContain("LicenseIssuer");
    expect(CUSTOMER_ARTIFACT_FORBIDDEN_MARKERS).toContain("license-issuer");
    expect(CUSTOMER_ARTIFACT_FORBIDDEN_MARKERS).toContain("signIssuedLicense");
    expect(CUSTOMER_ARTIFACT_FORBIDDEN_MARKERS).toContain("VENDOR_ADMIN_TOKEN");
    expect(CUSTOMER_ARTIFACT_FORBIDDEN_MARKERS).toContain("CONTROL_PLANE_SIGNING_KEYS");
    expect(CUSTOMER_ARTIFACT_FORBIDDEN_MARKERS).toContain(
      "CONTROL_PLANE_LICENSE_SIGNING_KEYS_JSON",
    );
    expect(CUSTOMER_ARTIFACT_FORBIDDEN_MARKERS).toContain("CONTROL_PLANE_ACTIVE_LICENSE_KEY_ID");
    expect(CUSTOMER_ARTIFACT_FORBIDDEN_MARKERS).toContain("IMPERSONATE_COOKIE_SECRET");
    expect(CUSTOMER_ARTIFACT_FORBIDDEN_MARKERS).toContain(
      "CONTROL_PLANE_BILLING_WEBHOOK_SECRETS_JSON",
    );
    expect(CUSTOMER_ARTIFACT_FORBIDDEN_MARKERS).toContain("fn_is_platform_admin");
    expect(CUSTOMER_ARTIFACT_FORBIDDEN_MARKERS).toContain("support_readonly");
    expect(
      findCustomerArtifactMarkerHits("select * from control_plane.licensing_licenses"),
    ).toEqual(["control_plane."]);
    expect(findCustomerArtifactMarkerHits("deskcomm-impersonate")).toEqual([
      "deskcomm-impersonate",
    ]);
    expect(findCustomerArtifactMarkerHits('"support_readonly"')).toEqual(["support_readonly"]);
  });

  it("substitutes vendor support providers with customer build implementations", () => {
    expect(CUSTOMER_BUILD_SOURCE_REPLACEMENTS).toEqual({
      "lib/auth/support-context-provider.ts": "lib/auth/support-context-provider.customer.ts",
      "lib/auth/support-readonly-provider.ts": "lib/auth/support-readonly-provider.customer.ts",
    });
    expect(
      findCustomerArtifactMarkerHits(
        "select fn_support_context() from public.platform_support_sessions",
      ),
    ).toEqual(["platform_support_sessions", "fn_support_context"]);
  });

  it("detects issuer private-key material without treating LIC-01 key code as key material", () => {
    const generatedPrivateKeyBlock = [
      "-----BEGIN PRIVATE KEY-----",
      Buffer.alloc(64, 7).toString("base64"),
      "-----END PRIVATE KEY-----",
    ].join("\n");

    expect(findCustomerArtifactPrivateMaterialHits(generatedPrivateKeyBlock)).toEqual([
      "PRIVATE_KEY_PEM_BLOCK",
    ]);
    expect(
      findCustomerArtifactPrivateMaterialHits(
        'const label = "-----BEGIN PRIVATE KEY-----"; // per-installation LIC-01 key parser',
      ),
    ).toEqual([]);
  });

  it("rejects vendor, fixture and private-material paths but allows the public trust root", () => {
    expect(
      findCustomerArtifactPathHits([
        "server.js",
        "lib/licensing/trusted-keys.ts",
        "control-plane/src/license-issuer.js",
        "tests/fixtures/licensing/private.pem",
        "lib/license-signing-key.p8",
        "node_modules/example-package/fixtures/normalizer.js",
      ]),
    ).toEqual([
      "control-plane/src/license-issuer.js",
      "tests/fixtures/licensing/private.pem",
      "lib/license-signing-key.p8",
    ]);
  });

  it("rejects application source maps but allows third-party package maps", () => {
    expect(
      findCustomerArtifactSourceMapHits([
        ".next/server/app/admin/license/page.js.map",
        "static/chunks/app.js.map",
        "node_modules/example-package/index.js.map",
      ]),
    ).toEqual([".next/server/app/admin/license/page.js.map", "static/chunks/app.js.map"]);
  });

  it("removes generated customer source maps before artifact inspection", () => {
    const buildScript = readFileSync("scripts/build-customer.ts", "utf8");

    expect(buildScript).toMatch(/function removeCustomerSourceMaps\(\)/);
    expect(buildScript).toMatch(/removeCustomerSourceMaps\(\);\s*assertCustomerBuildOutput\(\);/);
  });

  it("removes repository operator scripts from the traced customer package manifest", () => {
    const result = JSON.parse(
      sanitizeCustomerPackageManifest(
        JSON.stringify({
          name: "clientix",
          scripts: { "control-plane:migrate": "tsx control-plane/scripts/apply-migrations.ts" },
          dependencies: { next: "16.x" },
        }),
      ),
    ) as Record<string, unknown>;

    expect(result).toEqual({ name: "clientix", dependencies: { next: "16.x" } });
  });
});
