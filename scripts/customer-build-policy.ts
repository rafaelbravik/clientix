/** Source and artifact policy for the self-hosted customer image. */
export const CUSTOMER_BUILD_EXCLUDED_PATHS = [
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
] as const;

/** Build-time substitutions that keep vendor-only implementations out of the customer target. */
export const CUSTOMER_BUILD_SOURCE_REPLACEMENTS = {
  "lib/auth/support-context-provider.ts": "lib/auth/support-context-provider.customer.ts",
  "lib/auth/support-readonly-provider.ts": "lib/auth/support-readonly-provider.customer.ts",
} as const;

export const CUSTOMER_ARTIFACT_FORBIDDEN_MARKERS = [
  "control_plane.",
  "CONTROL_PLANE_DATABASE_URL",
  "CONTROL_PLANE_PEPPER",
  "CLIENTIX_SIGNING_PRIVATE_KEY",
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

  const segments = normalized.split("/");
  if (segments[0]?.startsWith(".clientix-customer-build-")) return true;
  if (BUILD_ONLY_ROOT_DIRECTORY_NAMES.has(segments[0] ?? "")) return true;
  if (segments.some((segment) => BUILD_ONLY_ANY_DIRECTORY_NAMES.has(segment))) return true;
  if (segments.some((segment) => segment === ".env" || segment.startsWith(".env."))) return true;
  if ([".npmrc", ".pypirc", ".netrc"].includes(segments.at(-1) ?? "")) return true;
  const basename = segments.at(-1) ?? "";
  const extension = basename.includes(".") ? basename.slice(basename.lastIndexOf(".")).toLowerCase() : "";
  if (PRIVATE_MATERIAL_EXTENSIONS.has(extension) || PRIVATE_MATERIAL_BASENAMES.has(basename.toLowerCase())) return true;

  return CUSTOMER_BUILD_EXCLUDED_PATHS.some(
    (excluded) => normalized === excluded || normalized.startsWith(`${excluded}/`),
  );
}

export function findCustomerVendorRouteEntries(routePaths: string[]): string[] {
  const vendorRoute = /(?:^|\/)admin(?:\/|$)|(?:^|\/)auth\/support(?:\/|$)|(?:^|\/)support-ended(?:\/|$)/i;
  return routePaths.filter((routePath) => vendorRoute.test(normalizeBuildPath(routePath)));
}

export function findCustomerArtifactMarkerHits(contents: string): string[] {
  if (!CUSTOMER_ARTIFACT_MARKER_PATTERN.test(contents)) return [];
  return CUSTOMER_ARTIFACT_FORBIDDEN_MARKERS.filter((marker) => contents.includes(marker));
}
