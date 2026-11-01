import { SITE_CLASSES, siteWithoutFetch, type SiteAuditResult, type SiteClass } from "./site-classify";

export interface EstrategiaDoCandidato {
  cenario: string;
  classe: SiteClass;
  angulo: string;
  ganchos: string[];
  objecoes: { objecao: string; resposta: string }[];
  proximoPasso: string;
  dataVerificacao: string | null;
  verificacaoPendente: boolean;
}

export interface ProspectParaEstrategia {
  website?: string | null;
  site?: SiteAuditResult | null;
}

function validSite(value: unknown): value is SiteAuditResult {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const site = value as Record<string, unknown>;
  if (
    !SITE_CLASSES.includes(site.classe as SiteClass) ||
    typeof site.provisorio !== "boolean" ||
    typeof site.citavel !== "boolean" ||
    typeof site.verificado_em !== "string" ||
    Number.isNaN(Date.parse(site.verificado_em))
  ) return false;
  if (site.status === "not_measured") return site.classe === "nao-medido" && site.provisorio && !site.citavel;
  if (site.status === "no_site") return site.classe === "sem-site" && !site.provisorio && site.citavel;
  if (site.status === "aggregator") return site.classe === "agregador" && !site.provisorio && site.citavel;
  return site.status === "checked" && site.classe !== "sem-site" && site.classe !== "agregador";
}

const OBJECAO_NEUTRA = {
  objecao: "Já tenho uma solução para isso.",
  resposta: "Entendi. A conversa pode ser apenas para comparar opções, sem compromisso.",
} as const;

const PONTO_MEDIDO: Readonly<Record<string, string>> = {
  viewport_missing: "A medição não encontrou a configuração de viewport para celular.",
  page_almost_empty: "A página apresentou pouco conteúdo visível na medição.",
  slow_response: "A resposta da página levou mais de cinco segundos na medição.",
  mixed_content: "A página carregou ao menos um recurso por uma conexão sem criptografia.",
  http_no_redirect: "O endereço abriu sem redirecionar para a versão com conexão segura.",
  https_unavailable: "A medição não encontrou uma versão com conexão segura.",
  site_builder_detected: "A medição identificou um construtor de páginas; isso, por si só, não prova um defeito.",
};

function dataDaVerificacao(value: string | null | undefined): string | null {
  if (!value) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  const day = String(date.getUTCDate()).padStart(2, "0");
  const month = String(date.getUTCMonth() + 1).padStart(2, "0");
  return `${day}/${month}/${date.getUTCFullYear()}`;
}

function pendente(site: SiteAuditResult, dataVerificacao: string | null): EstrategiaDoCandidato {
  return {
    cenario: "Verificação pendente",
    classe: site.classe,
    angulo: "A verificação não confirmou um ponto que possa ser citado. Não afirme um defeito do site.",
    ganchos: [],
    objecoes: [],
    proximoPasso: "Aguardar uma medição conclusiva antes de usar o site como argumento.",
    dataVerificacao,
    verificacaoPendente: true,
  };
}

/**
 * Lê somente a classe e códigos fechados da auditoria. Nenhum texto do prospect
 * ou conteúdo extraído do HTML participa da estratégia ou do system prompt.
 */
