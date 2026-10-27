---
impacto: nada_mudou
secao: corrigido
titulo: Falha ao ler SMTP não apaga a senha salva
---

Ao salvar SMTP sem informar uma nova senha, o Clientix agora aborta se não conseguir confirmar o segredo atual. Uma falha de leitura não apaga a senha cifrada nem salva parcialmente as demais configurações.
