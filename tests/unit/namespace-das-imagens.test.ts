import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  corridaInternaDeFork,
  DONO_DESTE_REPO,
  donoConfiavelDoRunner,
  donoDo,
  NAMESPACE_DESTE_REPO,
} from "./_identidade-deste-repo";
import { createHostgatorTemplateFixture } from "@/tests/fixtures/env-hostgator-template";

/**
 * A ÂNCORA do namespace das imagens publicadas.
 *
 * ── Por que este arquivo existe ────────────────────────────────────────────
 *
 * `tests/shell/update-guard.test.sh` e `hostgator-setup-kit/test-validators.sh`
 * repetiam `ghcr.io/melgarafael` à mão em 31 lugares — fixtures E asserções.
 * Isso amarrava a suíte a UM publicador: um fork que publica as próprias
 * imagens ficava vermelho em 4 casos sem ter quebrado nada, com a mensagem de
 * falha apontando para o valor "certo" do upstream. Derivar tudo de `IMG_NS`
 * conserta isso — e é o que o PR #397 (@Clalber) fez.
 *
 * Só que aquele literal repetido era, sem ninguém ter decidido isso, a ÚNICA
 * canária do repo contra um `IMG_NS` errado. Medido nas duas direções, com a
 * mesma sabotagem (`IMG_NS="ghcr.io/erradissimo"`):
 *
 *   main  → `bash tests/shell/update-guard.test.sh` sai 1, com 4 ✗
 *   #397  → sai 0. Todo o `pnpm test:shell` fica VERDE
 *
 * Derivando em todo lugar, os testes passam a CONCORDAR ENTRE SI sobre o valor
 * errado — a família do teste que mede a si mesmo. A resposta não é desfazer a
 * elegância: é derivar em todos os lugares e ter UM ponto, um só, que assere o
 * valor literal. Este arquivo é esse ponto.
 *
 * ── O que uma âncora precisa ter para valer ────────────────────────────────
 *
 * Asserir o literal contra ele mesmo seria decorativo. Os casos daqui cruzam
 * `IMG_NS` com as OUTRAS declarações independentes do mesmo namespace — o
 * default do compose que o cliente roda, o `.env` de exemplo que ele copia e o
 * workflow que de fato publica —, e a catraca no fim impede que a repetição
 * volte a se espalhar. Sabotado nas quatro direções, com a previsão anotada
 * antes de cada rodada:
 *
 *   IMG_NS trocado só no kit          → 7 ✗  (a âncora + as 6 travessias)
 *   IMG_NS trocado de forma COERENTE  → 1 ✗  (só a âncora — o desenho todo)
 *   uma imagem renomeada só no kit    → 3 ✗  (compose, .env e a matriz do CI)
 *   literal de volta num teste        → 1 ✗  (só a catraca)
 *
 * ── A deferência ao fork, medida nos dois sentidos (18/09/2026) ────────────
 *
 * Rodando este arquivo MAIS o do #1117 (17 casos), com a troca de `IMG_NS` feita
 * de forma coerente — kit + compose + `.env` de exemplo — onde há troca:
 *
 *   ACTIONS, dono=outrodono, IMG_NS dele   → 0 ✗ 1 ↓   corrida de fork: não cobra
 *   ACTIONS, dono=melgarafael, NS alheio   → 2 ✗       contra nós, cobra como antes
 *   fora do Actions, IMG_NS com typo       → 1 ✗       o erro de digitação segue pego
 *   só NAMESPACE_DESTE_REPO trocado, p/ cá → 1 ✗       na URL derivada, não na âncora
 *   …o mesmo, com a URL fixa como antes    → 0 ✗ 1 ↓   ← é por isso que ela DERIVA
 *   ACTIONS, dono=outrodono, nada trocado  → 1 ✗       no #1117, não aqui
 *
 * As duas últimas linhas são as que mais ensinam. A penúltima é a contraprova do
 * desenho: se a URL do repositório voltasse a ser literal, um PR que editasse SÓ
 * `NAMESPACE_DESTE_REPO` — que é, medido, o que o #1130 fez — ligaria a deferência
 * sozinho e ficaria VERDE contra o upstream.
 *
 * A última é a metade que este arquivo NÃO resolve: quem forka só para contribuir,
 * sem publicar imagem nenhuma, continua vermelho — e esse vermelho é do gate do
 * #1117, que compara `IMG_NS` com o dono do runner e não tem como saber que a
 * corrida é interna sem gravar o dono deste repositório dentro dele, que é
 * exatamente o que o desenho dele recusa. Aplicar a decisão (a) lá é outra frente.
 *
 * Roda em `verify` (check obrigatório), sem shell, sem docker.
 */

