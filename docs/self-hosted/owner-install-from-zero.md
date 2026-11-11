# Instalação local nova do proprietário

Este é o caminho reproduzível para instalar uma cópia de teste a partir de um clone vazio. Ele usa o código e os templates versionados, cria bancos locais vazios e não acessa serviços de produção.

## Runtime e serviços

- Node.js 22 ou superior; o arquivo `.nvmrc` fixa a major recomendada.
- pnpm 9.15.9, fixado em `package.json` e `pnpm-lock.yaml`.
- Docker Engine/Desktop com Docker Compose v2.
- Supabase CLI 3.1.0, executado por `scripts/local-supabase.sh`; não é necessário instalá-lo globalmente.
- Postgres 15 local do Supabase para o Customer e um Postgres 15 separado para o Control Plane Vendor.
- No Windows, Git for Windows com Git Bash; `pnpm local:*` seleciona esse Bash diretamente e não depende de WSL.

## Do clone ao primeiro login

```bash
git clone https://github.com/rafaelbravik/clientix.git clientix
cd clientix
pnpm install --frozen-lockfile
pnpm local:up
```

`pnpm local:up` cria o projeto Supabase e o projeto Docker com identificadores derivados do caminho do clone. As portas locais são alocadas antes de iniciar os serviços, inclusive WAHA e a porta host do worker, para que dois clones no mesmo computador não compartilhem containers, redes, volumes ou portas. O worker mantém 8787 dentro do container e publica em `WORKER_HOST_PORT` (8787 quando livre); o dashboard WAHA e a porta host do worker ficam presos a loopback. O arquivo operacional do Supabase fica em `.clientix-local/supabase/`; ele é gerado a partir de `supabase/config.toml`, sem editar o template versionado.

O primeiro `local:up` provisiona uma senha aleatória para `agent_worker` antes de aplicar `supabase/baseline.sql`. A senha e a URL runtime ficam em `.clientix-local/` e são ignoradas pelo Git. `SUPABASE_DB_ADMIN_URL` é usada somente pelo provisionamento e pela inicialização; os serviços Customer e Worker recebem essa variável vazia e usam a URL runtime de `agent_worker`.

O stack inicia Customer e Vendor em containers separados, além do worker, scheduler, WAHA, Redis e dos dois bancos. O comando aplica o baseline Customer e as migrations `0001` a `0006` do Control Plane antes de iniciar os aplicativos. O banco `control_plane` nunca é o banco Customer.

`scripts/local-env.sh` gera `.env.local`, uma chave Ed25519 sintética de certificação e `CLIENTIX_BOOTSTRAP_TOKEN`. Os segredos de assinatura ficam no diretório ignorado `.clientix-local/control-plane/`; o Customer recebe somente a chave pública sintética pelo target `customer-certification`. Essa chave não é a trust root de produção e não pode ser usada para publicação.

O token de first-run fica em `.env.local` e na cópia protegida `.clientix-bootstrap-token` na raiz do clone. A saída do primeiro `local:up` mostra a URL Customer, por exemplo `http://127.0.0.1:3001`; abra `/setup` nessa origem e informe o token e os dados do primeiro Platform Owner. A rota compara `Origin` com `NEXT_PUBLIC_APP_URL`, a origem pública canônica validada no ambiente, porque Next pode receber uma URL interna do container atrás do port mapping. O endpoint consulta o estado no banco, reserva a inicialização em transação e recusa qualquer nova tentativa depois que o owner é criado; o token não reabre uma instalação inicializada. Remova a cópia `.clientix-bootstrap-token` após usá-la.

