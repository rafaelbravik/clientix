---
impacto: capacidade_nova
secao: adicionado
titulo: O instalador comercial aceita ACME DNS-01 Cloudflare
---

O instalador comercial mantém ACME direto como padrão e oferece DNS-01 Cloudflare quando a rede bloqueia as portas públicas. DNS-01 requer imagem Caddy com módulo Cloudflare referenciada por digest em manifesto assinado e segredo configurado explicitamente. Em produção, o operador administra um arquivo externo root-only que o instalador apenas valida por metadados e monta read-only no Caddy; em laboratório, o segredo pode ser injetado por stdin em tmpfs e precisa ser reinjetado após restart. O valor não é copiado para o Clientix, `.env`, Compose, imagem, backup, manifesto ou logs.
