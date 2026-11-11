# Licenciamento local da instalação — LIC-01

## Escopo

A instalação valida localmente um documento comercial assinado. Esta especificação não introduz servidor de licença, cobrança, renovação automática, revogação online, telemetria nem identificação de hardware.

O `CLIENTIX_BOOTSTRAP_TOKEN` continua sendo exclusivo do first-run e não participa da validação da licença.

## Documento assinado

O formato atual é `license_version: 1`, assinado com Ed25519 sobre o payload canonicalizado por JCS. Os campos legados obrigatórios permanecem compatíveis. Campos assinados opcionais incluem `serial`, `plan` (`standard`, `pro` ou `enterprise`), `product`, `deployment`, `status` (`ACTIVE` ou `REVOKED`) e `grace_period_days`. Campo desconhecido ou formato não suportado falha fechado.

`product` e `deployment`, quando presentes, precisam ser `clientix` e `self-hosted`. Um documento legado sem esses campos continua sendo interpretado como licença Clientix self-hosted. O marcador `REVOKED` só é aceito dentro do payload assinado; não há consulta remota.

A aplicação contém somente chaves públicas confiáveis. Chaves privadas pertencem a um processo de emissão separado e não são necessárias no runtime, no bundle do navegador ou no banco do cliente.

## Identidade e tempo

Em runtime Customer, a chave privada de instalação é criada sob demanda com permissão 0600 em /opt/clientix/licenses/installation.key. O instalador comercial monta esse diretório gravável para o app; state/ permanece somente leitura para o installation_id provisionado pelo instalador. A chave pública é derivada para a prova de posse e enviada ao Vendor; a privada permanece local e nunca entra no banco ou na imagem.

O identificador persistente segue `inst_<UUIDv4>`, o contrato já usado pelo instalador. Ele não deriva de hardware ou hostname. O caminho de desenvolvimento fica em `.clientix-local/runtime/licensing/`; em produção, a licença e o relógio local ficam no volume gravável `/opt/clientix/licenses/`, enquanto o `installation_id` provisionado pelo instalador fica em `/opt/clientix/state/` montado somente para leitura. Os caminhos podem ser definidos por `CLIENTIX_LICENSE_PATH`, `CLIENTIX_INSTALLATION_ID_PATH` e `CLIENTIX_LICENSE_CLOCK_PATH`.

Datas são UTC ISO-8601 estritas. `valid_from` é inclusivo; `expires_at` inicia a carência. A carência padrão é de sete dias e pode ser declarada no payload assinado. Depois dela, o estado é `EXPIRED`. Uma regressão local do relógio superior a cinco minutos é sinalizada sem bloqueio imediato; a instalação indica que futura revalidação online será necessária.

## Estados e modo restrito

O estado comercial exibido é `ACTIVE`, `GRACE`, `EXPIRED`, `REVOKED` ou `INVALID`. Falta/erro de arquivo, assinatura inválida, instalação incompatível, produto incompatível, formato desconhecido e chave pública desconhecida são apresentados como `INVALID`, preservando internamente seus códigos específicos.

Em `GRACE` as operações licenciadas continuam. Em `EXPIRED`, `REVOKED` ou `INVALID`, o guard central bloqueia apenas operações comerciais que já o invocam. Login, administração da plataforma, leitura, backup, exportação e atualização da licença continuam acessíveis. Não se apagam dados, filas ou containers.

`CLIENTIX_LICENSE_ENFORCEMENT=warn` é permitido fora de produção para desenvolvimento e emite aviso estruturado quando uma operação sem licença utilizável continua. Produção exige `enforce`; query strings e headers do cliente não alteram a política.

O plano opcional no documento identifica o plano contratado da instalação. Ele não muda `organizations.settings.plan`, limites por usuário de tenant nem a resolução de capacidades do catálogo de planos existente.

## API e tela local

As rotas `/api/v1/admin/license`, `/validate` e `/update` exigem sessão de Platform Admin; atualização também exige o escopo de escrita/MFA vigente e recusa escrita em sessão de suporte somente leitura. A rota legada `/api/v1/system/license` mantém o mesmo limite de Platform Admin.

A página `/admin/license` mostra somente serial e installation ID mascarados, plano, validade, dias restantes, carência, estado, última validação e alertas de 30/15/7/1 dias. O arquivo é validado em memória antes da gravação temporária e da substituição atômica; uma candidata recusada não substitui o arquivo atual.

O build self-host preserva essa página e as APIs locais de licença. Para completar a instalação, também preserva a superfície mínima `/owner` e apenas as rotas `/api/v1/admin/tenants` e `/api/v1/admin/users`; essas APIs mantêm os guards de Platform Admin, licença de instalação e quotas. O painel vendor `/admin/licensing`, as demais rotas de administração global e o Control Plane continuam excluídos.

## Living System review

- **Entrada:** `installation_id` persistido por `FileInstallationIdStorage`/instalador, arquivo assinado em `CLIENTIX_LICENSE_PATH` e horário local observado por `observeLicenseClock`.
- **Saídas:** `requireValidInstallationLicense` protege operações comerciais já licenciadas; `getInstallationCapabilities` e `getInstallationTenantLimit` expõem capacidades e limite de tenants sem alterar `organizations.settings.plan`.
- **Atividade:** a substituição autorizada emite `platform_license.updated` via `audit()`; modo local de aviso registra `logger.warn` sem incluir payload ou segredo.
- **Tela e porta:** `/admin/license` continua alcançável pelo card de Platform Admin em `/app/settings`; `/owner` permite ao primeiro Platform Owner criar empresas e convites depois que a licença local foi ativada. A exceção estreita no customer build é necessária porque o restante de `/admin` é o painel vendor e não é distribuído.
- **Continuidade:** estados `GRACE`, `EXPIRED`, `REVOKED` e `INVALID` mostram alerta e ação de atualização; leitura, backup, exportação e administração da plataforma continuam disponíveis.
- **Configuração ausente:** a página mostra licença ausente/inválida, modo efetivo, último check e seletor para substituir o documento; produção continua fail-closed.
- **IA ↔ humano:** não aplicável; licenciamento não participa do fluxo de atendimento ou handoff.
- **Laço de retorno:** uma operação comercial negada recebe `license_restricted`; Platform Admin vê o estado mascarado e corrige a licença local pela página. A licença recusada nunca substitui o arquivo válido.
- **Mapa vivo:** `docs/architecture/control-plane-customer-boundary.architecture.json` registra UI, API e serviço local com arestas de leitura, substituição, validação e enforcement.