O Customer atende `http://127.0.0.1:<APP_PORT>` e o Vendor `http://127.0.0.1:<VENDOR_PORT>`. Customer, Vendor e Worker recebem o modo de ingresso local e o opt-in HTTP explicitamente no compose, pois as imagens executam com `NODE_ENV=production`. O callback do WAHA usa `http://app:3000` apenas na rede privada do compose; as origens da interface ficam em loopback e usam opt-in HTTP local. `NEXT_PUBLIC_APP_URL` aponta para o Customer e `NEXT_PUBLIC_ADMIN_URL` para o Vendor. O compose passa esta última também como `CLIENTIX_ADMIN_ORIGIN`, server-only e em runtime: o Next embute valores `NEXT_PUBLIC_*` no build, então o guard de escrita usa essa origem canônica runtime e falha fechado se ela faltar. O guard compara origens exatas; `localhost`, `127.0.0.1` e `::1` só são aceitos quando o mesmo host, esquema e porta estão configurados, e cabeçalhos forwarded não substituem `Origin`. A tela de licenciamento Vendor fica em `/admin/licensing`. O teste local usa banco Vendor novo e chave sintética gerada pelo próprio script. O License Server só aceita HTTP para o hostname interno `vendor` quando `DESKCOMM_ENV_MODE=local`; destinos externos HTTP continuam recusados.

Após o primeiro login, o Platform Owner usa `/owner` no Customer para criar empresas e convidar usuários. Essa tela é uma superfície local mínima: a API exige sessão de Platform Owner, licença Customer válida e quotas do plano; o Customer não recebe o painel de emissão de licenças do Vendor. O convite devolve uma URL de aceitação para o caso em que o serviço local de e-mail não esteja configurado.

## Provisionamento de identidade e signer local

O ambiente local persiste o INSTALLATION_ID Customer gerado por CSPRNG em .clientix-local/runtime/licensing/installation_id e mantém o mesmo valor no .env.local. O Compose usa volumes próprios do projeto para /opt/clientix/state e /opt/clientix/licenses, isolados pelo identificador do clone. A chave privada Ed25519 de instalação Customer é criada sob demanda em /opt/clientix/licenses/installation.key, com modo 0600, e permanece fora do banco e da imagem.

O signer local sintético é gerado uma vez em .clientix-local/control-plane/. Um par ausente é criado; um par incompleto ou cujo material não corresponda falha fechado sem substituir a chave existente. Depois das migrations Control Plane, local:up executa o provisionador local: ele insere somente a pública se o registro estiver vazio, retorna NO_CHANGE para a mesma chave ativa e recusa chaves ativas conflitantes ou aposentadas. A privada fica no arquivo local e na configuração protegida do Vendor. Ela nunca é enviada ao Customer, ao banco ou ao Git.

distribution/installer/install.sh instala o artefato Customer. Ele não provisiona o signer privado do Vendor: essa chave pertence ao operador do Control Plane. O instalador comercial já monta /opt/clientix/licenses gravável para persistir licença e chave privada local do Customer; /opt/clientix/state continua somente leitura e contém o ID provisionado pelo instalador.

## Conferir a instalação

```bash
pnpm local:status
curl -i "http://localhost:$(grep '^APP_PORT=' .env.local | cut -d= -f2)/login"
curl -i "http://localhost:$(grep '^VENDOR_PORT=' .env.local | cut -d= -f2)/api/v1/health"
pnpm typecheck
pnpm lint
pnpm test:shell
```

O runner TypeScript reserva heap de 8 GiB no comando `pnpm typecheck`; isso configura só o processo de verificação, sem alterar o runtime da aplicação. Para ver os serviços: `pnpm local:logs` ou `pnpm local:logs vendor`.

## Instalador comercial

Em uma instalação nova, o instalador comercial precisa de `SUPABASE_DB_ADMIN_URL` com permissão para provisionar papéis. Deixe `SUPABASE_DB_URL` vazio no template: o instalador gera uma senha CSPRNG, cria `agent_worker` com os atributos esperados pela ACL da baseline, deriva e persiste sua URL runtime e só então executa o migrator. Para adotar banco existente, informe uma URL que já autentique como `agent_worker`; o instalador não altera esse papel durante adoção.

O mesmo instalador gera o token de first-run quando o campo está vazio, grava-o no `.env` e em `.clientix-bootstrap-token` com permissão restrita, e imprime apenas o caminho do arquivo. Passe o token ao proprietário por canal privado e remova a cópia depois do primeiro acesso.
