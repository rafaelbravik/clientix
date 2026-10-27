"use client";
import { useCallback, useMemo, useState } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useT } from "@/hooks/i18n/useT";
import { useBoard } from "@/hooks/kanban/useBoard";

function formatError(err: unknown, t: (texto: string) => string): string {
  if (err instanceof Error) return err.message;
  if (err && typeof err === "object") {
    const obj = err as { message?: unknown; code?: unknown; details?: unknown; hint?: unknown };
    if (typeof obj.message === "string") {
      const code = typeof obj.code === "string" ? ` [${obj.code}]` : "";
      return `${obj.message}${code}`;
    }
    try {
      return JSON.stringify(err);
    } catch {
      return t("Erro desconhecido");
    }
  }
  return String(err);
}
import { KanbanBoard } from "@/components/kanban/KanbanBoard";
import { FilterBar } from "@/components/kanban/FilterBar";
import { BulkActionBar } from "@/components/kanban/BulkActionBar";
import { NewLeadDialog } from "@/components/kanban/NewLeadDialog";
import { Button } from "@/components/ui/button";
import { Plus } from "@/lib/ui/icons";
import type { LeadFilters } from "@/lib/kanban/filters";
import { applyFilters, filtersFromParams, filtersToParams } from "@/lib/kanban/filters";
import { categoriaDoMotivo } from "@/lib/leads/motivos-de-perda-do-funil";
import { camposDoFunil } from "@/lib/leads/campos-do-funil";
import { ROLE_RANK, type Role } from "@/lib/auth/types";
import { ListaDoFunil } from "@/components/kanban/ListaDoFunil";
import { diasDeRecorte, recortaEncerradosAntigos } from "@/lib/kanban/recorte-de-encerrados";

