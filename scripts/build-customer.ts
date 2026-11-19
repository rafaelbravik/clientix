import { spawnSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import path, { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

import {
  CUSTOMER_BUILD_EXCLUDED_PATHS,
  CUSTOMER_BUILD_SOURCE_REPLACEMENTS,
  findCustomerArtifactMarkerHits,
  findCustomerArtifactPathHits,
  findCustomerArtifactPrivateMaterialHits,
  findCustomerArtifactSourceMapHits,
  findCustomerVendorRouteEntries,
  isCustomerBuildExcludedPath,
  sanitizeCustomerPackageManifest,
} from "./customer-build-policy";
import {
  createCustomerCertificationTrustModule,
  parseCustomerBuildArguments,
} from "./lib/customer-certification-trust";
import { materializeCustomerRuntimeDependencies } from "./lib/materialize-customer-runtime";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const projectNodeModules = resolve(projectRoot, "node_modules");
const buildArguments = parseCustomerBuildArguments(process.argv.slice(2));
const inputOutputPath = buildArguments.outputPath;
const localRuntimeRoot = resolve(projectRoot, ".clientix-local", "runtime");
mkdirSync(localRuntimeRoot, { recursive: true });
const workRoot = mkdtempSync(path.join(localRuntimeRoot, "clientix-customer-build-source-"));
const stagedProject = path.join(workRoot, "project");
const artifactRoot = inputOutputPath
  ? resolve(inputOutputPath)
  : mkdtempSync(path.join(localRuntimeRoot, "clientix-customer-artifact-"));
const artifactWasCreatedHere = !inputOutputPath;

const environmentAllowlist = new Set([
  "APPDATA",
  "CI",
  "COMSPEC",
  "HOME",
  "LANG",
  "LC_ALL",
  "LOCALAPPDATA",
  "PATH",
  "PATHEXT",
  "SYSTEMROOT",
  "TEMP",
  "TMP",
  "TMPDIR",
  "USERPROFILE",
  "WINDIR",
]);

function createBuildEnvironment(): NodeJS.ProcessEnv {
  const result: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (environmentAllowlist.has(key.toUpperCase()) && value !== undefined) result[key] = value;
  }

  result.NODE_ENV = "production";
  // O build usa um Webpack worker isolado e concorrência unitária. O BuildKit
  // deste alvo reserva 7 GiB; o heap de 5 GiB mantém margem para memória nativa,
  // o processo de orquestração do Next e os auxiliares do build.
  result.NODE_OPTIONS = "--max-old-space-size=5120";
  result.NEXT_TELEMETRY_DISABLED = "1";
  result.NEXT_PUBLIC_CLIENTIX_BUILD_TARGET = "customer";
  result.NEXT_PUBLIC_SUPABASE_URL = "https://placeholder.supabase.co";
  result.NEXT_PUBLIC_SUPABASE_ANON_KEY = "placeholder-anon-key";
  result.NEXT_PUBLIC_APP_URL = "https://placeholder.invalid";
  result.NEXT_PUBLIC_ADMIN_URL = "https://placeholder.invalid";
  return result;
}

function copyCustomerSource(): void {
  function copyDirectory(sourceDirectory: string, destinationDirectory: string): void {
    mkdirSync(destinationDirectory, { recursive: true });
    for (const entry of readdirSync(sourceDirectory, { withFileTypes: true })) {
      const source = path.join(sourceDirectory, entry.name);
      const destination = path.join(destinationDirectory, entry.name);
      const rel = relative(projectRoot, source);
      if (!rel || rel.startsWith(`..${sep}`) || isAbsolute(rel)) continue;
      if (isCustomerBuildExcludedPath(rel.split(sep).join("/"))) continue;

      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) copyDirectory(source, destination);
      else if (entry.isFile()) cpSync(source, destination);
    }
  }

  copyDirectory(projectRoot, stagedProject);
}

