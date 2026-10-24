import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

const RAIZ = process.cwd();
const publish = readFileSync(join(RAIZ, ".github/workflows/publish-image.yml"), "utf8");
const release = readFileSync(join(RAIZ, ".github/workflows/release.yml"), "utf8");
const common = readFileSync(join(RAIZ, "hostgator-setup-kit/_common.sh"), "utf8");
const composeLegado = readFileSync(join(RAIZ, "docker-compose.prod.yml"), "utf8");
const tagSoNasceDaMain = readFileSync(join(RAIZ, "tests/unit/tag-so-nasce-da-main.test.ts"), "utf8");
const packaging = readFileSync(join(RAIZ, "tests/unit/packaging-artefato-do-cliente.test.ts"), "utf8");
const manifestVerifier = readFileSync(join(RAIZ, "distribution/installer/verify-release-manifest.mjs"), "utf8");
const updater = readFileSync(join(RAIZ, "distribution/installer/release-update-transaction.mjs"), "utf8");
const installer = readFileSync(join(RAIZ, "distribution/installer/install.sh"), "utf8");
const installerCompose = readFileSync(join(RAIZ, "distribution/installer/compose.yaml"), "utf8");

function job(yml: string, nome: string): string {
  const linhas = yml.split("\n");
  const iJobs = linhas.findIndex((linha) => /^jobs:\s*$/.test(linha));
  if (iJobs === -1) return "";
  const inicio = linhas.findIndex((linha, i) => i > iJobs && linha === `  ${nome}:`);
  if (inicio === -1) return "";
  const fim = linhas.findIndex(
    (linha, i) => i > inicio && /^ {2}[A-Za-z0-9_-]+:\s*$/.test(linha),
  );
  return linhas.slice(inicio, fim === -1 ? undefined : fim).join("\n");
}

function palavrasDaLista(texto: string): string[] {
  return texto
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .sort();
}

function stringsDoArray(texto: string): string[] {
  return [...texto.matchAll(/["']([^"']+)["']/g)].map((match) => match[1]!).sort();
}

function imagensDaMatriz(yml = publish): string[] {
  const corpo = job(yml, "build-and-push");
  const bloco = /matrix:\s*\n\s+include:\s*\n([\s\S]*?)(?=\n {4}steps:)/.exec(corpo)?.[1] ?? "";
  return [...bloco.matchAll(/^\s*-\s+name:\s*([A-Za-z0-9._-]+)\s*$/gm)]
    .map((match) => match[1]!)
    .sort();
}

function imagensDoEixo(yml = publish): string[] {
  const corpo = job(yml, "build-and-push");
  const lista = /^ {8}name:\s*\[([^\]]+)\]\s*$/m.exec(corpo)?.[1] ?? "";
  return palavrasDaLista(lista.replaceAll(",", " "));
}

function listasDoGuardDeRelease(yml = release): string[][] {
  return [...yml.matchAll(/for\s+img\s+in\s+([^;\n]+);\s*do/g)]
    .map((match) => palavrasDaLista(match[1] ?? ""));
}

function imagensDoKit(): string[] {
  const corpo = /trio_publicado\(\)\s*\{([\s\S]*?)\n\}/.exec(common)?.[1] ?? "";
  const lista = /for\s+i\s+in\s+([^;]+);\s*do/.exec(corpo)?.[1] ?? "";
  return palavrasDaLista(lista);
}

function imagensDoComposeLegado(): string[] {
  return [...composeLegado.matchAll(/^\s+image:\s+\$\{[A-Z_]+:-ghcr\.io\/[^/]+\/(clientix-[a-z-]+):/gm)]
    .map((match) => match[1]!)
    .sort();
}

function imagensDoTesteDaTag(): string[] {
  const lista = /for\s*\(const\s+img\s+of\s+\[([^\]]+)\]\)/.exec(tagSoNasceDaMain)?.[1] ?? "";
  return stringsDoArray(lista);
}

function imagensDoTesteDePackaging(): string[] {
  const lista = /for\s*\(const\s+imagem\s+of\s+\[([^\]]+)\]\)/.exec(packaging)?.[1] ?? "";
  return stringsDoArray(lista);
}

function entradasDeRepositorios(source: string, declaration: string): Array<{ key: string; name: string }> {
  const corpo = new RegExp(`const ${declaration} = (?:Object\\.freeze\\()?\\{([\\s\\S]*?)\\n\\}\\)?;`).exec(source)?.[1] ?? "";
  return [...corpo.matchAll(/^\s*([A-Za-z0-9_]+):\s*["']([^"']+)["'],?\s*$/gm)]
    .map((match) => {
      const repo = match[2]!;
      return { key: match[1]!, name: repo.slice(repo.lastIndexOf("/") + 1) };
    });
}

