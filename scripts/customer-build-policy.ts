/** Source and artifact policy for the self-hosted customer image. */
export const CUSTOMER_BUILD_EXCLUDED_PATHS = [
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
] as const;

/** Build-time substitutions that keep vendor-only implementations out of the customer target. */
export const CUSTOMER_BUILD_SOURCE_REPLACEMENTS = {
  "lib/auth/support-context-provider.ts": "lib/auth/support-context-provider.customer.ts",
  "lib/auth/support-readonly-provider.ts": "lib/auth/support-readonly-provider.customer.ts",
} as const;

const CUSTOMER_LOCAL_LICENSE_SOURCE_PATHS = [
  "app/admin/license/page.tsx",
  "app/admin/license/_client.tsx",
  "app/api/v1/admin/license/route.ts",
  "app/api/v1/admin/license/validate/route.ts",
  "app/api/v1/admin/license/update/route.ts",
  "app/api/v1/admin/license/activate/route.ts",
  "app/api/v1/admin/license/recover/route.ts",
] as const;

const CUSTOMER_OWNER_SOURCE_PATHS = [
  "app/owner",
  "app/api/v1/admin/tenants/route.ts",
  "app/api/v1/admin/users/route.ts",
] as const;

export const CUSTOMER_ARTIFACT_FORBIDDEN_MARKERS = [
  "control-plane",
  "control_plane.",
  "LicenseIssuer",
  "license-issuer",
  "signIssuedLicense",
  "withControlPlaneLicenseService",
  "CONTROL_PLANE_DATABASE_URL",
  "CONTROL_PLANE_PEPPER",
  "CONTROL_PLANE_ADMIN_TOKEN",
  "VENDOR_DB_URL",
  "VENDOR_DATABASE_URL",
  "VENDOR_ADMIN_TOKEN",
  "LICENSE_PRIVATE_KEY",
  "LICENSE_SIGNING_PRIVATE_KEY",
  "CLIENTIX_SIGNING_PRIVATE_KEY",
  "CONTROL_PLANE_SIGNING_KEYS",
  "CONTROL_PLANE_LICENSE_SIGNING_KEYS_JSON",
  "CONTROL_PLANE_ACTIVE_LICENSE_KEY_ID",
  "CONTROL_PLANE_ADMIN_PASSWORD",
  "CONTROL_PLANE_LICENSE_SIGNING_PRIVATE_KEY",
  "CONTROL_PLANE_BILLING_WEBHOOK_SECRETS_JSON",
  "billing_webhook_receipts",
  "billing_admin_operations",
  "run_billing_maintenance",
  "STRIPE_SECRET_KEY",
  "MERCADO_PAGO_ACCESS_TOKEN",
  "LICENSE_PEPPER",
  "IMPERSONATE_COOKIE_SECRET",
  "platform_support_sessions",
  "fn_support_context",
  "fn_support_callback_write_allowed",
  "support_readonly",
  "fn_is_platform_admin",
  "deskcomm-impersonate",
  "signLicensePayload",
  "getControlPlaneAdminService",
  "clientix_default_control_plane_pepper_min_32_bytes",
] as const;

const PRIVATE_KEY_BLOCK_PATTERN =
  /-----BEGIN (?:[A-Z0-9]+ )*PRIVATE KEY-----\s*[A-Za-z0-9+/=\r\n]{64,}\s*-----END (?:[A-Z0-9]+ )*PRIVATE KEY-----/;

const CUSTOMER_ARTIFACT_MARKER_PATTERN = new RegExp(
  `(?:${CUSTOMER_ARTIFACT_FORBIDDEN_MARKERS.map((marker) => marker.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|")})`,
);

const BUILD_ONLY_ANY_DIRECTORY_NAMES = new Set([
  ".agent",
  ".agents",
  ".cache",
  ".changes",
  ".claude",
  ".codex",
  ".cursor",
  ".clientix-local",
  ".git",
  ".next",
  ".opencode",
  ".specs",
  ".superpowers",
  ".turbo",
  ".vercel",
  "node_modules",
]);

const BUILD_ONLY_ROOT_DIRECTORY_NAMES = new Set([
  "certification",
  "coverage",
  "dist",
  "docs",
  "evidence",
  "build",
  "logs",
  "legal",
  "manuals",
  "out",
  "reports",
  "scratchpad",
  "tasks",
  "test-results",
  "tests",
]);

const PRIVATE_MATERIAL_EXTENSIONS = new Set([".key", ".p8", ".p12", ".pfx", ".pem"]);
const PRIVATE_MATERIAL_BASENAMES = new Set(["id_ed25519", "id_ecdsa", "id_rsa"]);

