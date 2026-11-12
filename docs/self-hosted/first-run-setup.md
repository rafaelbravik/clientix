# Primeira inicialização e proprietário da plataforma

## O primeiro acesso

Uma instalação nova recebe um `CLIENTIX_BOOTSTRAP_TOKEN` aleatório de 256 bits gerado pelo instalador. O instalador grava o segredo no `.env` da instalação e em `.clientix-bootstrap-token`, com permissão restrita ao operador; ele nunca é exibido na saída do instalador. Entregue o token ao responsável pelo primeiro acesso por um canal privado e remova a cópia de entrega depois do uso.

Quando o banco ainda não está inicializado, a navegação de documentos leva a `/setup`. O assistente pede o token, os dados do proprietário e o nome da instalação. O endpoint confere o token no servidor, aplica rate limit persistente, valida a origem da requisição e reserva a inicialização no banco. Senha e token não são registrados em auditoria nem devolvidos pela API.

O token precisa ter pelo menos 32 caracteres. Uma configuração sem token válido falha fechada e não permite criar contas pelo assistente. Não coloque o valor em Git, tickets, logs, HTML, capturas de tela ou arquivos de configuração do navegador.

## Proprietário e administradores globais

O primeiro usuário recebe `platform_admins.platform_role = 'owner'`, sem vínculo automático com uma empresa. O proprietário entra por `/login` e usa `/owner` para criar empresas e convidar usuários. A criação de empresa exige licença instalada válida e respeita o limite global de organizações; convites só consomem uma vaga quando aceitos e passam pelo limite do plano. A licença local fica em `/admin/license`; a emissão e o faturamento comercial ficam no painel Vendor `/admin/licensing`.

`platform_role` é uma autoridade global separada de `user_organizations.role`. Um admin de organização só administra a própria empresa e não recebe acesso ao painel global. Administradores globais delegados continuam distintos do proprietário; a migration 9062 não promove usuários nem administradores antigos. A concessão ou revogação de acesso global a usuários existentes fica no painel global do Vendor (`/admin/users`), não na tela Customer `/owner`; um novo grant é criado como `platform_admin`, nunca como `owner`, e a operação é auditada no banco. A tabela não aceita escrita direta da aplicação. Criar ou recuperar outro `platform_owner` continua sendo procedimento DBA-only.

O formulário Customer `/owner` cria empresas usando um slug de plano ativo do catálogo local; ele exige licença de instalação válida e respeita o limite global de organizações. Para enviar convites, seleciona uma empresa ativa e respeita a quota de usuários do plano. O painel global do Vendor mantém os planos Essencial, Profissional e Escala em `/admin/plans` e, em `/admin/users`, permite emitir convites, alterar papéis e revogar/reativar vínculos; a função SQL impede remover o último admin da empresa. Depois, a equipe da empresa administra outros membros pelas superfícies de equipe já existentes.

O painel global usa rotas server-side protegidas por `requirePlatformAdmin`; escritas críticas de plano também exigem `requirePlatformOwnerEscrita`. O cliente nunca recebe a service role. O banco reserva o first-run com lock transacional e só uma requisição consegue finalizar o owner, a configuração global e o evento `platform_initialized` na mesma transação. Um trigger impede desativar, rebaixar ou excluir o último proprietário ativo.

## Instalações existentes

A migration 9062 sela como inicializadas as instalações que já possuem usuários, empresas ou admins globais. Ela preserva os grants existentes como `platform_admin` e não escolhe um proprietário arbitrariamente. Nesses casos `/setup` redireciona para o login e o endpoint de inicialização recusa novos owners.

Em um banco realmente novo, `fn_platform_initialized()` expõe apenas um booleano para a navegação decidir se mostra o setup. Se a consulta falhar, a aplicação não tenta inicializar por inferência de cookie ou estado do frontend.

## MFA

Configure MFA TOTP para a conta do proprietário depois do primeiro login, usando a segurança de conta já fornecida pelo Clientix. Guarde os códigos de recuperação fora do servidor da aplicação. Admins globais com MFA já habilitado precisam comprovar AAL2 nas rotas que assim exigem.

## Recuperação de acesso

1. Se a senha foi perdida, use o fluxo normal de recuperação de senha no e-mail do proprietário.
2. Se o MFA foi perdido, use os códigos de recuperação ou o procedimento de recuperação de MFA existente; não reutilize credenciais de teste.
3. Se a conta Auth do último proprietário foi perdida ou removida, o token de first-run não reabre o setup. A recuperação exige acesso administrativo ao host e ao banco, backup verificado, confirmação independente da identidade do proprietário e manutenção com acesso público suspenso. Um operador de banco autorizado deve restaurar uma identidade Auth comprovada e conceder a função global em uma única transação auditada, preservando `initialized_at`; depois, valide o login e a auditoria antes de reabrir o acesso.
4. Não crie outro owner alterando URL, variável de ambiente ou chamando RPC pelo navegador. Se não houver operador autorizado ou identidade verificável, mantenha a instalação fechada e recupere o banco pelo procedimento de backup aprovado.

O procedimento de banco é uma recuperação operacional de última instância, não um endpoint ou backdoor da aplicação. Nunca registre senha, token de bootstrap, access token ou refresh token durante a recuperação.
