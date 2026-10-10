---
impacto: capacidade_nova
secao: adicionado
titulo: O pacote comercial valida as assinaturas oficiais de release e licença
---

O instalador agora confere a assinatura Ed25519 do manifesto e usa somente as imagens identificadas pelos digests desse manifesto. A aplicação também reconhece a chave pública oficial de licenças. As raízes públicas ficam versionadas; as chaves privadas permanecem fora do repositório e do pacote instalado. Não é necessário configurar chaves manualmente na VPS.
