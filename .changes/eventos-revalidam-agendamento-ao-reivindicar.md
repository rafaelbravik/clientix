---
impacto: nada_mudou
secao: corrigido
titulo: Workers respeitam o próximo horário de retry ao reivindicar eventos
---

O claim de um evento revalida o horário de retry no update condicional. Se outro processador reagendar o evento depois da leitura inicial, o worker antigo não o executa antes da hora.