function installCustomerRuntimeStubs(): void {
  const supportModule = path.join(stagedProject, "lib", "impersonate", "support.ts");
  const auditModule = path.join(stagedProject, "lib", "impersonate", "audit.ts");
  const proxyModule = path.join(stagedProject, "lib", "impersonate", "proxy.ts");
  const bannerModule = path.join(stagedProject, "components", "app", "ImpersonateBanner.tsx");

  mkdirSync(dirname(supportModule), { recursive: true });
  mkdirSync(dirname(bannerModule), { recursive: true });
  writeFileSync(
    supportModule,
    [
      'import { z } from "zod";',
      'import { createClient } from "@/lib/supabase/server";',
      'export type SupportContext = import("@/lib/auth/support-context").SupportContext;',
      "export async function readSupportContext(_db?: unknown): Promise<SupportContext | null> { return null; }",
      "export function supportWriteError(_support?: SupportContext | null, _organizationId?: string): string | null { return null; }",
      "export async function requireSupportWrite(_targetOrganizationId?: string): Promise<null> { return null; }",
      "export async function supportCallbackWriteAllowed(_organizationId: string, _actorId?: string, _sessionId?: string): Promise<boolean> { return true; }",
      'export async function authenticatedSessionId(): Promise<string> { const db = await createClient(); const { data: { user } } = await db.auth.getUser(); if (!user) throw new Error("Sessão ausente."); const { data } = await db.auth.getClaims(); return z.string().uuid().parse(data?.claims.session_id); }',
    ].join("\n"),
    "utf8",
  );
  writeFileSync(
    auditModule,
    "export async function obterMetadadosDeAcompanhamento(_entry: unknown): Promise<Record<string, unknown>> { return {}; }\n",
    "utf8",
  );
  writeFileSync(
    proxyModule,
    "export async function validarCookieDeAcompanhamento(_request: unknown, _response: unknown, _pathname: string): Promise<void> {}\n",
    "utf8",
  );
  writeFileSync(
    bannerModule,
    "export function ImpersonateBanner(_props: { impersonating: unknown; ended?: boolean }): null { return null; }\n",
    "utf8",
  );
}

function installCustomerSourceReplacements(): void {
  for (const [target, replacement] of Object.entries(CUSTOMER_BUILD_SOURCE_REPLACEMENTS)) {
    const targetPath = path.join(stagedProject, target);
    const replacementPath = path.join(projectRoot, replacement);
    mkdirSync(dirname(targetPath), { recursive: true });
    writeFileSync(targetPath, readFileSync(replacementPath));
  }
}

function installCertificationTrustRoot(): void {
  if (buildArguments.mode !== "certification") return;
  const targetPath = path.join(stagedProject, "lib", "licensing", "trusted-keys.ts");
  const moduleSource = createCustomerCertificationTrustModule(
    buildArguments.keyId!,
    buildArguments.publicKeyBase64!,
  );
  writeFileSync(targetPath, moduleSource, "utf8");
}

function installCustomerDependencies(): void {
  const install = spawnSync("pnpm", ["install", "--offline", "--frozen-lockfile"], {
    cwd: stagedProject,
    env: { ...createBuildEnvironment(), NODE_ENV: "development" },
    shell: process.platform === "win32",
    stdio: "inherit",
  });
  if (install.error) throw install.error;
  if (install.status !== 0) {
    throw new Error(
      `Instalação offline das dependências staged terminou com código ${install.status ?? "desconhecido"}.`,
    );
  }
}

function removeCustomerOperatorCommands(): void {
  const manifestPath = path.join(stagedProject, "package.json");
  const manifest = readFileSync(manifestPath, "utf8");
  writeFileSync(manifestPath, sanitizeCustomerPackageManifest(manifest), "utf8");
}

