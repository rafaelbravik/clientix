---
impacto: nada_mudou
secao: corrigido
titulo: O worker libera a conversa quando uma licença impede a execução
---

Quando a licença da instalação não permite executar um job, o worker agora devolve o trabalho à fila sem consumir tentativa e libera a lane da conversa para outros jobs. Falhas inesperadas também recebem settlement pelo claim original; o reaper continua como recuperação para encerramento abrupto do processo.
