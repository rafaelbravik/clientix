---
impacto: corrigido
secao: licenciamento
titulo: Corrige e fecha a validação local E2E de licenças
---

O ensaio local separado do Control Plane Vendor e do runtime Customer foi concluído após corrigir a sessão única por processo e o tratamento de heartbeat concorrente, provar recovery sem restart, emissão assinada no próprio pagamento, bloqueio de uma rota comercial real, e reativação após expiração. As duas falhas unitárias anteriores foram classificadas como preexistentes e corrigidas; o foco terminou em 97/97. Build Vendor, build Customer e boundary da imagem Customer passaram.

`READY_FOR_VPS_PILOT=YES` significa apenas que os gates locais para planejar um piloto passaram; VPS não foi usada. `PUBLIC_RELEASE_READY=NO`. Não houve acesso à persistente `deskcomm-crm`, produção ou gateway financeiro; sem migrations nesta wave, commit ou push.
