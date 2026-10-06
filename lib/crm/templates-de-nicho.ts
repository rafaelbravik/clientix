/**
 * Catálogo de Modelos Pré-Prontos de Funis por Nicho (CRM & Kanban)
 *
 * Cada nicho define:
 * - Nome do funil
 * - Vocabulário adaptado (lead, deal, won, lost)
 * - Etapas padrão do Kanban com SLA (horas) e cores
 * - Motivos de perda e ganho comuns do segmento
 */

export interface NichoTemplate {
  id: string;
  name: string;
  icone: string;
  descricao: string;
  vocabulary: {
    lead: string;
    deal: string;
    won: string;
    lost: string;
  };
  stages: Array<{
    name: string;
    slug: string;
    is_won?: boolean;
    is_lost?: boolean;
    expected_duration_hours?: number;
  }>;
  lost_reasons: string[];
  won_reasons: string[];
}

export const TEMPLATES_DE_NICHO: NichoTemplate[] = [
  {
    id: "petshop",
    name: "PetShop & Veterinária",
    icone: "🐶",
    descricao: "Ideal para banho e tosa, consultas veterinárias e venda de pacotes e rações.",
    vocabulary: {
      lead: "Tutor / Pet",
      deal: "Agendamento / Pacote",
      won: "Serviço Concluído",
      lost: "Cancelado / Desistiu",
    },
    stages: [
      { name: "Primeiro contato", slug: "primeiro_contato", expected_duration_hours: 12 },
      { name: "Agendamento marcado", slug: "agendamento_marcado", expected_duration_hours: 48 },
      { name: "Pet no estabelecimento", slug: "pet_em_atendimento", expected_duration_hours: 6 },
      { name: "Pronto para retirada", slug: "pronto_retirada", expected_duration_hours: 4 },
      { name: "Finalizado & Pago", slug: "finalizado_pago", is_won: true },
      { name: "Faltou sem avisar / Cancelou", slug: "no_show_cancelou", is_lost: true },
    ],
    lost_reasons: ["Preço do pacote", "Sem horário compatível", "Vacina pendente", "Não compareceu"],
    won_reasons: ["Plano mensal fechado", "Serviço avulso realizado", "Compra de produtos"],
  },
  {
    id: "barbearia",
    name: "Barbearia, Salão & Estética",
    icone: "💈",
    descricao: "Para agendamento de cortes, químicas, procedimentos estéticos e pacotes mensais.",
    vocabulary: {
      lead: "Cliente",
      deal: "Procedimento / Corte",
      won: "Atendimento Realizado",
      lost: "Desmarcou / No-show",
    },
    stages: [
      { name: "Novo contato", slug: "novo_contato", expected_duration_hours: 6 },
      { name: "Data & Barbeiro/Profissional", slug: "escolhendo_horario", expected_duration_hours: 12 },
      { name: "Horário reservado", slug: "horario_reservado", expected_duration_hours: 48 },
      { name: "Em atendimento na cadeira", slug: "em_atendimento", expected_duration_hours: 2 },
      { name: "Atendimento finalizado", slug: "concluido", is_won: true },
      { name: "Não compareceu", slug: "no_show", is_lost: true },
    ],
    lost_reasons: ["Sem vaga com o profissional preferido", "Atraso do cliente", "Preço", "Desmarcou"],
    won_reasons: ["Corte/barba avulso", "Assinatura de clube mensal", "Compre de pomadas/produtos"],
  },
  {
    id: "clinica",
    name: "Clínicas & Consultórios Médicos/Odonto",
    icone: "🏥",
    descricao: "Odontologia, estética avançada, consultas médicas e fisioterapia.",
    vocabulary: {
      lead: "Paciente",
      deal: "Consulta / Tratamento",
      won: "Tratamento Fechado",
      lost: "Desistiu / Não Fechou",
    },
    stages: [
      { name: "Triagem inicial", slug: "triagem_inicial", expected_duration_hours: 24 },
      { name: "Avaliação agendada", slug: "avaliacao_agendada", expected_duration_hours: 48 },
      { name: "Plano de tratamento apresentado", slug: "plano_apresentado", expected_duration_hours: 72 },
      { name: "Negociação financeira", slug: "negociacao_financeira", expected_duration_hours: 96 },
      { name: "Tratamento iniciado", slug: "tratamento_fechado", is_won: true },
      { name: "Não aprovado / Desistência", slug: "desistiu", is_lost: true },
    ],
    lost_reasons: ["Orçamento elevado", "Falta de cobertura por convênio", "Tratou com concorrente", "Medo do procedimento"],
    won_reasons: ["Pagamento à vista", "Parcelamento próprio", "Convênio aceito"],
  },
  {
    id: "imobiliaria",
    name: "Imobiliária & Corretores",
    icone: "🏠",
    descricao: "Venda e locação de imóveis residenciais, comerciais e lançamentos na planta.",
    vocabulary: {
      lead: "Interessado / Comprador",
      deal: "Imóvel / Proposta",
      won: "Contrato Assinado",
      lost: "Proposta Recusada",
    },
    stages: [
      { name: "Novo lead de anúncio", slug: "novo_lead", expected_duration_hours: 2 },
      { name: "Perfil & Localização alinhados", slug: "perfil_alinhado", expected_duration_hours: 24 },
      { name: "Visita ao imóvel agendada", slug: "visita_agendada", expected_duration_hours: 48 },
      { name: "Proposta formal em análise", slug: "proposta_analise", expected_duration_hours: 72 },
      { name: "Documentação & Financiamento", slug: "financiamento_docs", expected_duration_hours: 120 },
      { name: "Escritura / Chaves entregues", slug: "fechado_ganho", is_won: true },
      { name: "Proposta cancelada", slug: "perdido_recusado", is_lost: true },
    ],
    lost_reasons: ["Financiamento reprovado", "Localização distante", "Preço/Condomínio alto", "Compreu com outra imobiliária"],
    won_reasons: ["Financiamento aprovado Caixa/Banco", "Compra à vista", "Contrato de locação firmado"],
  },
  {
    id: "servicos_b2b",
    name: "Serviços B2B, Agências & Consultorias",
    icone: "💼",
    descricao: "Gestão de tráfego, agências de marketing, contabilidade, software e consultoria.",
    vocabulary: {
      lead: "Prospect",
      deal: "Projeto / Contrato",
      won: "Contrato Fechado",
      lost: "Sem Fit / Perdido",
    },
    stages: [
      { name: "Diagnóstico inicial", slug: "diagnostico", expected_duration_hours: 24 },
      { name: "Reunião de apresentação", slug: "reuniao_apresentacao", expected_duration_hours: 48 },
      { name: "Proposta comercial enviada", slug: "proposta_enviada", expected_duration_hours: 72 },
      { name: "Negociação de escopo", slug: "negociacao", expected_duration_hours: 96 },
      { name: "Contrato assinado", slug: "ganho_contrato", is_won: true },
      { name: "Sem fit / Declinado", slug: "declinado", is_lost: true },
    ],
    lost_reasons: ["Sem orçamento agora", "Decisão postergada para próximo trimestre", "Optou por fazer internamente", "Preço"],
    won_reasons: ["Contrato recorrente (MRR)", "Projeto pontual aprovado"],
  },
  {
    id: "ecommerce",
    name: "E-commerce & Varejo",
    icone: "📦",
    descricao: "Lojas virtuais, recuperação de carrinhos e pedidos do WhatsApp.",
    vocabulary: {
      lead: "Cliente",
      deal: "Pedido",
      won: "Pedido Entregue",
      lost: "Pedido Cancelado",
    },
    stages: [
      { name: "Carrinho abandonado", slug: "carrinho_abandonado", expected_duration_hours: 2 },
      { name: "Aguardando pagamento PIX/Boleto", slug: "aguardando_pagamento", expected_duration_hours: 24 },
      { name: "Pago & Em separação", slug: "pago_separacao", expected_duration_hours: 24 },
      { name: "Enviado / Código de rastreio", slug: "enviado_rastreio", expected_duration_hours: 72 },
      { name: "Entregue com sucesso", slug: "entregue_sucesso", is_won: true },
      { name: "Cancelado / Não pago", slug: "cancelado", is_lost: true },
    ],
    lost_reasons: ["Frete alto", "Prazo longo", "Não pagou o boleto/PIX", "Cartão recusado"],
    won_reasons: ["Compra aprovada no site", "Venda assistida via WhatsApp"],
  },
  {
    id: "cursos",
    name: "Cursos & Infoprodutos",
    icone: "🎓",
    descricao: "Lançamentos, perpétuo, mentorias e captação de alunos.",
    vocabulary: {
      lead: "Aluno / Inscrito",
      deal: "Matrícula",
      won: "Matrícula Confirmada",
      lost: "Não Converteu",
    },
    stages: [
      { name: "Captura / Lead de aula", slug: "lead_captura", expected_duration_hours: 24 },
      { name: "Assistiu apresentação", slug: "assistiu_pitch", expected_duration_hours: 24 },
      { name: "Checkout aberto", slug: "checkout_aberto", expected_duration_hours: 12 },
      { name: "Recuperação de PIX", slug: "recuperacao_pix", expected_duration_hours: 24 },
      { name: "Matrícula ativa", slug: "matriculado", is_won: true },
      { name: "Carrinho expirado", slug: "expirado", is_lost: true },
    ],
    lost_reasons: ["Limite do cartão", "Sem tempo para estudar", "Dúvida sobre suporte", "Comprou outro curso"],
    won_reasons: ["Cartão em 12x", "PIX à vista", "Boleto bancário"],
  },
  {
    id: "advocacia",
    name: "Escritório de Advocacia",
    icone: "⚖️",
    descricao: "Direito trabalhista, cível, previdenciário e empresarial.",
    vocabulary: {
      lead: "Cliente",
      deal: "Caso / Processo",
      won: "Contrato Assinado",
      lost: "Inviável / Desistiu",
    },
    stages: [
      { name: "Triagem de caso", slug: "triagem_caso", expected_duration_hours: 12 },
      { name: "Consulta jurídica realizada", slug: "consulta_juridica", expected_duration_hours: 48 },
      { name: "Proposta de honorários", slug: "proposta_honorarios", expected_duration_hours: 72 },
      { name: "Contrato assinado & Procuração", slug: "contrato_assinado", is_won: true },
      { name: "Ação ajuizada / Ativo", slug: "acao_ajuizada", is_won: true },
      { name: "Caso sem viabilidade legal", slug: "sem_viabilidade", is_lost: true },
    ],
    lost_reasons: ["Honorários altos", "Prazo prescricional ultrapassado", "Falta de provas documentais"],
    won_reasons: ["Ad êxito aceito", "Honorários iniciais pagos"],
  },
];