export function PipelinePageClient({
  pipelineId,
  initialName,
  initialSettings = null,
  role,
}: {
  pipelineId: string;
  initialName: string;
  initialSettings?: Record<string, unknown> | null;
  role: Role;
}) {
  const t = useT();
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const view = searchParams.get("visao") === "lista" ? "lista" : "quadro";
  const { data, isLoading, error, pulses, realtimeStatus, seguranca } =
    useBoard(view === "quadro" ? pipelineId : null);
  const filters = useMemo(() => filtersFromParams(searchParams), [searchParams]);
  const settings = data?.pipeline.settings ?? initialSettings;
  const fieldDefs = useMemo(() => camposDoFunil(settings), [settings]);
  const setFilters = useCallback(
    (next: LeadFilters) => {
      const qs = filtersToParams(next);
      router.replace(qs ? `${pathname}?${qs}` : pathname, { scroll: false });
    },
    [router, pathname],
  );
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [newOpen, setNewOpen] = useState(false);

  /**
   * Motivo e categoria da perda (#1537): a categoria NÃO vem no lead — ela é
   * `settings.lost_reasons` do funil, que o payload do quadro já traz. O
   * resolvedor é o MESMO que o relatório usa (`categoriaDoMotivo`), para o
   * filtro e o relatório nunca dizerem coisas diferentes.
   */
  const categoriaDo = useMemo(() => {
    return (motivo: string) => categoriaDoMotivo(motivo, settings);
  }, [settings]);
  const filteredLeads = data ? applyFilters(data.leads, filters, { categoriaDo }) : [];
  const leadsDoQuadro = data
    ? recortaEncerradosAntigos(
        filteredLeads,
        diasDeRecorte(data.pipeline.settings),
        new Date(),
        searchParams.get("lead"),
      )
    : [];
  // NÃO é a conta do FilterBar: o seletor de filtro lista as três caixas
  // (`marcadoresDoCard`: negócio, contato e conversa), e esta lista, a da tag em
  // lote, só `lead.tags` — é lá que a ação em lote grava (#852). O `useMemo` é o
  // mesmo cuidado de lá: solta no corpo, a conta roda em toda renderização
  // e devolve um array NOVO a cada vez. E esta página re-renderiza a cada tecla
  // da busca (o debounce do FilterBar mexe na query string) e a cada mudança de
  // seleção de card.
  const tagsDoQuadro = useMemo(
    () => [...new Set((data?.leads ?? []).flatMap((l) => l.tags))].sort(),
    [data?.leads],
  );

  function setView(nextView: "quadro" | "lista") {
    const params = new URLSearchParams(searchParams.toString());
    if (nextView === "lista") {
      params.set("visao", "lista");
    } else {
      params.delete("visao");
      params.delete("pagina");
    }
    const query = params.toString();
    router.replace(query ? `${pathname}?${query}` : pathname, { scroll: false });
  }

  return (
    <div
      // O QUADRO CABE NA TELA. A página rolava com a janela: o quadro media o
      // que media a coluna mais comprida, e a barra de rolagem horizontal ficava
      // no pé dele — com uma etapa cheia, era preciso descer até o fim para
      // conseguir andar para o lado, e no caminho o nome da etapa sumia do alto.
      // Com a altura da área visível (100dvh menos a barra do topo, h-14, e o
      // p-6 do <main>), quem rola é o quadro: a barra horizontal fica sempre no
      // pé da tela e o cabeçalho de cada etapa fica preso em cima. O piso de
      // 28rem é para tela baixa demais, onde a página volta a rolar.
      className="flex h-[calc(100dvh-3.5rem-3rem)] min-h-[28rem] flex-col gap-4"
      // OBSERVÁVEL de propósito, e é a razão de existir desta linha: "a
      // assinatura morreu" e "nada aconteceu" produzem o MESMO silêncio na
      // tela, e sem este valor nem o produto nem o teste conseguem separar as
      // duas famílias de causa. Com ele, quem investiga olha DURANTE a rodada
      // que falha: `subscribed` manda procurar a montante (entrega, filtro, ou
      // o evento nunca saiu); `channel_error`/`timed_out`/`closed` já é a
      // resposta.
      //
      // Ainda NÃO religa — religar é desenho e merece bloco próprio. Isto aqui
      // é só parar de descartar o que já era calculado.
      data-realtime-status={realtimeStatus.toLowerCase()}
      // A rede de segurança fica OBSERVÁVEL pelo mesmo motivo do status do
      // canal: "a entrega morreu" e "nada aconteceu" têm a mesma aparência, que
      // é silêncio. Aqui o número de divergências é a diferença entre os dois —
      // e é o sinal que faltava para uma verificação poder APROVAR, e não só
      // reprovar.
      data-refetch-divergencias={seguranca.divergencias}
      data-refetch-em={seguranca.ultimaVerificacao ?? ""}
    >
      {/* `flex-col` no mobile: nome de funil comprido (é texto livre, sem
          limite curto) + botão na mesma linha sem quebra empurrava o botão pra
          fora da viewport em telas estreitas. De `sm:` pra cima volta a ser
          uma linha só, como sempre foi. */}
      <header className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <h1 className="min-w-0 truncate text-2xl font-semibold tracking-tight">
          {data?.pipeline.name ?? initialName}
        </h1>
        <div className="flex flex-wrap items-center gap-2">
          <div role="tablist" aria-label={t("Visualização do funil")} className="inline-flex rounded-md border border-border p-1">
            <Button role="tab" aria-selected={view === "quadro"} variant={view === "quadro" ? "secondary" : "ghost"} size="sm" onClick={() => setView("quadro")}>
              {t("Quadro")}
            </Button>
            <Button role="tab" aria-selected={view === "lista"} variant={view === "lista" ? "secondary" : "ghost"} size="sm" onClick={() => setView("lista")}>
              {t("Lista")}
            </Button>
          </div>
          {view === "quadro" && (
            <Button onClick={() => setNewOpen(true)} disabled={!data} className="shrink-0">
              <Plus size={16} className="mr-2" /> {t("Novo Lead")}
            </Button>
          )}
        </div>
      </header>
      {view === "quadro" && data && (
        <NewLeadDialog
          open={newOpen}
          onOpenChange={setNewOpen}
          pipelineId={pipelineId}
          stages={data.stages}
          fieldDefs={fieldDefs}
        />
      )}
      {view === "quadro" ? (
        <FilterBar
          filters={filters}
          onChange={setFilters}
          leads={data?.leads ?? []}
          settings={data?.pipeline.settings}
        />
      ) : (
        <p className="text-xs text-text-muted">{t("Os filtros do Quadro não se aplicam à Lista.")}</p>
      )}
      {error ? (
        <div className="rounded-md border border-destructive/30 bg-destructive/10 p-4 text-sm">
          {t("Não consegui carregar este funil:")} {formatError(error, t)}
        </div>
      ) : view === "lista" ? (
        <ListaDoFunil pipelineId={pipelineId} fieldDefs={fieldDefs} />
      ) : isLoading || !data ? (
        <div className="flex flex-1 animate-pulse items-center justify-center text-muted-foreground">
          {t("Carregando…")}
        </div>
      ) : (
        <KanbanBoard
          pipelineId={pipelineId}
          stages={data.stages}
          leads={leadsDoQuadro}
          pulses={pulses}
          pipeline={data.pipeline}
          selectedIds={selectedIds}
          onSelectionChange={setSelectedIds}
          leadInicial={searchParams.get("lead")}
          podeRenomearEtapa={ROLE_RANK[role] >= ROLE_RANK.manager}
        />
      )}
      {view === "quadro" && (
        <BulkActionBar
          selectedIds={selectedIds}
          stages={data?.stages ?? []}
          pipelineId={pipelineId}
          vocabulary={data?.pipeline.vocabulary ?? null}
          tagsExistentes={tagsDoQuadro}
          onClear={() => setSelectedIds([])}
        />
      )}
    </div>
  );
}
