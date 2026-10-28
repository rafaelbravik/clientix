---
impacto: capacidade_nova
secao: adicionado
titulo: A API de contatos pode filtrar quem pediu para não ser incomodado
---
`GET /api/v1/contacts` aceita `blocked=yes` para listar contatos bloqueados e `blocked=no` para listar os demais. Sem o parâmetro, a listagem mantém o comportamento atual; a supressão de campanhas continua independente desse filtro.
