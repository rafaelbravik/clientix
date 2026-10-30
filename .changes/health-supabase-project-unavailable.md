---
impacto: nada_mudou
secao: corrigido
titulo: Health distingue indisponibilidade do projeto Supabase
---

O diagnóstico de `/api/v1/health` separa respostas que indicam indisponibilidade do projeto Supabase de falhas HTTP genéricas. Respostas 522, PostgREST `PGRST002` e erros explícitos de cache de schema em 5xx recebem um motivo próprio; falhas comuns continuam como resposta inesperada.
