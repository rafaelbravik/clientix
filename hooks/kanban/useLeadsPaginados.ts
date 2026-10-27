"use client";

import { useCallback } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";

import { useActiveOrg } from "@/hooks/auth/AuthProvider";
import { useRealtimeChannel } from "@/hooks/realtime/useRealtimeChannel";
import { apiClient } from "@/lib/api/client";
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
) {
  return ["pipeline-leads-list", organizationId, pipelineId, page, perPage] as const;
}

export function useLeadsPaginados(pipelineId: string, page: number, perPage = 50) {
  const organizationId = useActiveOrg()?.orgId ?? null;
  const queryClient = useQueryClient();
  const queryKey = chaveDaListaDoFunil(organizationId, pipelineId, page, perPage);
  const invalidationPrefix = chaveDaListaDoFunil(organizationId, pipelineId).slice(0, 3);

  const query = useQuery({
    queryKey,
    enabled: !!organizationId && !!pipelineId,
    queryFn: () =>
      apiClient.get<PipelineLeadsPage>(
        `/api/v1/pipelines/${encodeURIComponent(pipelineId)}/leads?page=${page}&per_page=${perPage}`,
      ),
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
