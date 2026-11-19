---
impacto: exige_acao
secao: alterado
titulo: Instalador configura o servidor central de licenças
---

O kit interativo pergunta a URL base HTTPS do Vendor, grava `CLIENTIX_LICENSE_SERVER_URL` e preserva a configuração ao ser executado novamente. O pacote comercial pede a mesma variável no `.env` e exige uma URL válida em instalações novas; atualizações aceitam `.env` legado sem a variável. Se o kit interativo ficar sem URL, informa que a ativação online não estará disponível e que operações protegidas por licença permanecerão restritas até a configuração.

## Requer atenção

Instalações existentes que usarão licenças do Vendor precisam configurar a URL HTTPS do Vendor no `.env`, executar `bash hostgator-setup-kit/install.sh` novamente e ativar o código em `/admin/license`. Instalações comerciais novas precisam informar essa URL no `.env` antes de instalar.
