import { describe, expect, it } from "vitest";

import {
  CUSTOMER_ARTIFACT_FORBIDDEN_MARKERS,
  CUSTOMER_BUILD_EXCLUDED_PATHS,
  CUSTOMER_BUILD_SOURCE_REPLACEMENTS,
  findCustomerArtifactMarkerHits,
  findCustomerVendorRouteEntries,
  isCustomerBuildExcludedPath,
} from "@/scripts/customer-build-policy";

describe("customer build boundary", () => {
  it("excludes global platform administration, support impersonation and vendor licensing", () => {
    expect(CUSTOMER_BUILD_EXCLUDED_PATHS).toEqual([
      "app/admin",
      "app/api/v1/admin",
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
    expect(isCustomerBuildExcludedPath("app/api/v1/admin/tenants/route.ts")).toBe(true);
    expect(isCustomerBuildExcludedPath("app/api/v1/admin/licensing/licenses/route.ts")).toBe(true);
    expect(isCustomerBuildExcludedPath("app/api/v1/auth/support/route.ts")).toBe(true);
    expect(isCustomerBuildExcludedPath("app/support-ended/page.tsx")).toBe(true);
    expect(isCustomerBuildExcludedPath("components/admin/ImpersonateButton.tsx")).toBe(true);
    expect(isCustomerBuildExcludedPath("components/app/ImpersonateBanner.tsx")).toBe(true);
    expect(isCustomerBuildExcludedPath("hooks/useAdminDashboardKPIs.ts")).toBe(true);
    expect(isCustomerBuildExcludedPath("hooks/useTenantAgent.ts")).toBe(true);
    expect(isCustomerBuildExcludedPath("control-plane/src/admin-service-provider.ts")).toBe(true);
    expect(isCustomerBuildExcludedPath("lib/impersonate/cookie.ts")).toBe(true);
    expect(isCustomerBuildExcludedPath("lib/auth/support-context-provider.customer.ts")).toBe(true);
    expect(isCustomerBuildExcludedPath("lib/auth/support-readonly-provider.customer.ts")).toBe(true);
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
    expect(isCustomerBuildExcludedPath(".clientix-customer-build-abcd/project/app/page.tsx")).toBe(true);
    expect(isCustomerBuildExcludedPath("distribution/private-signing-key.pem")).toBe(true);
    expect(isCustomerBuildExcludedPath("C:\\Clientix-Secrets\\signing\\key.pem")).toBe(true);
    expect(isCustomerBuildExcludedPath("reports/G1.3-local-report.md")).toBe(true);
    expect(isCustomerBuildExcludedPath("legal/contract.md")).toBe(true);
  });

  it("detects any remaining global admin or support impersonation route", () => {
    expect(
      findCustomerVendorRouteEntries([
        "/admin/(protected)/licensing/licenses/page",
        "/api/v1/admin/licensing/licenses/route",
        "/api/v1/system/license/route",
        "/admin/tenants/page",
        "/api/v1/admin/tenants/route",
        "/api/v1/auth/support/route",
        "/support-ended/page",
        "/app/settings/team/page",
      ]),
    ).toEqual([
      "/admin/(protected)/licensing/licenses/page",
      "/api/v1/admin/licensing/licenses/route",
        "/admin/tenants/page",
        "/api/v1/admin/tenants/route",
        "/api/v1/auth/support/route",
        "/support-ended/page",
    ]);
  });

  it("scans customer artifacts for control-plane database and issuance markers", () => {
    expect(findCustomerArtifactMarkerHits("customer route is clean")).toEqual([]);
    expect(CUSTOMER_ARTIFACT_FORBIDDEN_MARKERS).toContain("control_plane.");
    expect(CUSTOMER_ARTIFACT_FORBIDDEN_MARKERS).toContain("CLIENTIX_SIGNING_PRIVATE_KEY");
    expect(CUSTOMER_ARTIFACT_FORBIDDEN_MARKERS).toContain("IMPERSONATE_COOKIE_SECRET");
    expect(CUSTOMER_ARTIFACT_FORBIDDEN_MARKERS).toContain("fn_is_platform_admin");
    expect(CUSTOMER_ARTIFACT_FORBIDDEN_MARKERS).toContain("support_readonly");
    expect(findCustomerArtifactMarkerHits("select * from control_plane.licensing_licenses")).toEqual([
      "control_plane.",
    ]);
    expect(findCustomerArtifactMarkerHits("deskcomm-impersonate")).toEqual(["deskcomm-impersonate"]);
    expect(findCustomerArtifactMarkerHits('"support_readonly"')).toEqual(["support_readonly"]);
  });

  it("substitutes vendor support providers with customer build implementations", () => {
    expect(CUSTOMER_BUILD_SOURCE_REPLACEMENTS).toEqual({
      "lib/auth/support-context-provider.ts": "lib/auth/support-context-provider.customer.ts",
      "lib/auth/support-readonly-provider.ts": "lib/auth/support-readonly-provider.customer.ts",
    });
    expect(findCustomerArtifactMarkerHits("select fn_support_context() from public.platform_support_sessions")).toEqual([
      "platform_support_sessions",
      "fn_support_context",
    ]);
  });
});
