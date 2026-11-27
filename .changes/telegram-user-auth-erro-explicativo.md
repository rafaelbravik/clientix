---
impacto: nada_mudou
secao: corrigido
titulo: Conta Telegram conclui a etapa 2FA e salva a sessão
---

Quando a conta do Telegram exige senha de duas etapas, a autenticação reconhece o código RPC mesmo se o Teleproto minificar o nome da classe e avança para a etapa de senha. A sessão MTProto é gravada com o literal bytea do banco, sem serialização JSON de `Buffer`, e não exige segredo de webhook porque não recebe webhooks. Erros inesperados registram apenas metadados seguros, sem telefone, código de login, sessão ou credenciais.