function nomesDeRepositorios(source: string, declaration: string): string[] {
  return entradasDeRepositorios(source, declaration).map(({ name }) => name).sort();
}

function chavesDeArray(source: string, declaration: string): string[] {
  const corpo = new RegExp(`const ${declaration} = \\[([^\\]]*)\\]`).exec(source)?.[1] ?? "";
  return stringsDoArray(corpo);
}

function nomeDaImagemDoManifest(key: string): string {
  return key === "caddy" ? "clientix-ingress" : `clientix-${key.replaceAll("_", "-")}`;
}

const IMAGENS = imagensDaMatriz();

describe("listas de imagens Clientix seguem a matriz de publicação", () => {
  it("o instrumento encontra a matriz e detecta nomes duplicados", () => {
    expect(job(publish, "build-and-push"), "o job build-and-push sumiu").not.toBe("");
    expect(IMAGENS.length, "não consegui extrair imagens da matriz build-and-push").toBeGreaterThan(0);
    expect(new Set(IMAGENS).size, "a matriz contém nomes duplicados").toBe(IMAGENS.length);
    expect(imagensDoEixo(), "o eixo de nomes divergiu das receitas em include").toEqual(IMAGENS);
    expect(IMAGENS).toContain("clientix-ingress");
    expect(IMAGENS).toContain("clientix-migrator");
  });

  it("cada guard de release verifica exatamente todas as imagens publicadas", () => {
    const guards = listasDoGuardDeRelease();
    expect(guards, "os guards de release precisam cobrir espera e promoção").toHaveLength(2);
    for (const guard of guards) {
      expect(new Set(guard).size, "um guard de release contém imagem duplicada").toBe(guard.length);
      expect(guard).toEqual(IMAGENS);
    }
  });

  it("o kit legado confere exatamente os runtimes que seu compose usa", () => {
    expect(imagensDoKit(), "o guard do kit divergiu das imagens Clientix do compose legado")
      .toEqual(imagensDoComposeLegado());
    expect(imagensDoKit()).not.toContain("clientix-ingress");
    expect(imagensDoKit()).not.toContain("clientix-migrator");
  });

  it("as guards de tag e packaging usam exatamente a matriz completa", () => {
    expect(imagensDoTesteDaTag(), "tag-so-nasce-da-main divergiu da matriz").toEqual(IMAGENS);
    expect(imagensDoTesteDePackaging(), "packaging-artefato-do-cliente divergiu da matriz").toEqual(IMAGENS);
  });

  it("manifesto e updater permitem exatamente os repositórios das imagens publicadas", () => {
    const repositoriosManifesto = nomesDeRepositorios(manifestVerifier, "PRODUCTION_REPOSITORIES");
    const chavesManifesto = [
      ...chavesDeArray(manifestVerifier, "IMAGE_KEYS"),
      ...chavesDeArray(manifestVerifier, "OPTIONAL_IMAGE_KEYS"),
    ].map(nomeDaImagemDoManifest).sort();
    const repositoriosUpdater = nomesDeRepositorios(updater, "IMAGE_REPOSITORIES");
    const chavesUpdater = entradasDeRepositorios(updater, "IMAGE_REPOSITORIES")
      .map(({ key }) => nomeDaImagemDoManifest(key)).sort();

    expect(repositoriosManifesto).toEqual(IMAGENS);
    expect(chavesManifesto).toEqual(IMAGENS);
    expect(repositoriosUpdater).toEqual(IMAGENS);
    expect(chavesUpdater).toEqual(IMAGENS);
    expect(updater).toContain("const REQUIRED_IMAGE_KEYS = Object.keys(IMAGE_REPOSITORIES);");
  });

  it("o instalador usa o ingress assinado por digest e o updater o valida", () => {
    expect(manifestVerifier).toContain("!SHA256_RE.test(image.digest)");
    expect(installer).toContain('set_env_value CADDY_IMAGE "$VERIFIED_IMAGE_CADDY"');
    expect(installer).toContain("INGRESS_DNS_IMAGE_UNAVAILABLE");
    expect(installerCompose).toMatch(/image:\s*\$\{CADDY_IMAGE:-caddy:2\.11\.7-alpine@sha256:[a-f0-9]{64}\}/);
    expect(updater).toContain("@(sha256:[a-f0-9]{64})");
  });

  it("uma nova imagem na matriz fica visível como drift nos guards", () => {
    const sabotado = publish.replace(
      "          - name: clientix-ingress\n",
      "          - name: clientix-future\n            dockerfile: Dockerfile.future\n            title: Clientix future\n          - name: clientix-ingress\n",
    );
    expect(sabotado).not.toBe(publish);
    expect(imagensDaMatriz(sabotado)).not.toEqual(listasDoGuardDeRelease()[0]);
  });
});
