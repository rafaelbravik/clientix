import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

describe("Resolução de release para repositório privado e padrão de tags", () => {
  const commonSh = readFileSync(join(process.cwd(), "hostgator-setup-kit/_common.sh"), "utf8");
  const conferirSh = readFileSync(join(process.cwd(), "scripts/conferir-isolamento-do-kit.sh"), "utf8");
  const ciWorkflow = readFileSync(join(process.cwd(), ".github/workflows/ci.yml"), "utf8");

  it("hostgator-setup-kit/_common.sh suporta GITHUB_TOKEN/GH_TOKEN na autenticação da API", () => {
    expect(commonSh).toContain('token="${GITHUB_TOKEN:-${GH_TOKEN:-}}"');
    expect(commonSh).toContain('auth_args=(-H "Authorization: Bearer $token" -H "X-GitHub-Api-Version: 2022-11-28")');
    expect(commonSh).toContain('"${auth_args[@]}"');
  });

  it("hostgator-setup-kit/_common.sh aceita tanto tags v* quanto clientix-*", () => {
    expect(commonSh).toContain("v[0-9]*|clientix-[0-9]*)");
  });

  it("hostgator-setup-kit/_common.sh faz fallback para tags locais se fora do GitHub ou sem release na API", () => {
    expect(commonSh).toContain("git tag -l 'clientix-*' 'v*' --sort=-v:refname | head -1");
  });

  it("scripts/conferir-isolamento-do-kit.sh respeita CONFERENCIA_KIT_RELEASE explícita primeiro", () => {
    expect(conferirSh).toContain('release="${CONFERENCIA_KIT_RELEASE:-}"');
  });

  it("scripts/conferir-isolamento-do-kit.sh passa token de autenticação para gh release view e ultima_release_estavel", () => {
    expect(conferirSh).toContain('GH_TOKEN="${GH_TOKEN:-${GITHUB_TOKEN:-}}" gh release view');
    expect(conferirSh).toContain('GITHUB_TOKEN="${GITHUB_TOKEN:-${GH_TOKEN:-}}"');
  });

  it("scripts/conferir-isolamento-do-kit.sh possui fallback para tags Git locais quando a API de releases não possui releases", () => {
    expect(conferirSh).toContain("git -C \"$ROOT\" tag -l 'clientix-*' 'v*' --sort=-v:refname | head -1");
  });

  it("scripts/conferir-isolamento-do-kit.sh possui fallback para tags Git remotas via ls-remote em checkouts rasos", () => {
    expect(conferirSh).toContain("git -C \"$ROOT\" ls-remote --tags origin 'refs/tags/clientix-*' 'refs/tags/v*'");
  });

  it("scripts/conferir-isolamento-do-kit.sh valida formato v* e clientix-* e recusa formatos inválidos", () => {
    expect(conferirSh).toContain("v[0-9]*|clientix-[0-9]*) ;;");
    expect(conferirSh).toContain("FATAL: não consegui saber qual é a última release publicada");
  });

  it("CI preserva tags no checkout raso e expõe diagnóstico sanitizado da resolução", () => {
    expect(ciWorkflow).toContain("fetch-tags: true");
    expect(ciWorkflow).toContain('DESKCOMM_RELEASE_DIAGNOSTICS: "1"');
    expect(commonSh).toContain("http_status=%s tag=%s");
  });
});
