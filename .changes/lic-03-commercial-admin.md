---
impacto: capacidade_nova
secao: adicionado
titulo: Administre clientes, licenças e instalações no Control Plane
---

O Control Plane do fornecedor agora oferece painel comercial, cadastro e busca paginada de clientes, emissão e gestão do ciclo de vida das licenças, acompanhamento de instalações e eventos, alertas de vencimento e exportação CSV. Ações sensíveis usam as proteções administrativas existentes, registram auditoria e aplicam idempotência/serialização transacional quando há risco de repetição ou concorrência.

A migration `0004_vendor_commercial_admin.sql` pertence somente ao banco separado do Control Plane. O build Customer continua excluindo rotas e módulos Vendor; o artefato é varrido antes de ser entregue. Nenhuma cobrança, integração financeira ou automação externa foi incluída.
