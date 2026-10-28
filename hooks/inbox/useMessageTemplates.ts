"use client";
import { useActiveOrg, usePermission } from "@/hooks/auth/AuthProvider";
import { useQuery } from "@tanstack/react-query";
import { apiClient } from "@/lib/api/client";

export interface MessageTemplate {
  id: string;
  title: string;
  body: string;
  shortcut: string | null;
  owner_user_id: string | null;
  /** False hides only the composer bar; the / menu intentionally stays complete. */
  mostrar_na_barra?: boolean;
}

/** Onda 5: templates de script (pessoais + compartilhados) para o slash-menu do composer. */
export function useMessageTemplates() {
  const podeConsultar = usePermission("message-templates.view");
  const activeOrg = useActiveOrg();
  return useQuery({
    enabled: podeConsultar && !!activeOrg?.orgId,
    queryKey: ["message-templates", activeOrg?.orgId],
    queryFn: async () => apiClient.get<{ data: MessageTemplate[] }>("/api/v1/message-templates"),
    staleTime: 60_000,
    select: (res) => res.data,
  });
}
