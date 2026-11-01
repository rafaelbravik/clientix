/** Capacidades de prospecção consultadas dentro do atendimento. */
import { declararTools } from "./tipos";

export const TOOLS_PROSPECCAO = declararTools([
  {
    name: "crm_get_prospecting_site_audit",
    category: "read",
    rotulo: "Consultar auditoria do site",
    explicacao:
      "Consulta a auditoria do site e a orientação comercial da empresa vinculada à conversa atual, respeitando quando a medição ainda não é conclusiva.",
    oQueToca: "Atendimento e prospecção",
    risco: "seguro",
    pacotes: ["atender"],
  },
]);
