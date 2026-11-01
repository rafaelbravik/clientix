"use client";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { format } from "date-fns";
import { useLocaleDeData } from "@/hooks/i18n/useLocaleDeData";
import { useT } from "@/hooks/i18n/useT";
import type { SiteAuditResult } from "@/lib/prospecting/site-classify";

const labels: Record<SiteAuditResult["classe"], string> = {
  agregador: "Página de rede ou diretório",
  "sem-site": "Sem site informado",
  "site-ok": "Site medido",
  "site-ruim": "Site com pontos de atenção",
  "ssl-invalido": "Certificado de segurança inválido",
  "fora-do-ar": "Endereço não encontrado",
  "nao-medido": "Não foi possível medir",
};

const reasons: Record<string, string> = {
  website_absent: "Nenhum endereço de site foi informado.",
  google_maps_is_not_business_website: "O link informado é do Google Maps, não do site da empresa.",
  known_aggregator: "O endereço é de uma rede social ou página agregadora.",
  invalid_url: "O endereço informado não é um link válido para site.",
  unsafe_target_blocked: "O endereço foi bloqueado pela proteção de rede.",
  dns_nxdomain: "O domínio não foi encontrado.",
  https_unavailable: "O site não usa uma conexão segura.",
  http_no_redirect: "O endereço abre sem redirecionar para a versão segura.",
  https_measurement_incomplete: "Não foi possível confirmar a versão segura do site.",
  mixed_content: "A página carrega itens por uma conexão não segura.",
  viewport_missing: "O site não informa um layout adaptado para celular.",
  page_almost_empty: "O site apresentou pouco conteúdo visível.",
  slow_response: "O site demorou para responder.",
  site_builder_detected: "O site parece usar um construtor de páginas.",
  tls_certificate_invalid: "O certificado de segurança não pôde ser validado.",
  body_limit_exceeded: "A página excedeu o limite seguro de leitura.",
  unsupported_content_type: "O endereço não apresentou uma página HTML compatível.",
  unsupported_content_encoding: "A resposta do site não pôde ser lida com segurança.",
  too_many_redirects: "O site redirecionou além do limite seguro.",
  timeout: "A página demorou além do limite de verificação.",
  network_error: "Não foi possível concluir a verificação da rede.",
  dns_uncertain: "Não foi possível confirmar o endereço do site.",
  http_error: "A resposta do site não permitiu concluir a verificação.",
  response_headers_too_large: "A resposta do site excedeu o limite seguro.",
};

export function SiteAudit({
  site,
  website,
  disabled,
  onReanalyze,
}: {
  site?: SiteAuditResult | null;
  website: string | null;
  disabled: boolean;
  onReanalyze: () => void;
}) {
  const t = useT();
  const localeDaData = useLocaleDeData();
  if (!site) {
    return (
      <div className="mt-3 space-y-2">
        <p className="text-xs text-muted-foreground">{t("Auditoria do site ainda não realizada.")}</p>
        <Button type="button" size="sm" variant="outline" disabled={disabled || !website?.trim()} onClick={onReanalyze}>
          {t("Verificar site")}
        </Button>
      </div>
    );
  }

  const httpStatus = site.motivo?.match(/^http_(\d{3})$/)?.[1];
  const motivo = site.motivo
    ? reasons[site.motivo] ?? (httpStatus ? `O site respondeu com erro HTTP ${httpStatus}.` : null)
    : null;
  const instante = site.verificado_em ? new Date(site.verificado_em) : null;
  const checkedAt = instante && !Number.isNaN(instante.getTime()) ? format(instante, "Pp", { locale: localeDaData }) : null;
  const canReanalyze = Boolean(website?.trim()) && site.classe !== "agregador" && site.classe !== "sem-site";
  return (
    <section className="mt-3 space-y-1.5 rounded-md border bg-muted/20 p-3" aria-label={t("Auditoria do site")}>
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-xs font-medium">{t("Auditoria do site")}</span>
        <Badge variant={site.provisorio ? "secondary" : "outline"}>{t(labels[site.classe])}</Badge>
        {site.provisorio && <Badge variant="secondary">{t("Provisório")}</Badge>}
        {site.status === "checked" && !site.provisorio && <Badge variant="outline">{t("Definitivo")}</Badge>}
      </div>
      {motivo && <p className="text-xs text-muted-foreground">{t(motivo)}</p>}
      {checkedAt && <p className="text-xs text-muted-foreground">{t("Última verificação:")} {checkedAt}</p>}
      {site.ultima_tentativa && (
        <p className="text-xs text-muted-foreground">
          {t("A nova tentativa não foi conclusiva; o resultado definitivo anterior foi preservado.")}
        </p>
      )}
      {canReanalyze && (
        <Button type="button" size="sm" variant="outline" disabled={disabled} onClick={onReanalyze}>
          {t("Reanalisar site")}
        </Button>
      )}
    </section>
  );
}