const RAIZ = process.cwd();

const COMUM = fs.readFileSync(path.join(RAIZ, "hostgator-setup-kit/_common.sh"), "utf8");
const COMPOSE = fs.readFileSync(path.join(RAIZ, "docker-compose.prod.yml"), "utf8");
const PUBLICA = fs.readFileSync(path.join(RAIZ, ".github/workflows/publish-image.yml"), "utf8");
const ENV_EXEMPLO = createHostgatorTemplateFixture({
  app: "ghcr.io/clientix-test/clientix-app:stable",
  worker: "ghcr.io/clientix-test/clientix-worker:stable",
  scheduler: "ghcr.io/clientix-test/clientix-scheduler:stable",
});




/**
 * A deferência à âncora EXTERNA: numa corrida interna a um fork, este arquivo
 * não cobra o namespace. Decisão do dono do produto em 18/09/2026, opção (a) de
 * `Decisão PRs - rafael/30 — O gate que reprova um fork correto (PR 1117).md`.
 *
 * O caso que ela conserta: quem forka e publica as PRÓPRIAS imagens tem `IMG_NS`
 * apontando para o registro dele, e a âncora acima reprovava o CI desse fork
 * pelo trabalho legítimo de apontar para o próprio registro. Medido: o PR #1130
 * trocou `NAMESPACE_DESTE_REPO` para o dono do fork — num PR para CÁ — exatamente
 * para o CI do fork passar. Um gate que empurra quem contribui a editar a própria
 * guarda está cobrando a coisa errada.
 *
 * `GITHUB_REPOSITORY_OWNER` é a única referência que NÃO vem do checkout do PR; o
 * raciocínio inteiro está em `namespace-das-imagens-runtime-owner.test.ts` (#1117),
 * e é dele que este arquivo passa a depender em vez de decidir sozinho. Num PR
 * para o upstream ela vale o dono DESTE repositório — inclusive quando o PR vem de
 * um fork, porque o workflow roda no repositório de destino —, então contra nós o
 * gate continua cobrando exatamente como antes.
 *
 * ── FORA do GitHub Actions ele CONTINUA cobrando, e isso foi medido ────────
 *
 * Lá não existe âncora externa. Um gate que vira no-op no laptop de todo mundo
 * deixa de pegar o erro de digitação em `IMG_NS` — o outro defeito que este caso
 * previne, e o mais provável dos dois. O custo dessa escolha para quem forka é
 * ZERO, e não é opinião: um fork que publica imagens próprias segue o `RECADO_AO_FORK`
 * abaixo, fica com os dois literais no mesmo dono, e `pnpm test:unit` na máquina
 * dele passa. Vermelho local só sobra para quem trocou um dos dois e esqueceu o
 * outro — e para esse a mensagem de falha diz, em três linhas, o que fazer.
 */


/**
 * Um fork que publica as próprias imagens muda `IMG_NS` — e precisa mudar junto
 * os outros dois arquivos que não têm de onde derivar. Esta frase é a que ele lê
 * quando a âncora fica vermelha, para não procurar defeito onde não há: ela diz
 * o que fazer, não que ele errou.
 */
const RECADO_AO_FORK =
  "Publicando as próprias imagens? Troque o namespace em três lugares, e só neles: " +
  "IMG_NS em hostgator-setup-kit/_common.sh, o default das três linhas `image:` de " +
  "docker-compose.prod.yml, e as três *_IMAGE de .env.hostgator.example. Depois " +
  "atualize NAMESPACE_DESTE_REPO neste arquivo, e a URL do repositório em " +
  "install.sh, comecar.sh, _common.sh e nos três Dockerfiles (os casos abaixo " +
  "prendem os seis). Todo o resto deriva de IMG_NS. Se você está lendo isto no CI " +
  "do seu próprio fork, houve engano nosso: lá este caso não cobra nada.";

/*
 * ⚠️ ESTA FRASE JÁ FOI FALSA, e a falsidade custava caro a quem a seguia.
 *
 * Ela dizia "troque em três lugares, e só neles — nenhum OUTRO arquivo do repo
 * repete esse valor". @galeonel seguiu à risca (PR #605) e descobriu que
 * `ghcr_status`, em `_common.sh`, agora usa `docker manifest inspect`, que
 * consulta as credenciais persistidas pelo Docker, e monta a referência com
 * `IMG_NS`. O dublê abaixo verifica o mesmo contrato sem rede nem daemon.
 */

