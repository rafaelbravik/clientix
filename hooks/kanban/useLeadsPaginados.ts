"use client";

import { useCallback } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";

import { useActiveOrg } from "@/hooks/auth/AuthProvider";
import { useRealtimeChannel } from "@/hooks/realtime/useRealtimeChannel";
import { apiClient } from "@/lib/api/client";
import {
  filtrosDaLista,
  paramsDosFiltrosDaLista,
} from "@/lib/kanban/filtros-da-lista";
import type { LeadFilters } from "@/lib/kanban/filters";
import type { PipelineLeadListRow } from "@/lib/kanban/types";

export interface PipelineLeadsPage {
  data: PipelineLeadListRow[];
  meta: { page: number; per_page: number; total: number; has_more: boolean };
}

export function chaveDaListaDoFunil(
  organizationId: string | null,
  pipelineId: string | null,
  page?: number,
  perPage?: number,
  filterKey = "",
) {
  return ["pipeline-leads-list", organizationId, pipelineId, page, perPage, filterKey] as const;
}

export function useLeadsPaginados(
  pipelineId: string,
  page: number,
  perPage = 50,
  filters: LeadFilters = {},
) {
  const organizationId = useActiveOrg()?.orgId ?? null;
  const queryClient = useQueryClient();
  const filterKey = paramsDosFiltrosDaLista(filtrosDaLista(filters));
  const queryKey = chaveDaListaDoFunil(organizationId, pipelineId, page, perPage, filterKey);
  const invalidationPrefix = chaveDaListaDoFunil(organizationId, pipelineId).slice(0, 3);

  const query = useQuery({
    queryKey,
    enabled: !!organizationId && !!pipelineId,
    queryFn: () => {
      const params = new URLSearchParams({ page: String(page), per_page: String(perPage) });
      new URLSearchParams(filterKey).forEach((value, key) => params.set(key, value));
      return apiClient.get<PipelineLeadsPage>(
        `/api/v1/pipelines/${encodeURIComponent(pipelineId)}/leads?${params.toString()}`,
      );
    },
  });

  const onChange = useCallback(() => {
    void queryClient.invalidateQueries({ queryKey: invalidationPrefix });
  }, [queryClient, invalidationPrefix]);

  useRealtimeChannel({
    name: `pipeline-list-${organizationId ?? "none"}-${pipelineId}`,
    postgresChanges: organizationId && pipelineId
      ? { event: "*", schema: "public", table: "crm_leads", filter: `pipeline_id=eq.${pipelineId}` }
      : undefined,
    onChange,
    enabled: !!organizationId && !!pipelineId,
  });

  return {
    ...query,
    leads: query.data?.data ?? [],
    pageInfo: query.data?.meta,
  };
}
