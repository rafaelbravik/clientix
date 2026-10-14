# Spec 21 — WebChat incorporável

## Objetivo

Permitir que uma organização publique um chat em seu próprio site e receba visitantes
anônimos no Inbox. O fluxo não depende de WAHA, Meta ou outro transporte externo.

## Propriedade e identidade

- Uma linha de `channel_sessions` com `provider = webchat` é a configuração tenant-aware.
- `webchat_public_id` é UUID público e único globalmente. Identifica uma configuração, não
  autentica nem concede acesso administrativo.
- O backend resolve a organização pela própria linha encontrada por `webchat_public_id`;
  nenhum `organization_id` do navegador participa da consulta ou da escrita.
- Uma organização tem no máximo uma sessão WebChat não arquivada. `WORKING` habilita o
  widget; `STOPPED` desabilita e revoga imediatamente a leitura e a escrita das sessões
  emitidas. A configuração administrativa usa o guard de `admin`, `requireSupportWrite`,
  quota de canais e `audit()`.
- O visitante não fornece nem escolhe `contact_id`, `conversation_id`, `channel_session_id`
  ou `organization_id`. O servidor cria o contato anônimo e a conversa sob a organização
  resolvida pela sessão.

## Contrato HTTP

| Rota | Autorização e efeito |
|---|---|
| `GET /api/v1/channels/webchat` | Admin autenticado; retorna estado e identificador público. |
| `POST /api/v1/channels/webchat` | Admin autenticado + suporte gravável; recebe `{ enabled: boolean }`, aplica quota e ativa/desativa. |
| `GET /chat/widget.js` | Loader público JavaScript. Lê apenas `data-widget-id`, cria botão e iframe do Clientix. |
| `POST /api/v1/widget/bootstrap` | Público; recebe `widget_public_id` e, opcionalmente, token existente. Resolve sessão ativa, aplica rate limit e cria ou recupera uma conversa limitada. |
| `GET /api/v1/widget/chat` | Token assinado; lê uma conversa e suas últimas mensagens. |
| `POST /api/v1/widget/chat/messages` | Token assinado; grava texto somente na conversa vinculada e aciona `fn_service_inbound`. |

O corpo do bootstrap é estrito: campos adicionais como `organization_id` são recusados.
O token curto assinado vincula `conversationId`, `organizationId` e `widgetPublicId`, e
expira em 24 horas. O bootstrap só reutiliza token válido para o mesmo widget e a mesma
conversa. Tokens antigos de convite permanecem com compatibilidade de 30 dias; eles não
podem acessar conversas WebChat.

O token novo fica em `sessionStorage` no contexto isolado do iframe e trafega nas chamadas
como Bearer. Não fica na URL, no snippet, no loader nem em cookie compartilhado com o site
do cliente. O token só permite ler e escrever a conversa assinada; todas as queries também
filtram a organização derivada do próprio token, e as rotas verificam o provider, o widget
e o estado habilitado da sessão.

## Entrada, Inbox e resposta

1. A tela de Conexões cria uma sessão WebChat e mostra o snippet com o identificador público.
2. O loader adiciona um iframe em `/chat/embed/{widget_public_id}`; o site externo não recebe
   token nem credencial do Clientix.
3. O iframe chama o bootstrap na mesma origem do aplicativo. O servidor cria um contato
   `Visitante` e uma conversa `channel = webchat`, com `provider_conversation_id` igual ao
   id local da conversa.
4. A primeira mensagem entra em `messages` e chama `fn_service_inbound`; a conversa aparece
   no Inbox existente.
5. A resposta humana ou do agente usa o handler central de mensagens. O adapter local
   registra a confirmação sem chamar serviço externo; o visitante recebe a linha persistida
   pelo polling autenticado da própria conversa.

## Abuso e origem

- Bootstrap: limite por IP e por widget; consulta de conversa: por token e IP; envio de
  mensagens: limite por sessão/conversa e IP na infraestrutura existente.
- O produto **não possui política de allowed origins** para WebChat. Qualquer site pode
  incorporar o loader público. `Origin` e `Referer` não são usados como autenticação; o
  identificador público, o token de conversa e os rate limits formam o contrato atual.
- Não há CORS aberto no bootstrap: o código roda dentro do iframe na origem Clientix.
- A exceção de framing é restrita ao path do iframe público; o restante da aplicação mantém
  `X-Frame-Options: DENY`.

## Limites atuais

- WebChat envia texto local para conversas que existem; não entrega campanhas a visitantes
  offline, não envia mídia/áudio/templates e não oferece edição de mensagens.
- Um bootstrap novo sem token existente cria uma nova identidade anônima e conversa. O token
  em `sessionStorage` permite retomar a mesma conversa na sessão do navegador enquanto válido.
- O fluxo usa rate limit em memória quando Upstash Redis não está configurado, conforme o
  fallback existente da instalação; isso reduz a proteção em múltiplos nós.
- Não declarar E2E certificado em provedor externo por causa desta implementação local.
