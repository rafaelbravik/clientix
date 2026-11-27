---
impacto: nada_mudou
secao: corrigido
titulo: Contatos recebidos pelo Telegram ficam completos no CRM
---

O recebimento de mensagens da conta de usuário do Telegram agora grava o telefone em `contacts.phone_number` e cria o contato com o tipo permitido `person`; números brasileiros são normalizados antes de persistir.
