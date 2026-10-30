"use client";

import { useMemo, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";

import { useT } from "@/hooks/i18n/useT";
import { useTagDeIdioma } from "@/hooks/i18n/useLocaleDeData";
import { useLeadsPaginados } from "@/hooks/kanban/useLeadsPaginados";
import {
  filtrosDaLista,
  filtrosForaDaLista,
  type FiltroForaDaLista,
} from "@/lib/kanban/filtros-da-lista";
import type { LeadFilters } from "@/lib/kanban/filters";
import type { PipelineLeadListRow } from "@/lib/kanban/types";
import { formatValorDoNegocio, MOEDA_PADRAO } from "@/lib/money";
import type { CustomFieldDef } from "@/components/contacts/CustomFieldsEditor";
import { Button } from "@/components/ui/button";
import { LeadDossier } from "./LeadDossier";

const PER_PAGE = 50;

export function ListaDoFunil({
  pipelineId,
  fieldDefs,
  filters,
}: {
  pipelineId: string;
  fieldDefs: CustomFieldDef[];
  filters: LeadFilters;
}) {
  const t = useT();
  const tagDoIdioma = useTagDeIdioma();
  const router = useRouter();
  const searchParams = useSearchParams();
  const page = useMemo(() => {
    const value = Number(searchParams.get("pagina") ?? "1");
    return Number.isInteger(value) && value > 0 ? Math.min(value, 1_000_000) : 1;
  }, [searchParams]);
  const { data, leads, pageInfo, isLoading, isError } = useLeadsPaginados(
    pipelineId,
    page,
    PER_PAGE,
    filters,
  );
  const [selectedLead, setSelectedLead] = useState<PipelineLeadListRow | null>(null);
  const filtrosIgnorados = filtrosForaDaLista(filters);
  const filtrosAplicados = filtrosDaLista(filters);
  const labelsForaDaLista: Record<FiltroForaDaLista, string> = {
    busca: "Busca",
    etiqueta: "Tag",
    atrasados: "Apenas atrasados",
    motivo: "Motivo",
    categoria: "Categoria",
  };

  const maxPage = Math.max(1, Math.ceil((pageInfo?.total ?? 0) / PER_PAGE));
  function setPage(nextPage: number) {
    const params = new URLSearchParams(searchParams.toString());
    params.set("visao", "lista");
    if (nextPage === 1) params.delete("pagina");
    else params.set("pagina", String(nextPage));
    router.replace(`?${params.toString()}`, { scroll: false });
  }

  return (
    <section className="flex min-h-0 flex-1 flex-col gap-3" aria-label={t("Lista de negócios")}
      data-testid="pipeline-list-view">
      {filtrosIgnorados.length > 0 && (
        <p role="status" className="rounded-md border border-border bg-surface-muted p-3 text-sm text-text-muted">
          {t("Na Lista, estes filtros ainda não se aplicam:")} {filtrosIgnorados
            .map((filtro) => t(labelsForaDaLista[filtro]))
            .join(", ")}. {t("No Quadro, eles continuam funcionando.")}
        </p>
      )}
      {isError ? (
        <div role="alert" className="rounded-md border border-destructive/30 bg-destructive/10 p-4 text-sm">
          {t("Falha ao carregar a lista do funil.")}
        </div>
      ) : isLoading || !data ? (
        <div className="flex flex-1 animate-pulse items-center justify-center text-muted-foreground">
          {t("Carregando negócios…")}
        </div>
      ) : (
        <>
          <div className="min-h-0 flex-1 overflow-x-auto rounded-md border border-border">
            <table className="w-full min-w-[660px] border-collapse text-sm">
              <thead className="sticky top-0 bg-surface text-left text-xs text-text-muted">
                <tr>
                  <th scope="col" className="px-4 py-3 font-medium">{t("Negócio")}</th>
                  <th scope="col" className="px-4 py-3 font-medium">{t("Etapa")}</th>
                  <th scope="col" className="px-4 py-3 text-right font-medium">{t("Valor")}</th>
                  <th scope="col" className="px-4 py-3 font-medium">{t("Última atividade")}</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {leads.map((lead) => (
                  <tr key={lead.id} className="hover:bg-surface-muted">
                    <td className="px-4 py-2.5">
                      <button
                        type="button"
                        className="max-w-full truncate text-left font-medium text-text underline-offset-2 hover:underline focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring"
                        aria-label={`${t("Abrir dossiê do negócio")}: ${lead.title}`}
                        onClick={() => setSelectedLead(lead)}
                      >
                        {lead.title}
                      </button>
                    </td>
                    <td className="px-4 py-2.5 text-text-muted">{lead.stage_name ?? "—"}</td>
                    <td className="whitespace-nowrap px-4 py-2.5 text-right tabular-nums">
                      {lead.value_cents === null
                        ? "—"
                        : formatValorDoNegocio(lead.value_cents, lead.currency ?? MOEDA_PADRAO, { semCentavos: true })}
                    </td>
                    <td className="whitespace-nowrap px-4 py-2.5 text-text-muted">
                      {lead.last_activity_at
                        ? new Date(lead.last_activity_at).toLocaleString(tagDoIdioma)
                        : "—"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            {leads.length === 0 && (
              <p className="px-4 py-12 text-center text-text-muted">
                {filtrosAplicados.owner || filtrosAplicados.status
                  ? t("Nenhum negócio com este filtro.")
                  : t("Nenhum negócio neste funil.")}
              </p>
            )}
          </div>

          <footer className="flex flex-wrap items-center justify-between gap-3 text-sm">
            <p className="text-text-muted">
              {t("Página")} {page} {t("de")} {maxPage} · {pageInfo?.total ?? 0} {t("negócios")}
            </p>
            <div className="flex items-center gap-2">
              <Button variant="outline" size="sm" onClick={() => setPage(page - 1)} disabled={page <= 1 || isLoading}>
                {t("Anterior")}
              </Button>
              <Button variant="outline" size="sm" onClick={() => setPage(page + 1)} disabled={!pageInfo?.has_more || isLoading}>
                {t("Próxima")}
              </Button>
            </div>
          </footer>

          {selectedLead && (
            <LeadDossier
              open
              onOpenChange={(open) => { if (!open) setSelectedLead(null); }}
              lead={selectedLead}
              pipelineId={pipelineId}
              fieldDefs={fieldDefs}
              stageName={selectedLead.stage_name ?? "—"}
            />
          )}
        </>
      )}
    </section>
  );
}
