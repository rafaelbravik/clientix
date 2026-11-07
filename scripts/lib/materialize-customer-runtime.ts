import {
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
} from "node:fs";
import path from "node:path";

interface PackageManifest {
  name?: string;
  version?: string;
  dependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
}

interface MaterializeCustomerRuntimeOptions {
  artifactRoot: string;
  stagedProjectRoot: string;
}

interface RuntimePackage {
  source: string;
  destination: string;
}

/**
 * Resolves pnpm's isolated package graph into a self-contained standalone tree.
 * Next's file trace can include package contents while omitting aliases and
 * nested dependency links when the customer artifact is staged on Windows.
 */
export function materializeCustomerRuntimeDependencies({
  artifactRoot,
  stagedProjectRoot,
}: MaterializeCustomerRuntimeOptions): string[] {
  const standaloneRoot = path.join(artifactRoot, "standalone");
  const standaloneModules = path.join(standaloneRoot, "node_modules");
  const pnpmModules = path.join(standaloneModules, ".pnpm");
  const customerManifest = readManifest(path.join(stagedProjectRoot, "package.json"));
  const stagedModules = path.join(stagedProjectRoot, "node_modules");
  const nextSource = resolvePackageSource("next", stagedModules);
  if (!nextSource)
    throw new Error("O standalone customer não contém Next.js nas dependências staged.");
  const canonicalNextRoot = canonicalPackageRoot(realpathSync(nextSource), stagedProjectRoot);
  const nextManifest = readManifest(path.join(canonicalNextRoot, "package.json"));
  const nextPackageModules = nearestNodeModules(canonicalNextRoot);
  const runtimeNames = [
    ...new Set([
      ...Object.keys(customerManifest.dependencies ?? {}),
      ...Object.keys(nextManifest.dependencies ?? {}),
    ]),
  ];

  const queue: RuntimePackage[] = [];
  for (const name of runtimeNames) {
    const source = resolvePackageSource(name, stagedModules, nextPackageModules);
    if (!source) throw new Error(`Dependência runtime do Customer não foi traceada: ${name}.`);
    const destination = path.join(standaloneModules, ...name.split("/"));
    ensurePackageCopy(source, destination);
    queue.push({ source, destination });
  }

  const visited = new Set<string>();
  while (queue.length > 0) {
    const current = queue.shift();
    if (!current) continue;
    const sourceRoot = canonicalPackageRoot(realpathSync(current.source), stagedProjectRoot);
    const visitKey = `${sourceRoot}|${current.destination}`;
    if (visited.has(visitKey)) continue;
    visited.add(visitKey);

    const manifest = readManifest(path.join(sourceRoot, "package.json"));
    const dependencyNames = [
      ...new Set([
        ...Object.keys(manifest.dependencies ?? {}),
        ...Object.keys(manifest.optionalDependencies ?? {}),
        ...Object.keys(manifest.peerDependencies ?? {}),
      ]),
    ];
    const sourceNodeModules = nearestNodeModules(sourceRoot);

    for (const dependencyName of dependencyNames) {
      const source = resolvePackageSource(
        dependencyName,
        sourceNodeModules,
        stagedModules,
        nextPackageModules,
      );
      if (!source) {
        if (
          manifest.optionalDependencies?.[dependencyName] !== undefined ||
          manifest.peerDependencies?.[dependencyName] !== undefined
        ) {
          continue;
        }
        throw new Error(
          `Dependência de ${manifest.name ?? current.destination} não foi traceada: ${dependencyName}.`,
        );
      }

      const sourceManifest = readManifest(path.join(source, "package.json"));
      const existing = resolvePackageDestination(
        current.destination,
        dependencyName,
        standaloneRoot,
      );
      let destination = existing;
      if (
        !destination ||
        readManifest(path.join(destination, "package.json")).version !== sourceManifest.version
      ) {
        destination = path.join(current.destination, "node_modules", ...dependencyName.split("/"));
        const presentManifest = readMaterializedPackageManifest(destination);
        if (presentManifest) {
          const presentVersion = presentManifest.version;
          if (presentVersion !== sourceManifest.version) {
            throw new Error(
              `Versões runtime incompatíveis para ${dependencyName}: ${presentVersion ?? "desconhecida"} e ${sourceManifest.version ?? "desconhecida"}.`,
            );
          }
        }
        ensurePackageCopy(source, destination);
      }
      queue.push({ source, destination });
    }
  }

  for (const name of runtimeNames) {
    const destination = path.join(standaloneModules, ...name.split("/"));
    if (!readMaterializedPackageManifest(destination)) {
      throw new Error(`Alias runtime do Customer incompleto: ${name}.`);
    }
  }

  // O .pnpm do output standalone contém aliases absolutos para a árvore staged.
  // Os pacotes necessários já foram materializados nos aliases convencionais acima.
  rmSync(pnpmModules, { recursive: true, force: true });
  return runtimeNames;
}

