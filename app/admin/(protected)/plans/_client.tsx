"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useT } from "@/hooks/i18n/useT";

const FEATURES = [
  ["campaigns", "Campanhas"],
  ["ai_agent", "Agente de IA"],
  ["voice_calls", "Chamadas de voz"],
  ["comment_to_dm", "Comentário para mensagem"],
] as const;

type FeatureKey = (typeof FEATURES)[number][0];
type PlanFeatures = Record<FeatureKey, boolean>;

export interface PlatformPlan {
  slug: "standard" | "pro" | "enterprise";
  name: string;
  active: boolean;
  max_users: number | null;
  max_channels: number | null;
  allowed_channels: string[] | null;
  features: PlanFeatures;
  updated_at: string;
}

function numberOrUnlimited(value: string): number | null | undefined {
  if (value === "") return null;
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : undefined;
}

export function PlatformPlansClient({
  initialPlans,
  canEdit,
}: {
  initialPlans: PlatformPlan[];
  canEdit: boolean;
}) {
  const t = useT();
  const [plans, setPlans] = useState(initialPlans);
  const [saving, setSaving] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);

  function updatePlan(slug: PlatformPlan["slug"], update: Partial<PlatformPlan>) {
    setPlans((current) => current.map((plan) => plan.slug === slug ? { ...plan, ...update } : plan));
  }

  async function save(plan: PlatformPlan) {
    setSaving(plan.slug);
    setError(null);
    setSuccess(null);
    const maxUsers = numberOrUnlimited(String(plan.max_users ?? ""));
    const maxChannels = numberOrUnlimited(String(plan.max_channels ?? ""));
    if (maxUsers === undefined || maxChannels === undefined) {
      setError(t("Informe um limite inteiro positivo ou deixe vazio para ilimitado."));
      setSaving(null);
      return;
    }
    try {
      const response = await fetch("/api/v1/admin/plans", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          slug: plan.slug,
          name: plan.name,
          active: plan.active,
          max_users: maxUsers,
          max_channels: maxChannels,
          allowed_channels: plan.allowed_channels,
          features: plan.features,
        }),
      });
      const payload = await response.json() as { data?: PlatformPlan; error?: { message?: string } };
      if (!response.ok || !payload.data) {
        setError(payload.error?.message ?? t("Não foi possível salvar o plano."));
        return;
      }
      updatePlan(plan.slug, payload.data);
      setSuccess(t("Plano salvo. As verificações de quota passam a usar estes valores."));
    } catch {
      setError(t("Não foi possível falar com o servidor."));
    } finally {
      setSaving(null);
    }
  }

  return (
    <div className="space-y-6">
      <header>
        <h1 className="text-2xl font-semibold tracking-tight">{t("Planos")}</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          {t("Os slugs existentes permanecem estáveis. Atribuição, limites e recursos usam o mesmo catálogo consultado por checkFeatureQuota.")}
        </p>
      </header>
      {!canEdit && (
        <p className="rounded-md border bg-muted/40 p-3 text-sm" role="status">
          {t("Seu papel de administrador global permite consultar os planos. Alterações são restritas ao proprietário.")}
        </p>
      )}
      {error && <p className="rounded-md border border-destructive/40 p-3 text-sm text-destructive" role="alert">{error}</p>}
      {success && <p className="rounded-md border border-accent/40 p-3 text-sm" role="status">{success}</p>}
      <div className="grid gap-4 xl:grid-cols-3">
        {plans.map((plan) => (
          <Card key={plan.slug}>
            <CardHeader>
              <CardTitle className="flex items-center justify-between gap-3">
                <span>{plan.name}</span>
                <span className="font-mono text-xs text-muted-foreground">{plan.slug}</span>
              </CardTitle>
              <CardDescription>{t("Limites e recursos efetivos deste nível para novas e atuais empresas.")}</CardDescription>
            </CardHeader>
            <CardContent>
              <form
                className="space-y-4"
                onSubmit={(event) => {
                  event.preventDefault();
                  void save(plan);
                }}
              >
                <div className="space-y-2">
                  <Label htmlFor={"plan-name-" + plan.slug}>{t("Nome exibido")}</Label>
                  <Input
                    id={"plan-name-" + plan.slug}
                    value={plan.name}
                    maxLength={80}
                    onChange={(event) => updatePlan(plan.slug, { name: event.target.value })}
                    disabled={!canEdit || saving !== null}
                  />
                </div>
                <div className="grid grid-cols-2 gap-3">
                  <div className="space-y-2">
                    <Label htmlFor={"plan-users-" + plan.slug}>{t("Usuários")}</Label>
                    <Input id={"plan-users-" + plan.slug} type="number" min={1} value={plan.max_users ?? ""} placeholder={t("Ilimitado")} onChange={(event) => updatePlan(plan.slug, { max_users: event.target.value === "" ? null : Number(event.target.value) })} disabled={!canEdit || saving !== null} />
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor={"plan-channels-" + plan.slug}>{t("Canais")}</Label>
                    <Input id={"plan-channels-" + plan.slug} type="number" min={1} value={plan.max_channels ?? ""} placeholder={t("Ilimitado")} onChange={(event) => updatePlan(plan.slug, { max_channels: event.target.value === "" ? null : Number(event.target.value) })} disabled={!canEdit || saving !== null} />
                  </div>
                </div>
                <div className="space-y-2">
                  <Label htmlFor={"plan-channel-list-" + plan.slug}>{t("Canais permitidos")}</Label>
                  <Input
                    id={"plan-channel-list-" + plan.slug}
                    value={plan.allowed_channels?.join(", ") ?? ""}
                    placeholder={t("Todos")}
                    onChange={(event) => updatePlan(plan.slug, { allowed_channels: event.target.value.trim() ? event.target.value.split(",").map((value) => value.trim()).filter(Boolean) : null })}
                    disabled={!canEdit || saving !== null}
                  />
                </div>
                <fieldset className="space-y-2">
                  <legend className="text-sm font-medium">{t("Recursos")}</legend>
                  <div className="grid gap-2 sm:grid-cols-2">
                    {FEATURES.map(([key]) => (
                      <label key={key} className="flex items-center gap-2 text-sm">
                        <input
                          type="checkbox"
                          checked={plan.features[key]}
                          onChange={(event) => updatePlan(plan.slug, { features: { ...plan.features, [key]: event.target.checked } })}
                          disabled={!canEdit || saving !== null}
                        />
                        {key === "campaigns"
                          ? t("Campanhas")
                          : key === "ai_agent"
                            ? t("Agente de IA")
                            : key === "voice_calls"
                              ? t("Chamadas de voz")
                              : t("Comentário para mensagem")}
                      </label>
                    ))}
                  </div>
                </fieldset>
                <label className="flex items-center gap-2 text-sm">
                  <input type="checkbox" checked={plan.active} onChange={(event) => updatePlan(plan.slug, { active: event.target.checked })} disabled={!canEdit || saving !== null} />
                  {t("Plano disponível para atribuição")}
                </label>
                {canEdit && (
                  <Button type="submit" disabled={saving !== null}>
                    {saving === plan.slug ? t("Salvando...") : t("Salvar plano")}
                  </Button>
                )}
              </form>
            </CardContent>
          </Card>
        ))}
      </div>
    </div>
  );
}
