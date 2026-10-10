# Contrato de compatibilidade do instalador

O `release-manifest.json` é a autoridade assinada para a versão mínima do
instalador, o alvo de schema e a faixa de origens suportadas. O instalador só
usa esses campos depois de validar a assinatura Ed25519.

## Versões do instalador

`distribution/installer/VERSION` é a fonte canônica da versão do instalador. A
comparação com `min_installer_version` segue a precedência SemVer 2.0.0:
versões estáveis têm precedência sobre pré-lançamentos, identificadores
numéricos de pré-lançamento comparam numericamente e metadados de build não
alteram a precedência.

## Schema

- `schema_target` é o baseline cumulativo de destino declarado pelo
  `supabase/manifest.json` incluído na imagem de migrador referenciada pelo
  manifesto assinado. O status do migrador precisa declarar o mesmo alvo antes
  de qualquer alteração no banco.
- `compatibility.min_schema` e `compatibility.max_schema` são limites
  inclusivos da versão de origem suportada para atualização direta. Os valores
  são sequências numéricas de schema com pelo menos quatro dígitos, não
  versões lexicais.
- O schema atual vem do ledger `public.clientix_schema_migrations` lido pelo
  migrador. O marcador `baseline:NNNN` fornece a sequência do baseline; linhas
  incrementais conhecidas são mapeadas pelo migrador para suas sequências no
  próprio `supabase/manifest.json`. O schema atual é a maior sequência
  comprovada por esse ledger. Linha desconhecida, marcador ausente/ambíguo ou
  evidência inconsistente torna o schema indisponível e bloqueia a operação.
- Em banco `FRESH_DATABASE`, ainda não existe schema de origem. O instalador
  permite somente o caminho `install` do baseline, desde que o alvo interno do
  migrador coincida com `schema_target`.
- Banco `EXISTING_UNTRACKED_INSTALLATION` não tem evidência versionada
  suficiente para a faixa de compatibilidade e falha fechado antes da adoção.
- Em uma atualização rastreada, origem abaixo do mínimo ou acima do máximo é
  recusada. Um alvo abaixo do schema atual também é recusado; o instalador não
  executa downgrade de banco.