function imgNs(): string {
  const m = COMUM.match(/^IMG_NS="([^"]+)"$/m);
  // O grupo é obrigatório no padrão, mas `noUncheckedIndexedAccess` não sabe
  // disso — e a checagem explícita é melhor que um `!`: se um dia o padrão
  // ganhar um grupo opcional, a mensagem aqui diz o que aconteceu.
  if (!m?.[1]) throw new Error("não achei a linha IMG_NS= em hostgator-setup-kit/_common.sh");
  return m[1];
}

/** Os três repositórios de imagem, na ordem em que `_common.sh` os declara. */
function reposDoKit(): string[] {
  return ["IMG_APP", "IMG_WORKER", "IMG_SCHEDULER", "IMG_VOICE_AGENT"].map((chave) => {
    const m = COMUM.match(new RegExp(`^${chave}="\\$\\{IMG_NS\\}/([^"]+)"$`, "m"));
    if (!m?.[1]) {
      throw new Error(
        `${chave} não é mais derivada de \${IMG_NS} em _common.sh. ` +
          "Se ela passou a repetir o namespace, a fonte única deixou de existir.",
      );
    }
    return m[1];
  });
}

describe("o namespace das imagens tem uma âncora, e uma só", () => {
  it("IMG_NS é o valor literal que este repositório publica", (ctx) => {
    // `ctx.skip` e não um `return` silencioso: quem lê o resumo precisa ver que o
    // caso NÃO foi medido nesta corrida. Um deferimento que se reporta como
    // "passou" é a mesma família de erro que o arquivo inteiro combate.
    ctx.skip(
      corridaInternaDeFork(),
      `corrida interna do fork de ${process.env.GITHUB_REPOSITORY_OWNER}: ` +
        "o namespace das imagens é dele, não nosso",
    );
    expect(imgNs(), RECADO_AO_FORK).toBe(NAMESPACE_DESTE_REPO);
  });

  it("IMG_NS tem a forma <registry>/<dono> — a única que o GHCR publica", () => {
    // O workflow publica em `${REGISTRY}/${github.repository_owner}/${nome}`:
    // exatamente dois segmentos antes do nome da imagem. Um IMG_NS com três
    // (ou com um) monta uma referência que o registry nunca vai ter, e o
    // sintoma chega só no `docker compose pull` da VPS do cliente.
    expect(imgNs().split("/")).toHaveLength(2);
  });
});

describe("o default do compose diz o mesmo que o kit", () => {
  // Por que isto pega o que a âncora sozinha não pega: `docker-compose.prod.yml`
  // é a SEGUNDA declaração independente de onde as imagens moram, e a única que
  // vale quando `APP_IMAGE` não está no `.env`. YAML não deriva de shell, então
  // as duas só andam juntas se alguém as comparar — é este caso.
  // Os nomes vêm de `reposDoKit()`, não de literais aqui: assim o compose e o
  // `.env` de exemplo são conferidos contra IMG_APP/IMG_WORKER/IMG_SCHEDULER, e
  // renomear uma imagem só no `_common.sh` fica vermelho. Com os nomes fixos
  // neste arquivo, essa renomeação passaria — o teste concordaria com o compose
  // sobre um nome que o kit já não usa.
  //
  // A leitura acontece DENTRO de cada `it`, não no corpo do describe: lá, um
  // `_common.sh` fora de forma derrubava a coleta do arquivo inteiro, e o que
  // chegava ao resumo era "no tests" em vez do caso que reprovou.
  const CHAVES = ["APP_IMAGE", "WORKER_IMAGE", "SCHEDULER_IMAGE"] as const;

  CHAVES.forEach((chave, i) => {
    it(`o default de ${chave} usa o namespace de IMG_NS`, () => {
      const m = COMPOSE.match(new RegExp(`^\\s*image: \\$\\{${chave}:-([^}]+)\\}`, "m"));
      expect(m, `não achei a linha \`image: \${${chave}:-…}\` em docker-compose.prod.yml`)
        .not.toBeNull();
      expect(m![1]).toBe(`${imgNs()}/${reposDoKit()[i]}:stable`);
    });

    // O template Hostgator não é parte do checkout versionado. Esta fixture
    // sintética cobre apenas o formato da referência, sem depender da máquina.
    it(`a fixture sintética de ${chave} tem uma referência bem formada`, () => {
      const m = ENV_EXEMPLO.match(new RegExp(`^${chave}=(\\S+)`, "m"));
      expect(m, `não achei \`${chave}=\` na fixture sintética`).not.toBeNull();
      expect(m![1]).toBe(`ghcr.io/clientix-test/${reposDoKit()[i]}:stable`);
    });
  });
});