function assertCustomerBuildOutput(): void {
  const standaloneRoot = path.join(stagedProject, ".next", "standalone");
  const routeManifestPath = path.join(standaloneRoot, ".next", "server", "app-paths-manifest.json");
  console.info("Verificando o manifesto de rotas do build customer.");
  if (!existsSync(routeManifestPath)) {
    throw new Error("O build não gerou o manifesto de rotas do standalone.");
  }

  const manifest = JSON.parse(readFileSync(routeManifestPath, "utf8")) as Record<string, unknown>;
  const vendorRoutes = findCustomerVendorRouteEntries(Object.keys(manifest));
  if (vendorRoutes.length > 0) {
    throw new Error(
      `Rotas administrativas ou de suporte vendor apareceram no build de cliente: ${vendorRoutes.join(", ")}`,
    );
  }
  if (
    !Object.keys(manifest).some((routePath) => routePath.includes("/api/v1/system/license/route"))
  ) {
    throw new Error("A rota de licença local da instalação não apareceu no build de cliente.");
  }

  const scannedFiles: string[] = [];
  const scannedArtifactPaths: string[] = [];
  const textExtensions = new Set([".cjs", ".html", ".js", ".json", ".map", ".mjs", ".pem"]);
  function visit(directory: string, root: string): void {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const fullPath = path.join(directory, entry.name);
      scannedArtifactPaths.push(path.relative(root, fullPath).split(sep).join("/"));
      if (entry.isDirectory()) visit(fullPath, root);
      else if (entry.isFile() && textExtensions.has(path.extname(entry.name).toLowerCase())) {
        scannedFiles.push(fullPath);
      }
    }
  }
  visit(standaloneRoot, standaloneRoot);
  const staticRoot = path.join(stagedProject, ".next", "static");
  if (existsSync(staticRoot)) visit(staticRoot, staticRoot);
  const publicRoot = path.join(stagedProject, "public");
  if (existsSync(publicRoot)) visit(publicRoot, publicRoot);
  const artifactPathHits = findCustomerArtifactPathHits(scannedArtifactPaths);
  if (artifactPathHits.length > 0) {
    throw new Error(
      `O artefato customer contém caminhos de material ou código proibido: ${artifactPathHits.join(", ")}`,
    );
  }

  const applicationSourceMaps = findCustomerArtifactSourceMapHits(scannedArtifactPaths);
  if (applicationSourceMaps.length > 0) {
    throw new Error(
      `O artefato customer contém source maps de browser ou servidor: ${applicationSourceMaps.slice(0, 10).join(", ")}`,
    );
  }
  console.info(`Verificando referências proibidas em ${scannedFiles.length} arquivos do artefato.`);

  const markerHits: string[] = [];
  const privateMaterialHits: string[] = [];
  let hasCertificationKeyId = false;
  let hasExpectedCertificationKeyId = false;
  let hasOfficialLicenseKeyId = false;
  for (const file of scannedFiles) {
    const contents = readFileSync(file, "utf8");
    if (contents.includes("clientix-certification-test-")) hasCertificationKeyId = true;
    if (buildArguments.keyId && contents.includes(buildArguments.keyId))
      hasExpectedCertificationKeyId = true;
    if (contents.includes("clientix-license-2026-01")) hasOfficialLicenseKeyId = true;
    for (const category of findCustomerArtifactPrivateMaterialHits(contents)) {
      privateMaterialHits.push(
        `${path.relative(stagedProject, file).split(sep).join("/")}: ${category}`,
      );
    }
    for (const marker of findCustomerArtifactMarkerHits(contents)) {
      markerHits.push(`${path.relative(stagedProject, file).split(sep).join("/")}: ${marker}`);
    }
  }
  if (privateMaterialHits.length > 0) {
    throw new Error(
      `O artefato customer contém material privado de assinatura: ${privateMaterialHits.join(", ")}`,
    );
  }
  if (markerHits.length > 0) {
    throw new Error(
      `O artefato de cliente contém referências vendor proibidas: ${markerHits.join(", ")}`,
    );
  }

  if (buildArguments.mode === "production" && hasCertificationKeyId) {
    throw new Error("Build customer de produção contém key ID de trust root de certificação.");
  }
  if (buildArguments.mode === "production" && !hasOfficialLicenseKeyId) {
    throw new Error(
      "Build customer de produção não contém a trust root pública de licença esperada.",
    );
  }
  if (buildArguments.mode === "certification") {
    if (!buildArguments.keyId || !hasExpectedCertificationKeyId) {
      throw new Error(
        "O build customer-certification não incluiu o key ID público de teste esperado.",
      );
    }
    if (hasOfficialLicenseKeyId) {
      throw new Error("Build customer-certification contém o trust root oficial de produção.");
    }
  }
}

function removeCustomerSourceMaps(): void {
  const outputRoots = [
    path.join(stagedProject, ".next", "standalone"),
    path.join(stagedProject, ".next", "static"),
  ];

  for (const outputRoot of outputRoots) {
    if (!existsSync(outputRoot)) continue;
    const visit = (directory: string) => {
      for (const entry of readdirSync(directory, { withFileTypes: true })) {
        const entryPath = path.join(directory, entry.name);
        if (entry.isDirectory()) visit(entryPath);
        else if (entry.isFile() && entry.name.endsWith(".map")) rmSync(entryPath);
      }
    };
    visit(outputRoot);
  }
}

