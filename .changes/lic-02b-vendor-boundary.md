# LIC-02B — fronteira vendor/customer

- Reforça a cópia customer removendo caminhos de Control Plane, emissão, chaves e fixtures privadas.
- Varre o standalone, assets públicos e nomes de arquivos em busca de rotas vendor, segredo de emissão e blocos de chave privada PEM.
- Exige a trust root pública de produção no build customer e rejeita key IDs de certificação no modo de produção.
- Mantém a chave de identidade por instalação do LIC-01 separada da chave privada vendor de emissão.
- Desativa source maps de browser, servidor e prerender no build customer e os verifica no artefato; mantém o comportamento do build vendor.
- Exclui `.clientix-local` do contexto Docker para impedir que backups, runtime e segredos locais entrem na imagem.
- Não cria chave oficial, não aplica migration na stack persistente e não publica imagens.
