---
impacto: capacidade_nova
secao: corrigido
titulo: A instalação nova prepara Customer, Vendor e o first-run do proprietário
---

O caminho local agora cria bancos isolados, provisiona `agent_worker` antes da ACL da baseline, aplica as seis migrations do Control Plane e inicia Customer e Vendor com credenciais sintéticas. O token inicial é gerado e guardado pelo instalador; o proprietário consegue concluir o first-run sem preparar segredo manualmente.
