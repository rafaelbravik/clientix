// Em ambiente Windows, garantir que utilitários unix (bash, sed, grep) do Git estejam no PATH
if (process.platform === "win32") {
  const gitBin = "C:\\Program Files\\Git\\bin";
  const gitUsrBin = "C:\\Program Files\\Git\\usr\\bin";
  if (!process.env.PATH?.includes("Git\\usr\\bin")) {
    process.env.PATH = `${gitBin};${gitUsrBin};${process.env.PATH || ""}`;
  }
}

/**
 * Ambiente hermético para os testes unitários.
 *
 * A suíte não carrega `.env`, `.env.local` nem credenciais do operador. `lib/env.ts`
 * recebe valores sintéticos antes da importação de módulos da aplicação, e
 * testes que exercitam outras configurações devem defini-las explicitamente.
 *
 * NODE_ENV é definido antes dos imports para que uma variável herdada da máquina
 * não ative validação de produção e exija segredos reais durante os testes.
 * O host `.invalid` é reservado por RFC 2606 e o fetch logo abaixo o recusa.
 */
const URL_DO_PLACEHOLDER = "https://test-placeholder.invalid";
const PLACEHOLDERS: Record<string, string> = {
  NEXT_PUBLIC_SUPABASE_URL: URL_DO_PLACEHOLDER,
  NEXT_PUBLIC_SUPABASE_ANON_KEY: "test-placeholder-anon-key",
  SUPABASE_SERVICE_ROLE_KEY: "test-placeholder-service-role-key",
  // Cria somente um pool local sintético; testes nunca usam credenciais do
  // operador nem conectam ao banco. Casos que provam ausência removem a env.
  SUPABASE_DB_URL: "postgresql://test_user:test_password@127.0.0.1:5432/test_db",
};
if (!Reflect.set(process.env, "NODE_ENV", "test")) {
  throw new Error("Não foi possível fixar NODE_ENV=test no ambiente hermético do Vitest.");
}
for (const [chave, valor] of Object.entries(PLACEHOLDERS)) {
  process.env[chave] = valor;
}

/**
 * O placeholder falha NA HORA — sem perguntar ao DNS.
 *
 * "Falha alto" (acima) valia para o resultado, não para o RELÓGIO: `.invalid`
 * reprova, mas só quando o resolvedor responde, e isso é tempo de rede. Quem
 * chega aqui por um caminho fire-and-forget — `void audit(...)` nos handlers —
 * não é esperado por teste nenhum: o arquivo termina, e o `console.error` do
 * `reportAuditFailure` (lib/audit/index.ts) cai depois, às vezes BEM na hora em
 * que o vitest fecha o canal do worker. Aí a suíte inteira reprova com todos os
 * arquivos verdes:
 *
 *     EnvironmentTeardownError: [vitest-worker]: Closing rpc while
 *     "onUserConsoleLog" was pending
 *     This error originated in "tests/unit/desfecho-de-agenda-e-sobre-o-passado.test.ts"
 *
 * Medido de 15 a 22/09/2026: 10 runs vermelhos assim, em 8 PRs e 2 pushes da
 * `main` (ex.: runs 35111447270, 35165421158), sempre no FIM da suíte unitária —
 * o `verify` que "falha depois de 10 min" sem teste nenhum vermelho.
 *
 * Recusar aqui, sem rede, é a mesma resposta que o DNS daria (`TypeError: fetch
 * failed`), só que decidida no mesmo tique: o trabalho solto termina enquanto o
 * teste que o disparou ainda está vivo, e não sobra nada em voo no teardown.
 * Só o host sintético do setup é recusado; qualquer teste que precise de outra
 * origem deve configurar e mockar essa dependência explicitamente.
 */
const HOST_DO_PLACEHOLDER = new URL(URL_DO_PLACEHOLDER).host;
const fetchDoAmbiente = globalThis.fetch;
globalThis.fetch = async (entrada, init) => {
  const url = entrada instanceof Request ? entrada.url : String(entrada);
  if (URL.canParse(url) && new URL(url).host === HOST_DO_PLACEHOLDER) {
    throw new TypeError("fetch failed", {
      cause: new Error(
        `${HOST_DO_PLACEHOLDER} é o placeholder do setup de teste (tests/setup/vitest.setup.ts): nenhum teste unitário fala com um Supabase de verdade`,
      ),
    });
  }
  return fetchDoAmbiente(entrada, init);
};

import "@testing-library/jest-dom/vitest";

// Node 25+ expõe `localStorage`/`sessionStorage` nativos que não servem sem
// `--localstorage-file` (no 26.8 valem `undefined`; no 25.4 são um objeto sem `.clear`),
// e o jsdom não os sobrescreve: `localStorage.clear()` quebrava ~100 testes. A guarda
// testa a capacidade, não o tipo, para cobrir os dois. Quando o global nativo não serve,
// devolve o storage do jsdom do arquivo. Em Node 22 o global já é o do jsdom e este
// bloco não faz nada.
const jsdomDoArquivo = (globalThis as { jsdom?: { window: Window } }).jsdom;
if (jsdomDoArquivo) {
  for (const nome of ["localStorage", "sessionStorage"] as const) {
    if (typeof globalThis[nome]?.clear !== "function") {
      Object.defineProperty(globalThis, nome, {
        configurable: true,
        get: () => jsdomDoArquivo.window[nome],
      });
    }
  }
}

// jsdom não implementa ResizeObserver; Radix (ex.: Switch) usa em layout effects.
if (typeof globalThis.ResizeObserver === "undefined") {
  globalThis.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
}

/**
 * O timer que o Radix deixa para trás não pode disparar em outro jsdom.
 *
 * Ao desmontar, o `FocusScope` do Radix (Dialog, Popover, Sheet…) agenda um
 * `setTimeout(0)` que faz `new CustomEvent(...)` e `container.dispatchEvent`.
 * Quando o componente é desmontado pela limpeza do ÚLTIMO teste de um arquivo,
 * esse timer pode disparar depois que o ambiente jsdom do arquivo já foi
 * desfeito: o evento nasce de outro `window` e o jsdom recusa com
 * "Failed to execute 'dispatchEvent' on 'EventTarget': parameter 1 is not of
 * type 'Event'". O vitest conta isso como erro não tratado e reprova a suíte
 * com todos os arquivos verdes — medido no `verify` do #1163 (run
 * 35336406831), atribuído a `composer-colar-imagem.test.tsx`, e intermitente
 * porque depende do relógio do runner.
 *
 * O conserto é dar ao timer a vez de rodar ENQUANTO o jsdom do arquivo existe:
 * desmonta explicitamente e espera um tique de macrotarefa. Com relógio falso
 * ligado não há o que esperar (o timer também é falso) — e esperar um
 * `setTimeout` falso travaria o hook até o teto do teste.
 */
if (typeof document !== "undefined") {
  const { afterEach, vi } = await import("vitest");
  const { cleanup } = await import("@testing-library/react");
  afterEach(async () => {
    cleanup();
    if (vi.isFakeTimers()) return;
    await new Promise((resolver) => setTimeout(resolver, 0));
  });
}
