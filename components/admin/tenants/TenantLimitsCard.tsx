"use client";

import { useEffect, useState } from "react";
import { toast } from "sonner";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { apiClient } from "@/lib/api/client";
import { useT } from "@/hooks/i18n/useT";

const CANAIS_DISPONIVEIS = [
  { id: "whatsapp", label: "WhatsApp (QR / Cloud)" },
  { id: "telegram", label: "Telegram (Bot & MTProto)" },
  { id: "email", label: "E-mail (Inbox)" },
  { id: "instagram", label: "Instagram Direct" },
  { id: "tiktok", label: "TikTok Direct" },
  { id: "widget", label: "Chat do Site (Widget)" },
];

export function TenantLimitsCard({ organizationId }: { organizationId: string }) {
  const t = useT();
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  const [plan, setPlan] = useState<"standard" | "pro" | "enterprise">("standard");
  const [maxUsers, setMaxUsers] = useState<number | "">("");
  const [maxChannels, setMaxChannels] = useState<number | "">("");
  const [allowedChannels, setAllowedChannels] = useState<string[]>([]);
  const [features, setFeatures] = useState({
    campaigns: true,
    ai_agent: true,
    voice_calls: false,
    comment_to_dm: true,
  });

  useEffect(() => {
    async function carregar() {
      try {
        const res = await apiClient.get<{
          data: {
            plan: "standard" | "pro" | "enterprise";
            limits: {
              max_users?: number | null;
              max_channels?: number | null;
              allowed_channels?: string[] | null;
              features?: Record<string, boolean>;
            };
          };
        }>(`/api/v1/admin/tenants/${organizationId}/limits`);

        const d = res.data;
        setPlan(d.plan || "standard");
        setMaxUsers(d.limits.max_users ?? "");
        setMaxChannels(d.limits.max_channels ?? "");
        setAllowedChannels(d.limits.allowed_channels ?? ["whatsapp", "telegram", "email", "instagram", "tiktok", "widget"]);
        if (d.limits.features) {
          setFeatures((prev) => ({ ...prev, ...d.limits.features }));
        }
      } catch {
        // Valores default caso novo
        setAllowedChannels(["whatsapp", "telegram", "email", "instagram", "tiktok", "widget"]);
      } finally {
        setLoading(false);
      }
    }
    void carregar();
  }, [organizationId]);

  function toggleCanal(id: string) {
    setAllowedChannels((prev) =>
      prev.includes(id) ? prev.filter((c) => c !== id) : [...prev, id],
    );
  }

  async function handleSalvar() {
    setSaving(true);
    try {
      await apiClient.patch(`/api/v1/admin/tenants/${organizationId}/limits`, {
        plan,
        plan_limits: {
          max_users: maxUsers === "" ? null : Number(maxUsers),
          max_channels: maxChannels === "" ? null : Number(maxChannels),
          allowed_channels: allowedChannels,
          features,
        },
      });
      toast.success(t("Plano e limites da empresa atualizados!"));
    } catch (err: unknown) {
      toast.error(err instanceof Error ? err.message : t("Falha ao salvar limites."));
    } finally {
      setSaving(false);
    }
  }

  if (loading) {
    return (
      <Card className="p-6">
        <p className="text-sm text-muted-foreground">{t("Carregando limites da empresa…")}</p>
      </Card>
    );
  }

  return (
    <Card className="p-6 space-y-6">
      <div className="flex items-center justify-between border-b pb-4">
        <div>
          <h2 className="text-lg font-semibold">{t("Plano, Quotas e Canais Liberados")}</h2>
          <p className="text-sm text-muted-foreground">
            {t("Defina quais canais, funções e quantidade de usuários esta empresa pode usar.")}
          </p>
        </div>
        <Badge variant="outline" className="text-xs uppercase">
          {plan}
        </Badge>
      </div>

      <div className="grid gap-4 sm:grid-cols-3">
        <div className="space-y-2">
          <Label>{t("Plano Contratado")}</Label>
          <select
            value={plan}
            onChange={(e) => setPlan(e.target.value as "standard" | "pro" | "enterprise")}
            className="h-9 w-full rounded-md border border-border bg-surface px-2 text-sm"
          >
            <option value="standard">{t("Standard (Básico)")}</option>
            <option value="pro">Pro (Profissional)</option>
            <option value="enterprise">Enterprise (Ilimitado)</option>
          </select>
        </div>

        <div className="space-y-2">
          <Label htmlFor="max-u">{t("Limite de Usuários / Atendentes")}</Label>
          <Input
            id="max-u"
            type="number"
            min={1}
            placeholder={t("Ilimitado se vazio")}
            value={maxUsers}
            onChange={(e) => setMaxUsers(e.target.value === "" ? "" : Number(e.target.value))}
          />
        </div>

        <div className="space-y-2">
          <Label htmlFor="max-c">{t("Limite de Números / Canais")}</Label>
          <Input
            id="max-c"
            type="number"
            min={1}
            placeholder={t("Ilimitado se vazio")}
            value={maxChannels}
            onChange={(e) => setMaxChannels(e.target.value === "" ? "" : Number(e.target.value))}
          />
        </div>
      </div>

      <div className="space-y-3">
        <Label className="font-medium">{t("Canais Autorizados para este Cliente")}</Label>
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
          {CANAIS_DISPONIVEIS.map((c) => (
            <label
              key={c.id}
              className={`flex items-center gap-2 rounded-lg border p-3 text-sm cursor-pointer transition-colors ${
                allowedChannels.includes(c.id)
                  ? "border-emerald-500 bg-emerald-500/10 font-medium text-emerald-700 dark:text-emerald-400"
                  : "border-border text-muted-foreground opacity-70"
              }`}
            >
              <input
                type="checkbox"
                checked={allowedChannels.includes(c.id)}
                onChange={() => toggleCanal(c.id)}
              />
              <span>{c.label}</span>
            </label>
          ))}
        </div>
      </div>

      <div className="space-y-3">
        <Label className="font-medium">{t("Módulos Habilitados")}</Label>
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={features.campaigns}
              onChange={(e) => setFeatures((p) => ({ ...p, campaigns: e.target.checked }))}
            />
            <span>{t("Disparador / Campanhas")}</span>
          </label>
          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={features.ai_agent}
              onChange={(e) => setFeatures((p) => ({ ...p, ai_agent: e.target.checked }))}
            />
            <span>{t("Agentes de IA")}</span>
          </label>
          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={features.voice_calls}
              onChange={(e) => setFeatures((p) => ({ ...p, voice_calls: e.target.checked }))}
            />
            <span>{t("Chamadas de Voz")}</span>
          </label>
          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={features.comment_to_dm}
              onChange={(e) => setFeatures((p) => ({ ...p, comment_to_dm: e.target.checked }))}
            />
            <span>{t("Comentário para DM")}</span>
          </label>
        </div>
      </div>

      <div className="flex justify-end pt-2">
        <Button onClick={handleSalvar} disabled={saving}>
          {saving ? t("Salvando limites…") : t("Salvar Configurações do Cliente")}
        </Button>
      </div>
    </Card>
  );
}