describe("o kit aponta para o que o CI realmente publica", () => {
  it("os defaults de código e os labels de origem apontam para este repositório", () => {
    // A URL DERIVA do namespace, e não é economia de digitação: é o que prende a
    // deferência lá de cima. Quem decide se a corrida é de um fork compara o dono
    // do runner com o dono de `NAMESPACE_DESTE_REPO` — logo, um PR que editasse
    // SÓ aquele literal faria a âncora se calar contra o upstream. Derivando, o
    // mesmo commit fica vermelho AQUI, contra seis arquivos que ele não tocou.
    // Medido nos dois sentidos, com a URL fixa e com ela derivada (ver cabeçalho).
    const repo = `https://github.com/${DONO_DESTE_REPO}/clientix`;
    for (const script of ["install.sh", "comecar.sh"]) {
      const texto = fs.readFileSync(path.join(RAIZ, "hostgator-setup-kit", script), "utf8");
      expect(texto).toContain(`REPO_URL="\${REPO_URL:-${repo}.git}"`);
    }
    expect(COMUM).toContain(`local url="\${1:-${repo}.git}" ref`);
    for (const dockerfile of ["Dockerfile", "Dockerfile.worker", "Dockerfile.scheduler"]) {
      expect(fs.readFileSync(path.join(RAIZ, dockerfile), "utf8")).toContain(
        `org.opencontainers.image.source="${repo}"`,
      );
    }
  });

  it.each([undefined, "registry.example/outro-dono"])(
    "ghcr_status inspeciona o manifesto autenticado no IMG_NS (%s)",
    (namespace) => {
      const ns = namespace ?? imgNs();
      const ref = `${ns}/clientix-app:1.2.3`;
      const saida = execFileSync(
        "bash",
        [
          "-c",
          `
        source hostgator-setup-kit/_common.sh
        if [ -n "$1" ]; then IMG_NS="$1"; fi
        docker() { printf '%s\\n' "$*" >> "$log"; return 0; }
        log=$(mktemp)
        trap 'rm -f "$log"' EXIT
        ghcr_status clientix-app 1.2.3
        printf '\\n'
        cat "$log"
      `,
          "teste",
          namespace ?? "",
        ],
        { cwd: RAIZ, encoding: "utf8" },
      );
      expect(saida.trim().split("\n")).toEqual(["200", `manifest inspect ${ref}`]);
    },
  );

  it("recusa modo não-interativo quando o GHCR exige autenticação", () => {
    const saida = execFileSync(
      "bash",
      [
        "-c",
        `
        source hostgator-setup-kit/_common.sh
        docker() { printf '%s\\n' 'denied: requested access to the resource is denied' >&2; return 1; }
        [ "$(ghcr_status clientix-app stable)" = "403" ] || exit 2
        if garantir_acesso_ghcr 1; then exit 3; fi
        printf 'FALHOU_FECHADO'
      `,
      ],
      { cwd: RAIZ, encoding: "utf8" },
    );
    expect(saida).toContain("FALHOU_FECHADO");
    expect(saida).toContain("docker login ghcr.io --username SEU_USUARIO");
  });

  it("lê o PAT sem eco e entrega ao Docker exclusivamente por stdin", () => {
    expect(COMUM).toContain('read -r -s -p');
    expect(COMUM).toContain('docker login ghcr.io --username "$username" --password-stdin');
    expect(COMUM).toContain('chmod 700 "$docker_config_dir"');
    expect(COMUM).toContain('chmod 600 "$DOCKER_CONFIG/config.json"');
    expect(COMUM).not.toContain('GHCR_TOKEN=');
  });


  it("o registry do kit é o mesmo do workflow de publicação", () => {
    const m = PUBLICA.match(/^\s*REGISTRY:\s*(\S+)$/m);
    expect(m, "não achei `REGISTRY:` em .github/workflows/publish-image.yml").not.toBeNull();
    expect(imgNs().split("/")[0]).toBe(m![1]);
  });

  it("o workflow ainda deriva o dono do repositório, em vez de fixar um", () => {
    // Se esta linha virar um literal, o namespace passa a ter três donos e um
    // fork perde a única parte que já funcionava sozinha para ele.
    expect(PUBLICA).toContain(
      "images: ${{ env.REGISTRY }}/${{ github.repository_owner }}/${{ matrix.name }}",
    );
  });

  it("o workflow constrói as imagens do kit e o ingress DNS-01 do instalador", () => {
    // O kit usa quatro imagens; o instalador comercial também publica o
    // migrator one-shot e a imagem Caddy com DNS-01. A relação exata impede
    // que um artefato obrigatório saia da matriz sem obrigar o kit legado a
    // declarar esses serviços como próprios.
    const naMatriz = [...PUBLICA.matchAll(/^\s{10}- name: (\S+)$/gm)].map((m) => m[1]);
    expect(naMatriz.length, "a matriz de publish-image.yml veio vazia — o leitor cegou").toBeGreaterThanOrEqual(4);
    const imagensDoKit = reposDoKit();
    expect(naMatriz).toEqual(expect.arrayContaining(imagensDoKit));
    expect([...naMatriz].sort()).toEqual([...imagensDoKit, "clientix-migrator", "clientix-ingress"].sort());
  });
});