function assertStandaloneHasNoSymlinks(): void {
  const standaloneRoot = path.join(artifactRoot, "standalone");
  const symlinkPaths: string[] = [];

  function visit(directory: string): void {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const entryPath = path.join(directory, entry.name);
      if (entry.isSymbolicLink() || lstatSync(entryPath).isSymbolicLink()) {
        symlinkPaths.push(path.relative(standaloneRoot, entryPath).split(sep).join("/"));
      } else if (entry.isDirectory()) {
        visit(entryPath);
      }
    }
  }

  visit(standaloneRoot);
  if (symlinkPaths.length > 0) {
    throw new Error(
      `O standalone customer contém symlinks que podem depender do staging: ${symlinkPaths.slice(0, 10).join(", ")}.`,
    );
  }
}

function copyArtifact(): void {
  if (existsSync(artifactRoot) && !artifactWasCreatedHere) {
    throw new Error(
      "O diretório de saída já existe; escolha um destino vazio para não sobrescrever artefatos.",
    );
  }

  mkdirSync(artifactRoot, { recursive: true });
  for (const directory of ["standalone", "static", "public"] as const) {
    const source =
      directory === "standalone"
        ? path.join(stagedProject, ".next", "standalone")
        : directory === "static"
          ? path.join(stagedProject, ".next", "static")
          : path.join(stagedProject, "public");
    const destination = path.join(artifactRoot, directory);
    // O Next standalone pode conter links absolutos para a árvore staged do pnpm.
    // O materializador abaixo copia os pacotes para aliases convencionais e remove
    // o grafo .pnpm antes de o staging ser apagado.
    cpSync(source, destination, { recursive: true, dereference: true });
  }

  const runtimeDependencyNames = materializeCustomerRuntimeDependencies({
    artifactRoot,
    stagedProjectRoot: stagedProject,
  });
  assertStandaloneHasNoSymlinks();
  const requiredPaths = [
    path.join("standalone", "server.js"),
    path.join("standalone", "node_modules", "next", "package.json"),
    path.join("standalone", ".next", "server", "app-paths-manifest.json"),
    ...runtimeDependencyNames.map((dependencyName) =>
      path.join("standalone", "node_modules", ...dependencyName.split("/"), "package.json"),
    ),
  ];
  for (const requiredPath of requiredPaths) {
    if (!existsSync(path.join(artifactRoot, requiredPath))) {
      throw new Error(`O artefato standalone customer está incompleto: ${requiredPath}`);
    }
  }
}

try {
  if (!existsSync(projectNodeModules))
    throw new Error("Dependências ausentes; instale o workspace antes do build de cliente.");
  if (inputOutputPath && existsSync(artifactRoot)) {
    throw new Error(
      "O diretório de saída já existe; escolha um destino vazio para não sobrescrever artefatos.",
    );
  }

  copyCustomerSource();
  installCustomerSourceReplacements();
  installCustomerRuntimeStubs();
  installCertificationTrustRoot();
  installCustomerDependencies();
  removeCustomerOperatorCommands();
  const nextCli = path.join(stagedProject, "node_modules", "next", "dist", "bin", "next");
  if (!existsSync(nextCli))
    throw new Error("Next.js não foi instalado na árvore isolada do cliente.");
  console.info(
    `Build de cliente: preservando /owner, suas APIs de tenant/usuários e /admin/license local; excluindo ${CUSTOMER_BUILD_EXCLUDED_PATHS.join(", ")}.`,
  );

  const build = spawnSync(process.execPath, [nextCli, "build", "--webpack"], {
    cwd: stagedProject,
    env: createBuildEnvironment(),
    stdio: "inherit",
  });
  if (build.error) throw build.error;
  if (build.status !== 0)
    throw new Error(`next build terminou com código ${build.status ?? "desconhecido"}.`);

  removeCustomerSourceMaps();
  assertCustomerBuildOutput();
  copyArtifact();
  console.info(`Build de cliente verificado. Artefato: ${artifactRoot}`);
} catch (error) {
  if (artifactWasCreatedHere && existsSync(artifactRoot))
    rmSync(artifactRoot, { recursive: true, force: true });
  const message = error instanceof Error ? error.message : "falha desconhecida no build de cliente";
  console.error(`Build de cliente recusado: ${message}`);
  process.exitCode = 1;
} finally {
  rmSync(workRoot, { recursive: true, force: true });
}