function resolvePackageSource(name: string, ...nodeModulesRoots: string[]): string | null {
  for (const root of nodeModulesRoots) {
    const candidate = path.join(root, ...name.split("/"));
    if (existsSync(path.join(candidate, "package.json"))) return realpathSync(candidate);
  }
  return null;
}

function resolvePackageDestination(
  packageDestination: string,
  dependencyName: string,
  standaloneRoot: string,
): string | null {
  const parts = dependencyName.split("/");
  let directory = packageDestination;
  while (directory === standaloneRoot || directory.startsWith(`${standaloneRoot}${path.sep}`)) {
    const candidate = path.join(directory, "node_modules", ...parts);
    if (readMaterializedPackageManifest(candidate)) return candidate;
    if (directory === standaloneRoot) break;
    directory = path.dirname(directory);
  }
  return null;
}

function nearestNodeModules(packageRoot: string): string {
  let directory = realpathSync(packageRoot);
  while (directory !== path.dirname(directory)) {
    if (path.basename(directory) === "node_modules") return directory;
    directory = path.dirname(directory);
  }
  throw new Error(`Não foi possível localizar node_modules para ${packageRoot}.`);
}

function canonicalPackageRoot(packageRoot: string, stagedProjectRoot: string): string {
  const manifest = readManifest(path.join(packageRoot, "package.json"));
  if (!manifest.name || !manifest.version) return packageRoot;
  const packageStore = path.join(stagedProjectRoot, "node_modules", ".pnpm");
  if (!existsSync(packageStore)) return packageRoot;
  const packagePrefix = `${manifest.name.replaceAll("/", "+")}@${manifest.version}`;
  for (const entry of readdirDirectories(packageStore)) {
    if (!entry.startsWith(packagePrefix)) continue;
    const candidate = path.join(packageStore, entry, "node_modules", ...manifest.name.split("/"));
    if (!existsSync(path.join(candidate, "package.json"))) continue;
    if (readManifest(path.join(candidate, "package.json")).version === manifest.version) {
      return realpathSync(candidate);
    }
  }
  return packageRoot;
}

function ensurePackageCopy(source: string, destination: string): void {
  const sourceManifest = readManifest(path.join(source, "package.json"));
  const destinationManifest = readMaterializedPackageManifest(destination);
  if (destinationManifest?.version === sourceManifest.version) return;

  if (existsSync(destination) || isSymbolicLink(destination)) {
    rmSync(destination, { recursive: true, force: true });
  }
  mkdirSync(path.dirname(destination), { recursive: true });
  cpSync(realpathSync(source), destination, { recursive: true, dereference: true });
}

function readMaterializedPackageManifest(directory: string): PackageManifest | null {
  if (!isMaterializedDirectory(directory)) return null;
  const manifestPath = path.join(directory, "package.json");
  if (!existsSync(manifestPath)) return null;
  return readManifest(manifestPath);
}

function isMaterializedDirectory(directory: string): boolean {
  try {
    return lstatSync(directory).isDirectory();
  } catch {
    return false;
  }
}

function isSymbolicLink(pathname: string): boolean {
  try {
    return lstatSync(pathname).isSymbolicLink();
  } catch {
    return false;
  }
}

function readManifest(pathname: string): PackageManifest {
  return JSON.parse(readFileSync(pathname, "utf8")) as PackageManifest;
}

function readdirDirectories(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name);
}