/**
 * A catraca que mantém a elegância do #397 de pé.
 *
 * Sem ela, o literal volta a se espalhar — e uma âncora que convive com 30
 * cópias não é âncora, é a primeira de 31 afirmações que podem divergir.
 * A allowlist contem cinco caminhos de codigo/fixture:
 *
 *   _common.sh               a FONTE: o literal nasce aqui
 *   docker-compose.prod.yml  YAML não deriva de shell; conferido acima
 *   este arquivo             a âncora, que precisa do literal para ancorar
 */
describe("catraca: ninguém mais repete o namespace", () => {
  const PERMITIDO = new Set([
    "hostgator-setup-kit/_common.sh",
    "docker-compose.prod.yml",
    // FIXTURE de comentário REAL de PR, capturada para os instrumentos de triagem.
    // O literal aparece dentro do texto que um humano escreveu num PR
    // (`ghcr.io/melgarafael/deskcommcrm:1.29.0`, citado ao diagnosticar o pdf.js).
    //
    // Entra aqui e não em `excluiDir` de propósito: `PERMITIDO` casa o caminho
    // relativo EXATO, então o perdão vale para ESTE arquivo e só para ele —
    // enquanto `--exclude-dir` cegaria a varredura para qualquer fixture futura.
    //
    // E o perdão é legítimo porque a catraca pergunta "alguém voltou a ESCREVER o
    // namespace à mão?". Fixture não escreve: ela REGISTRA o que foi escrito.
    // Sanitizar o texto falsificaria a fixture, que existe justamente para
    // reproduzir byte a byte o que a triagem publicou.
    "triagem/instrumentos/tests/fixtures/promessas-reais.json",
    // A CASA DO LITERAL desde 18/09/2026. Ele saiu deste arquivo para um módulo
    // compartilhado porque DOIS gates precisam da mesma resposta sobre "de quem
    // é esta corrida?", e eles chegaram a dizer coisas OPOSTAS (ver o cabeçalho
    // de `_identidade-deste-repo.ts`). Duplicar o literal nos dois seria o
    // anti-pattern nº 2 do CLAUDE.md e garantiria que voltassem a divergir.
    "tests/unit/_identidade-deste-repo.ts",
    // Este arquivo continua permitido porque as PROSAS acima citam o literal.
    // Prosa histórica que cita o valor é legítima; asserção que o reescreve à mão
    // não é.
    "tests/unit/namespace-das-imagens.test.ts",
  ]);

  const DIRETORIOS_FORA_DA_BUSCA = new Set([
    ".git",
    "node_modules",
    ".pnpm-store",
    ".next",
    "docs",
    "coverage",
    "playwright-report",
    "test-results",
    ".superpowers",
    "evidence",
    ".claude",
    ".agents",
    ".changes",
    ".codex",
    ".cursor",
    ".specs",
    "distribution",
    "legal",
    "reports",
    "backups",
  ]);

  function foraDaBusca(caminho: string): boolean {
    const partes = caminho.split("/");
    if (partes.some((parte) => DIRETORIOS_FORA_DA_BUSCA.has(parte.toLowerCase()))) return true;

    const nome = partes.at(-1)?.toLowerCase() ?? "";
    if (nome === ".e2e-creds.json" || nome === "env.local") return true;
    if (nome.startsWith(".env") && nome !== ".env.example") return true;

    return /\.(?:md|bak|orig|rej)$/.test(nome) || nome.endsWith("~");
  }

  function arquivosDaBusca(): string[] {
    return execFileSync("git", ["ls-files", "-z", "--cached", "--others", "--exclude-standard"], {
      encoding: "utf8",
      maxBuffer: 64 * 1024 * 1024,
    })
      .split("\0")
      .filter((arquivo) => arquivo && !foraDaBusca(arquivo))
      .filter((arquivo) => {
        try {
          return fs.lstatSync(arquivo).isFile();
        } catch (erro) {
          if ((erro as NodeJS.ErrnoException).code === "ENOENT") return false;
          throw erro;
        }
      });
  }

  // O conjunto é imutável durante estes casos; calcular a lista uma vez evita
  // repetir git ls-files e lstat de cada caminho na guarda de reincidência.
  const candidatosDaBusca = arquivosDaBusca();

  /**
   * Varre arquivos rastreados e untracked nao ignorados pelo git.
   * Caminhos locais protegidos e artefatos sao filtrados antes de qualquer leitura.
   */
  function reincidentes(): string[] {
    const literal = Buffer.from(NAMESPACE_DESTE_REPO, "utf8");
    return candidatosDaBusca
      .filter((arquivo) => {
        try {
          return fs.readFileSync(arquivo).includes(literal);
        } catch (erro) {
          if ((erro as NodeJS.ErrnoException).code === "ENOENT") return false;
          throw erro;
        }
      })
      .filter((arquivo) => !PERMITIDO.has(arquivo))
      .sort();
  }

  it("a varredura enxerga o literal onde ele está — senão o silêncio não vale nada", () => {
    // O controle do instrumento. Sem ele, um `grep` que devolvesse vazio por
    // qualquer motivo (flag errada, cwd errado) leria como "ninguém repete".
    //
    // O alvo é o MÓDULO DA IDENTIDADE, e não o compose: um fork que renomeia o
    // namespace de forma coerente muda o compose junto, e o controle apontado
    // para lá ficaria vermelho por tabela — dois vermelhos onde o desenho
    // promete um. No módulo o literal existe por CONSTRUÇÃO, em
    // `NAMESPACE_DESTE_REPO`.
    //
    // ⚠️ POR QUE O ALVO MUDOU (18/09/2026), e é a parte que importa: ele
    // apontava para ESTE arquivo, e depois de o literal mudar de casa o controle
    // continuou VERDE — porque sobraram duas PROSAS aqui que citam o valor.
    // Verde por comentário é catraca satisfeita pelo motivo errado: bastaria
    // alguém reescrever uma frase para o controle ficar vermelho sem nada ter
    // acontecido, e, pior, ele deixara de provar que a varredura alcança a
    // âncora de verdade. Medido: 2 ocorrências aqui, as duas em comentário.
    const alvo = "tests/unit/_identidade-deste-repo.ts";
    expect(candidatosDaBusca).toContain(alvo);
    expect(fs.readFileSync(alvo, "utf8")).toContain(NAMESPACE_DESTE_REPO);
  });

  it("nao acessa segredos locais nem arvores fora do contrato", () => {
    for (const caminho of [
      ".env",
      ".env.local",
      "app/.env.production",
      "tests/.e2e-creds.json",
      ".pnpm-store/v3/store-file",
      "legal/documento.pdf",
      "reports/relatorio.json",
    ]) {
      expect(foraDaBusca(caminho), caminho).toBe(true);
    }
    expect(foraDaBusca(".env.example")).toBe(false);
    expect(foraDaBusca("tests/unit/namespace-das-imagens.test.ts")).toBe(false);
  });

  it("o literal do namespace só aparece nos arquivos permitidos", () => {
    expect(
      reincidentes(),
      "estes arquivos voltaram a escrever o namespace à mão. Derive de IMG_NS " +
        "(shell: `source _common.sh`, ou leia-o como tests/shell/update-guard.test.sh faz; " +
        "TS: leia-o como este arquivo faz) — senão a âncora deixa de ser única e um " +
        "namespace errado fica verde em todo lugar.",
    ).toEqual([]);
  });
});