export function estrategiaDoCandidato(
  data: ProspectParaEstrategia,
  at = new Date().toISOString(),
): EstrategiaDoCandidato {
  const site = (validSite(data.site) ? data.site : null) ?? siteWithoutFetch(data.website, at);
  if (!site) {
    const semMedicao: SiteAuditResult = {
      ver: 1,
      classe: "nao-medido",
      status: "not_measured",
      provisorio: true,
      citavel: false,
      external_content_trust: null,
      verificado_em: at,
      url: null,
      final_url: null,
      http_status: null,
      tempo_ms: 0,
      https_disponivel: null,
      tls_valido: null,
      mobile_hint: null,
      empty_hint: null,
      builder_hint: null,
      motivo: "audit_pending",
      facts: null,
      resumo: null,
    };
    return pendente(semMedicao, null);
  }

  const dataVerificacao = dataDaVerificacao(site.verificado_em);
  if (site.provisorio || !site.citavel || site.classe === "nao-medido") {
    return pendente(site, dataVerificacao);
  }

  switch (site.classe) {
    case "sem-site":
      return {
        cenario: "Sem site informado",
        classe: site.classe,
        angulo: "O cadastro não trouxe um site próprio. Apresente a possibilidade de ter uma página própria como opção, sem prometer mais clientes ou resultados.",
        ganchos: ["Perguntar se a empresa já considera ter uma página própria."],
        objecoes: [OBJECAO_NEUTRA],
        proximoPasso: "Confirmar com a empresa se a ausência do site no cadastro corresponde à situação atual.",
        dataVerificacao,
        verificacaoPendente: false,
      };
    case "agregador":
      return {
        cenario: "Link de rede ou diretório",
        classe: site.classe,
        angulo: "O link cadastrado leva a uma rede ou diretório, não a um site próprio. Trate um site próprio como possibilidade complementar, sem desvalorizar os canais atuais.",
        ganchos: ["Perguntar se a empresa já avaliou uma página própria além dos canais atuais."],
        objecoes: [OBJECAO_NEUTRA],
        proximoPasso: "Confirmar se existe outro site próprio antes de sugerir qualquer mudança.",
        dataVerificacao,
        verificacaoPendente: false,
      };
    case "site-ok":
      return {
        cenario: "Site medido sem os sinais avaliados",
        classe: site.classe,
        angulo: "A medição não encontrou os sinais técnicos avaliados. Não apresente uma abordagem de conserto; se houver conversa, trate-a como exploração de objetivos futuros.",
        ganchos: ["Perguntar quais objetivos digitais a empresa gostaria de priorizar."],
        objecoes: [],
        proximoPasso: "Prioridade baixa para uma abordagem sobre reparo de site.",
        dataVerificacao,
        verificacaoPendente: false,
      };
    case "site-ruim": {
      const ponto = site.motivo && Object.hasOwn(PONTO_MEDIDO, site.motivo)
        ? PONTO_MEDIDO[site.motivo] ?? null
        : null;
      const descricao = ponto ?? "A auditoria registrou um ponto técnico que pode ser revisto com a empresa.";
      return {
        cenario: "Ponto técnico medido",
        classe: site.classe,
        angulo: `${descricao} Apresente como observação pontual e confirme se a empresa reconhece essa necessidade, sem prometer resultados.`,
        ganchos: [descricao],
        objecoes: [OBJECAO_NEUTRA],
        proximoPasso: "Convidar para revisar somente o ponto técnico que a medição confirmou.",
        dataVerificacao,
        verificacaoPendente: false,
      };
    }
    case "ssl-invalido":
      return {
        cenario: "Certificado de segurança inválido",
        classe: site.classe,
        angulo: "A validação do certificado de segurança falhou na medição. Comunique isso como observação de cortesia, sem exagerar consequências.",
        ganchos: ["Avisar que o navegador pode sinalizar um problema no certificado e confirmar se a empresa já está tratando disso."],
        objecoes: [OBJECAO_NEUTRA],
        proximoPasso: "Oferecer uma revisão do certificado após confirmar que o registro ainda está atual.",
        dataVerificacao,
        verificacaoPendente: false,
      };
    case "fora-do-ar":
      return {
        cenario: "Endereço não respondeu à medição",
        classe: site.classe,
        angulo: "A medição conclusiva não conseguiu acessar o endereço. Trate como aviso de cortesia e confirme com a empresa antes de propor uma correção.",
        ganchos: ["Perguntar se a equipe já sabe que o endereço não respondeu na verificação."],
        objecoes: [OBJECAO_NEUTRA],
        proximoPasso: "Confirmar a situação antes de recomendar qualquer serviço.",
        dataVerificacao,
        verificacaoPendente: false,
      };
  }
}
