import { randomUUID } from "node:crypto";
import type pg from "pg";
import { loadPublishedAgentConfigById } from "@/lib/agent-engine/agent/agent-config";
import { llmEdgeConfigFromEnv } from "@/lib/agent-engine/edge/llm/credentials";
import { runModelCall, type ModelMessage } from "@/lib/agent-engine/edge/llm/run-model-call";
import { env } from "@/lib/env";
import { ProspectingError } from "./provider";
import { campaignConfigSchema, prospectEnrichmentSchema } from "./schema";
import { estrategiaDoCandidato } from "./estrategia-site";
import {
  fingerprintDoSite,
  montarPromptDaPrevia,
  validarTextoDaPrevia,
  type PreviaSalva,
} from "./previa";
import { SITE_CLASSES, type SiteAuditResult, type SiteFacts } from "./site-classify";

export interface LinhaParaPrevia {
  id: string;
  campaign_id: string;
  data: unknown;
  status: string;
  contact_id: string | null;
  config: unknown;
  search: unknown;
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function safeText(value: unknown, limit: number): string | null {
  return typeof value === "string" ? value.trim().slice(0, limit) || null : null;
}

function safeSiteFacts(value: unknown): SiteFacts | null {
  const facts = record(value);
  if (!facts || facts.trust !== "UNTRUSTED_EXTERNAL_CONTENT") return null;
  return {
    trust: "UNTRUSTED_EXTERNAL_CONTENT",
    title: safeText(facts.title, 200),
    description: safeText(facts.description, 300),
    headings: Array.isArray(facts.headings)
      ? facts.headings.filter((v): v is string => typeof v === "string").slice(0, 6).map((v) => v.slice(0, 160))
      : [],
    visible_text_length:
      typeof facts.visible_text_length === "number" && Number.isFinite(facts.visible_text_length)
        ? Math.max(0, Math.min(1_000_000, Math.trunc(facts.visible_text_length)))
        : 0,
  };
}

function safeSite(value: unknown): SiteAuditResult | null {
  const site = record(value);
  if (
    !site ||
    site.ver !== 1 ||
    !SITE_CLASSES.includes(site.classe as (typeof SITE_CLASSES)[number]) ||
    typeof site.provisorio !== "boolean" ||
    typeof site.citavel !== "boolean" ||
    typeof site.verificado_em !== "string"
  ) return null;

  const nullableBoolean = (v: unknown): boolean | null => typeof v === "boolean" ? v : null;
  const nullableNumber = (v: unknown): number | null => typeof v === "number" && Number.isFinite(v) ? v : null;
  return {
    ver: 1,
    classe: site.classe as SiteAuditResult["classe"],
    status: site.status === "checked" || site.status === "aggregator" || site.status === "no_site"
      ? site.status
      : "not_measured",
    provisorio: site.provisorio,
    citavel: site.citavel,
    external_content_trust: site.external_content_trust === "UNTRUSTED_EXTERNAL_CONTENT"
      ? "UNTRUSTED_EXTERNAL_CONTENT"
      : null,
    verificado_em: site.verificado_em.slice(0, 40),
    url: safeText(site.url, 500),
    final_url: safeText(site.final_url, 500),
    http_status: nullableNumber(site.http_status),
    tempo_ms: typeof site.tempo_ms === "number" && Number.isFinite(site.tempo_ms)
      ? Math.max(0, Math.trunc(site.tempo_ms))
      : 0,
    https_disponivel: nullableBoolean(site.https_disponivel),
    tls_valido: nullableBoolean(site.tls_valido),
    mobile_hint: nullableBoolean(site.mobile_hint),
    empty_hint: nullableBoolean(site.empty_hint),
    builder_hint: safeText(site.builder_hint, 80),
    motivo: safeText(site.motivo, 120),
    facts: safeSiteFacts(site.facts),
    resumo: safeText(site.resumo, 1_200),
    // The full JSON object still participates in the fingerprint so every
    // reanalysis invalidates a saved preview, including a transient attempt.
    ultima_tentativa: undefined,
  };
}

function erroPrevia(message: string, code: string, status = 409): ProspectingError {
  return new ProspectingError(message, status, "candidato", code);
}

export async function gerarPreviaDoCandidato(
  pool: pg.Pool,
  organizationId: string,
  linha: LinhaParaPrevia,
  options: { now?: () => Date; callModel?: typeof runModelCall } = {},
): Promise<{ previa: PreviaSalva; estrategia: ReturnType<typeof estrategiaDoCandidato> }> {
  if (linha.status !== "new" && linha.status !== "queued") {
    throw erroPrevia("A prévia só pode ser gerada para uma empresa ainda não abordada.", "preview_candidate_not_ready");
  }

  const config = campaignConfigSchema.safeParse(linha.config);
  if (!config.success) throw erroPrevia("A campanha ainda não tem uma configuração completa.", "preview_campaign_not_configured");

  const rawData = record(linha.data);
  const prospect = prospectEnrichmentSchema.safeParse(rawData);
  if (!rawData || !prospect.success) {
    throw erroPrevia("Os dados da empresa não estão completos para gerar uma prévia.", "preview_candidate_invalid");
  }
  const site = safeSite(rawData.site);
  const dataParaEstrategia = { ...prospect.data, site };
  const now = (options.now ?? (() => new Date()))();
  const estrategia = estrategiaDoCandidato(dataParaEstrategia, now.toISOString());

  const agent = await loadPublishedAgentConfigById(pool, organizationId, config.data.agent_id);
  if (!agent || agent.pausedAt || agent.operationMode !== "automatic") {
    throw erroPrevia("O agente publicado da campanha está indisponível. Escolha um agente ativo e publicado.", "preview_agent_unavailable");
  }

  const content = {
    prospect: {
      name: prospect.data.name,
      website: prospect.data.website,
      category: prospect.data.category,
      address: prospect.data.address,
      rating: prospect.data.rating,
      reviews: prospect.data.reviews,
    },
    audit: {
      class: estrategia.classe,
      checked_at: estrategia.dataVerificacao,
      reason: site?.motivo ?? null,
      facts: site?.facts ?? null,
      summary: site?.resumo ?? null,
      trust: "UNTRUSTED_EXTERNAL_CONTENT" as const,
    },
  };
  const prompt = montarPromptDaPrevia({
    agentSystemPrompt: agent.systemPrompt,
    campaignInstructions: {
      instruction: config.data.instruction,
      qualification: config.data.qualification,
    },
    strategy: estrategia,
    content,
    nonce: randomUUID(),
  });

  let text: string;
  try {
    const { result } = await (options.callModel ?? runModelCall)(pool, llmEdgeConfigFromEnv(env), {
      tenantId: organizationId,
      leadId: linha.contact_id,
      jobId: null,
      agentId: agent.agentId,
      purpose: "automation_ai_message",
      system: prompt.system,
      messages: [{ role: "user", content: prompt.user }] as ModelMessage[],
      model: agent.model,
      llmOverride: { provider: agent.provider, credentialId: agent.credentialId },
    });
    text = validarTextoDaPrevia(result.text);
  } catch (error) {
    if (error instanceof ProspectingError) throw error;
    if (error instanceof Error && error.message === "preview_output_invalid") {
      throw erroPrevia("A IA não retornou um texto simples dentro do limite. Tente gerar a prévia novamente.", "preview_output_invalid", 502);
    }
    throw erroPrevia("Não foi possível gerar a prévia com o agente publicado. A auditoria do site continua disponível.", "preview_generation_failed", 502);
  }

  const previa = {
    ver: 1 as const,
    texto: text,
    site_fingerprint: fingerprintDoSite({ website: prospect.data.website, site: rawData.site ?? null }),
    gerada_em: now.toISOString(),
    agente_id: agent.agentId,
    agente_versao_id: agent.versionId,
    provider: agent.provider,
    model: agent.model,
  } satisfies PreviaSalva;
  return { previa, estrategia };
}
