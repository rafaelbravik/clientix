# Runbook — acesso às imagens privadas do GHCR

Este procedimento permite que uma instalação autorizada baixe as imagens do Clientix sem
tornar os pacotes públicos. O repositório de código continua público; a visibilidade dos
pacotes é configurada separadamente no GitHub.

## 1. Conceda leitura nos pacotes

Na conta GitHub proprietária, abra cada pacote em
[Packages](https://github.com/rafaelbravik?tab=packages) → **Package settings** → **Manage access**
e adicione a conta GitHub que será usada no VPS com a função **Read**.

- O kit HostGator usa `clientix-app`, `clientix-worker`, `clientix-scheduler` e
  `clientix-voice-agent`.
- O instalador de distribuição comercial também usa `clientix-migrator` e
  `clientix-ingress`; conceda leitura nesses dois pacotes também para esse caminho.

Mantenha os pacotes privados e deixe **Inherit access from source repository** desligado.
Como o repositório de código é público, herdar acesso do repositório pode expor os pacotes
aos leitores anônimos. **Manage Actions access** autoriza workflows do repositório; isso
não concede leitura a uma conta de cliente no VPS.

## 2. Kit HostGator

A pessoa que instala precisa de um **Personal access token (classic)** com o escopo
`read:packages`, vinculado à própria conta GitHub que recebeu o acesso **Read**. Não é
necessário conceder `repo` para clonar o código, que é público.

No modo interativo, `install.sh` pede o nome de usuário e lê o token sem exibi-lo. O Docker
guarda o login em `~/.docker/config.json` para o usuário que executou a instalação. As
atualizações pela tela/cron usam esse mesmo login. Sem um credential helper, o Docker guarda
a credencial codificada em Base64 (não criptografada); permissões `700/600` restringem o
acesso a outros usuários do VPS. Use um credential helper do sistema quando disponível.

Para instalação não-interativa, autentique antes como o mesmo usuário e contexto de Docker que
executará o kit:

```bash
docker login ghcr.io --username SEU_USUARIO_GITHUB
bash install.sh --yes
```

Digite o PAT no prompt do Docker; não o acrescente ao comando. Se o token for revogado ou
expirar, autentique novamente com `docker login ghcr.io` e rode `update.sh`. Para remover
a credencial local, execute `docker logout ghcr.io` como o mesmo usuário e revogue o PAT
nas configurações da conta.

## 3. Instalador de distribuição comercial

O instalador comercial usa as credenciais Docker do usuário que executa seus comandos. Antes
de instalar ou atualizar, faça login e use o mesmo usuário para executar a operação:

```bash
docker login ghcr.io --username SEU_USUARIO_GITHUB
bash distribution/installer/install.sh install
# nas próximas atualizações, com a mesma conta:
bash distribution/installer/install.sh update
```

Se a operação usa `sudo`, faça o login e rode o instalador com `sudo` nos dois casos,
para que ambos usem o mesmo `/root/.docker/config.json`:

```bash
sudo docker login ghcr.io --username SEU_USUARIO_GITHUB
sudo bash distribution/installer/install.sh install
```

O instalador aceita `REGISTRY_USERNAME` e `REGISTRY_TOKEN` para uma autenticação pontual.
Esse modo faz logout depois do pull das imagens. Para futuras atualizações sem repetir a
credencial no ambiente, prefira o login Docker persistente acima. O PAT continua fora do
`.env`; não o passe como argumento de linha de comando.

## 4. Licença e acesso às imagens são controles separados

O código de ativação `ACT_...` valida a licença da instalação Clientix. Ele **não** concede
permissão ao GHCR e não substitui o PAT. A conta GitHub precisa ter leitura nos pacotes e o
token precisa ter `read:packages`.

A visibilidade privada bloqueia downloads anônimos dos pacotes publicados. Ela não é DRM:
uma conta com permissão **Read** pode baixar e copiar imagens, e o código do repositório é
público e pode ser clonado/construído. Para impedir redistribuição por alguém autorizado,
seria necessário um serviço de distribuição/control-plane próprio; a licença continua sendo
uma verificação separada do acesso ao registry.
