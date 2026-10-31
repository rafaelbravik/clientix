"use client";
import * as React from "react";
import { useQuery } from "@tanstack/react-query";

import { apiClient } from "@/lib/api/client";
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { PROVEDORES } from "@/lib/ai/pontos/provedores";
import { useT } from "@/hooks/i18n/useT";
import { useOptionalActiveOrg } from "@/hooks/auth/AuthProvider";
import { ApiError } from "@/lib/api/types";
import { CHATGPT_SUBSCRIPTION_PROVIDER } from "@/lib/ai/credenciais/chatgpt-subscription-constants";

/**
 * Derivado de `lib/ai/pontos/provedores.ts` — a mesma lista única da tela de
 * Credenciais e da rota. Como literal aqui, o seletor de modelo do agente não
 * conseguia representar um agente publicado em OpenRouter.
 */
export type Provider = (typeof PROVEDORES)[number]["id"] | typeof CHATGPT_SUBSCRIPTION_PROVIDER;

export function providerModelsQueryKey(organizationId: string | null, provider: Provider) {
  return ["ai", "providers", organizationId ?? "no-active-org", provider, "models"] as const;
}

export interface ModelOption {
  provider: Provider;
  model_id: string;
  display_name: string;
  context_window: number | null;
  is_default_for_provider: boolean;
}

interface Props {
  provider: Provider;
  value: string;
  onChange: (modelId: string, ctx?: { contextWindow: number | null }) => void;
  disabled?: boolean;
  id?: string;
  /**
   * Texto do estado "nada escolhido". Existe porque nem todo uso deste seletor
   * trata vazio como erro: no papel Operador, vazio SIGNIFICA "usa o mesmo
   * modelo que conversa", e chamar isso de "Selecione um modelo" mentiria.
   */
  placeholder?: string;
}

interface ApiResponse {
  data: { models: ModelOption[] };
}

function useModelList(provider: Provider) {
  const organizationId = useOptionalActiveOrg()?.orgId ?? null;
  return useQuery({
    queryKey: providerModelsQueryKey(organizationId, provider),
    queryFn: async () => {
      if (!organizationId) throw new Error("no_active_org");
      const res = await apiClient.get<ApiResponse>(`/api/v1/ai/providers/${provider}/models`);
      return res.data.models;
    },
    enabled: Boolean(organizationId),
    staleTime: 60_000,
  });
}

function mensagemDoErroDaAssinatura(error: unknown, t: (text: string) => string): string {
  const code = error instanceof ApiError ? error.code : "";
  if (code === "feature_disabled") return t("Este recurso está desativado nesta instalação.");
  if (code === "not_connected") return t("Conecte a assinatura do ChatGPT em IA › Credenciais.");
  if (code === "credential_unreadable") return t("Não foi possível ler a conexão salva. Revise IA › Credenciais.");
  if (code === "credential_storage_failed") return t("Não foi possível atualizar a conexão salva. Revise IA › Credenciais.");
  if (code === "token_refresh_failed") return t("A conexão da conta precisa ser renovada. Reconecte em IA › Credenciais.");
  return t("Não foi possível atualizar o catálogo. A conta continua conectada; tente novamente.");
}

export function ModelPicker({ provider, value, onChange, disabled, id, placeholder }: Props) {
  const t = useT();
  const query = useModelList(provider);

  const models = query.data ?? [];
  const assinatura = provider === CHATGPT_SUBSCRIPTION_PROVIDER;

  if (assinatura && query.isError) {
    return (
      <div className="space-y-1">
        <Label htmlFor={id}>{t("Modelo")}</Label>
        <p className="text-xs text-destructive" role="alert">
          {mensagemDoErroDaAssinatura(query.error, t)}
        </p>
        <button
          type="button"
          className="text-xs font-medium text-foreground underline underline-offset-4 disabled:opacity-50"
          onClick={() => void query.refetch()}
          disabled={disabled || query.isFetching}
        >
          {query.isFetching ? t("Atualizando…") : t("Tentar novamente")}
        </button>
      </div>
    );
  }

  if (assinatura && !query.isLoading && models.length === 0) {
    return (
      <div className="space-y-1">
        <Label htmlFor={id}>{t("Modelo")}</Label>
        <Select disabled value={undefined}>
          <SelectTrigger id={id}>
            <SelectValue placeholder={t("Nenhum modelo disponível na conta conectada")} />
          </SelectTrigger>
          <SelectContent />
        </Select>
        <p className="text-xs text-muted-foreground">
          {t("A conta está conectada, mas não há modelos disponíveis para seleção.")}
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-1">
      <Label htmlFor={id}>{t("Modelo")}</Label>
      {models.length === 0 && !query.isLoading && !assinatura ? (
        <Input
          id={id}
          value={value}
          onChange={(e) => onChange(e.target.value, { contextWindow: null })}
          placeholder={t("Digite o identificador do modelo")}
          disabled={disabled}
        />
      ) : (
        <Select
          value={value || undefined}
          onValueChange={(v) => {
            const m = models.find((m) => m.model_id === v);
            onChange(v, { contextWindow: m?.context_window ?? null });
          }}
          disabled={disabled || query.isLoading}
        >
          <SelectTrigger id={id}>
            <SelectValue
              placeholder={
                query.isLoading ? t("Carregando…") : (placeholder ?? t("Selecione um modelo"))
              }
            />
          </SelectTrigger>
          <SelectContent>
            {models.map((m) => (
              <SelectItem key={m.model_id} value={m.model_id}>
                {m.display_name}
                {m.is_default_for_provider ? ` · ${t("default")}` : ""}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      )}
    </div>
  );
}

export function useModelMeta(provider: Provider, modelId: string): ModelOption | null {
  const query = useModelList(provider);
  return (query.data ?? []).find((m) => m.model_id === modelId) ?? null;
}
