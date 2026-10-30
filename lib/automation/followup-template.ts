import { resolveActiveLeadForContact, type LeadCandidate } from "@/lib/leads/active-lead";
import {
  anexarDefinicoesDeLista,
  templatePodeUsarCampoPersonalizado,
} from "@/lib/automation/campos-do-render";
import { renderTemplate } from "@/lib/automation/template";
import type { Queryable } from "@/lib/agent-engine/queue/queue";

interface LeadDoContato extends LeadCandidate {
  custom_fields: Record<string, unknown> | null;
  pipeline_is_default: boolean;
}

/** Renderiza só custom fields no follow-up; o restante do texto mantém o contrato legado. */
export async function renderizarCamposPersonalizadosNoFollowup(
  db: Queryable,
  input: {
    organizationId: string;
    contactId: string;
    template: string;
    context?: Record<string, unknown>;
  },
): Promise<string> {
  const context = input.context ?? {};
  if (
    !templatePodeUsarCampoPersonalizado(input.template, [
      "nome",
      "primeiro_nome",
      "telefone",
      "email",
      "protocolo",
    ])
  ) {
    return input.template;
  }

  try {
    const { rows } = await db.query<LeadDoContato>(
      `select l.id, l.organization_id, l.pipeline_id, l.status, l.last_activity_at, l.created_at,
              l.custom_fields, p.is_default as pipeline_is_default
         from crm_leads l
         join crm_pipelines p on p.id = l.pipeline_id and p.organization_id = l.organization_id
        where l.organization_id = $1 and l.contact_id = $2`,
      [input.organizationId, input.contactId],
    );
    if (rows.length === 0) return input.template;

    const defaultPipelineId = rows.find((row) => row.pipeline_is_default)?.pipeline_id ?? null;
    const active = resolveActiveLeadForContact(rows, { defaultPipelineId });
    if (!active.routed) return input.template;

    const lead = rows.find((row) => row.id === active.leadId);
    if (!lead) return input.template;

    const renderContext: Record<string, unknown> = { ...context, lead };
    const customFields = lead.custom_fields;
    if (customFields !== null && Object.keys(customFields).length > 0) {
      const { rows: pipelines } = await db.query<{ settings: Record<string, unknown> | null }>(
        `select settings from crm_pipelines where organization_id = $1 and id = $2 limit 1`,
        [input.organizationId, lead.pipeline_id],
      );
      if (pipelines[0]) anexarDefinicoesDeLista(renderContext, pipelines[0].settings);
    }

    return renderTemplate(input.template, renderContext, {
      onlyCustomFields: true,
      preserveUnknown: true,
    });
  } catch {
    // Uma leitura auxiliar indisponível mantém o corpo original; não bloqueia o envio.
    return input.template;
  }
}
