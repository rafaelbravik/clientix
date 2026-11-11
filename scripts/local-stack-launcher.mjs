import { existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
if (!args[0]) {
  process.stderr.write("Uso: local-stack-launcher.mjs {up|down|restart|status|logs|supabase-status|reset}\n");
  process.exit(2);
}

function resolveBash() {
  if (process.platform !== "win32") return "bash";
  const programFiles = process.env.ProgramFiles || "C:\\Program Files";
  const x86ProgramFiles = process.env["ProgramFiles(x86)"] || "C:\\Program Files (x86)";
  const candidates = [
    process.env.CLIENTIX_GIT_BASH_PATH,
    path.join(programFiles, "Git", "bin", "bash.exe"),
    path.join(x86ProgramFiles, "Git", "bin", "bash.exe"),
  ].filter(Boolean);
  return candidates.find((candidate) => candidate && existsSync(candidate)) ?? "bash";
}

const result = spawnSync(
  resolveBash(),
  ["-lc", 'exec bash scripts/local-stack.sh "$@"', "clientix-local-stack", ...args],
  {
  cwd: root,
  stdio: "inherit",
  windowsHide: true,
  },
);
if (result.error) {
  process.stderr.write("Não foi possível iniciar Bash. No Windows, instale Git for Windows e use o Git Bash.\n");
  process.exit(1);
}
process.exit(result.status ?? 1);