export function normalizeBuildPath(path: string): string {
  return path.replace(/\\/g, "/").replace(/^\.\//, "").replace(/\/$/, "");
}

export function isCustomerBuildExcludedPath(path: string): boolean {
  const normalized = normalizeBuildPath(path);
  if (!normalized) return false;

  // Keep a small, self-host owner surface for tenant and seat management. The
  // vendor licensing console, broad platform admin UI, and Control Plane remain
  // outside the customer artifact.
  if (
    CUSTOMER_LOCAL_LICENSE_SOURCE_PATHS.includes(
      normalized as (typeof CUSTOMER_LOCAL_LICENSE_SOURCE_PATHS)[number],
    ) ||
    CUSTOMER_LOCAL_LICENSE_SOURCE_PATHS.some((allowed) => allowed.startsWith(`${normalized}/`)) ||
    CUSTOMER_OWNER_SOURCE_PATHS.includes(
      normalized as (typeof CUSTOMER_OWNER_SOURCE_PATHS)[number],
    ) ||
    CUSTOMER_OWNER_SOURCE_PATHS.some((allowed) => allowed.startsWith(`${normalized}/`))
  ) {
    return false;
  }

  const segments = normalized.split("/");
  if (segments[0]?.startsWith(".clientix-customer-build-")) return true;
  if (BUILD_ONLY_ROOT_DIRECTORY_NAMES.has(segments[0] ?? "")) return true;
  if (segments.some((segment) => BUILD_ONLY_ANY_DIRECTORY_NAMES.has(segment))) return true;
  if (segments.some((segment) => segment === ".env" || segment.startsWith(".env."))) return true;
  if ([".npmrc", ".pypirc", ".netrc"].includes(segments.at(-1) ?? "")) return true;
  const basename = segments.at(-1) ?? "";
  const extension = basename.includes(".")
    ? basename.slice(basename.lastIndexOf(".")).toLowerCase()
    : "";
  if (
    PRIVATE_MATERIAL_EXTENSIONS.has(extension) ||
    PRIVATE_MATERIAL_BASENAMES.has(basename.toLowerCase())
  )
    return true;

  return CUSTOMER_BUILD_EXCLUDED_PATHS.some(
    (excluded) => normalized === excluded || normalized.startsWith(`${excluded}/`),
  );
}

export function findCustomerVendorRouteEntries(routePaths: string[]): string[] {
  const vendorRoute =
    /(?:^|\/)admin(?:\/|$)|(?:^|\/)auth\/support(?:\/|$)|(?:^|\/)support-ended(?:\/|$)/i;
  return routePaths.filter((routePath) => {
    const normalized = normalizeBuildPath(routePath)
      .replace(/^app\//, "")
      .replace(/^\/+/, "");
    const localLicenseRoute =
      normalized === "admin/license" ||
      normalized === "admin/license/page" ||
      normalized === "api/v1/admin/license/route" ||
      /^api\/v1\/admin\/license\/(?:validate|update|activate|recover)\/route$/.test(normalized);
    const localOwnerApiRoute =
      normalized === "api/v1/admin/tenants/route" || normalized === "api/v1/admin/users/route";
    const billingVendorRoute = /^api\/v1\/billing\/webhooks\/(?:stripe|mercado-pago)\/route$/.test(
      normalized,
    );
    return (
      billingVendorRoute ||
      (!localLicenseRoute && !localOwnerApiRoute && vendorRoute.test(`/${normalized}`))
    );
  });
}

export function findCustomerArtifactMarkerHits(contents: string): string[] {
  if (!CUSTOMER_ARTIFACT_MARKER_PATTERN.test(contents)) return [];
  return CUSTOMER_ARTIFACT_FORBIDDEN_MARKERS.filter((marker) => contents.includes(marker));
}

/** Detects actual private-key material, not references to LIC-01 installation-key code. */
export function findCustomerArtifactPrivateMaterialHits(contents: string): string[] {
  const normalized = contents.replace(/\\r?\\n/g, "\n");
  return PRIVATE_KEY_BLOCK_PATTERN.test(normalized) ? ["PRIVATE_KEY_PEM_BLOCK"] : [];
}

/** Checks artifact paths without opening files or exposing file contents. */
export function findCustomerArtifactPathHits(paths: string[]): string[] {
  const privateExtensions = new Set([".key", ".p8", ".p12", ".pfx"]);
  const privateBasenames = new Set(["id_ed25519", "id_ecdsa", "id_rsa"]);
  return paths.filter((path) => {
    const normalized = normalizeBuildPath(path);
    const segments = normalized.split("/").filter(Boolean);
    const lowerSegments = segments.map((segment) => segment.toLowerCase());
    const basename = lowerSegments.at(-1) ?? "";
    const extension = basename.includes(".") ? basename.slice(basename.lastIndexOf(".")) : "";
    const inNodeModules = lowerSegments.includes("node_modules");

    if (lowerSegments.includes("control-plane")) return true;
    if (lowerSegments.some((segment) => segment === ".git" || segment.startsWith(".env")))
      return true;
    if (lowerSegments.includes("scripts") && lowerSegments.includes("licensing")) return true;
    if (privateExtensions.has(extension) || privateBasenames.has(basename)) return true;
    if (
      !inNodeModules &&
      lowerSegments.some((segment) => ["docs", "tests", "fixtures"].includes(segment))
    )
      return true;
    return false;
  });
}

/** Production customer code does not need browser or server source maps. */
export function findCustomerArtifactSourceMapHits(paths: string[]): string[] {
  return paths.filter((path) => {
    const normalized = normalizeBuildPath(path);
    return (
      normalized.toLowerCase().endsWith(".map") &&
      !normalized.split("/").some((segment) => segment.toLowerCase() === "node_modules")
    );
  });
}

/** Removes repository operator commands from the package manifest traced into standalone. */
export function sanitizeCustomerPackageManifest(contents: string): string {
  const parsed: unknown = JSON.parse(contents);
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error("Customer package manifest must be a JSON object.");
  }
  delete (parsed as Record<string, unknown>).scripts;
  return `${JSON.stringify(parsed, null, 2)}\n`;
}
