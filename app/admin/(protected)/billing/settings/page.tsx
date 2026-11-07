"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { LicensingNav } from "@/components/admin/licensing/LicensingNav";
import { useT } from "@/hooks/i18n/useT";

interface Settings {
  billing_grace_days: number;
  nonpayment_policy: "SUSPEND_AFTER_GRACE" | "ALLOW_NATURAL_EXPIRATION";
  invoice_lead_days: number;
}

export default function BillingSettingsPage() {
  const t = useT();
  const [settings, setSettings] = useState<Settings | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");

  useEffect(() => {
    let active = true;
    void fetch("/api/v1/admin/billing/settings", { cache: "no-store" })
      .then(async (response) => {
        if (!response.ok) throw new Error("Política de cobrança indisponível.");
        const json = (await response.json()) as { data?: Settings };
        if (active) setSettings(json.data ?? null);
      })
      .catch((caught) => {
        if (active)
          setError(caught instanceof Error ? caught.message : "Falha ao carregar política.");
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, []);

  async function save() {
    if (!settings) return;
    setSaving(true);
    setError("");
    setNotice("");
    try {
      const response = await fetch("/api/v1/admin/billing/settings", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(settings),
      });
      const json = (await response.json()) as { data?: Settings; error?: { message?: string } };
      if (!response.ok || !json.data) throw new Error(json.error?.message || "Política não salva.");
      setSettings(json.data);
      setNotice("Política de cobrança atualizada.");
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Política não salva.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <main className="mx-auto w-full max-w-4xl space-y-6 px-4 py-6 sm:px-6 lg:px-8">
      <LicensingNav />
      <header>
        <Link href="/admin/billing" className="text-sm text-primary hover:underline">
          {t("Cobrança")}
        </Link>
        <h1 className="mt-2 text-3xl font-semibold tracking-tight">{t("Política de cobrança")}</h1>
        <p className="mt-2 text-sm text-muted-foreground">
          {t("Tolerância financeira é independente do grace period da licença.")}
        </p>
      </header>
      {notice && (
        <p
          role="status"
          className="rounded-lg border border-emerald-500/30 bg-emerald-500/5 p-3 text-sm"
        >
          {notice}
        </p>
      )}
      {error && (
        <p
          role="alert"
          className="rounded-lg border border-destructive/40 bg-destructive/5 p-3 text-sm"
        >
          {error}
        </p>
      )}
      {loading ? (
        <p
          role="status"
          className="rounded-xl border p-8 text-center text-sm text-muted-foreground"
        >
          {t("Carregando política…")}
        </p>
      ) : (
        settings && (
          <section className="space-y-5 rounded-xl border bg-card p-5 sm:p-7">
            <label className="block space-y-1.5 text-sm font-medium">
              {t("Tolerância de cobrança (dias)")}
              <input
                type="number"
                min="0"
                max="90"
                value={settings.billing_grace_days}
                onChange={(event) =>
                  setSettings({ ...settings, billing_grace_days: Number(event.target.value) })
                }
                className="h-11 w-full rounded-md border bg-background px-3 font-normal sm:max-w-sm"
              />
              <span className="block text-xs font-normal text-muted-foreground">
                {t("Após o vencimento, o status passa a past_due. O padrão é 7 dias.")}
              </span>
            </label>
            <label className="block space-y-1.5 text-sm font-medium">
              {t("Política após a tolerância")}
              <select
                value={settings.nonpayment_policy}
                onChange={(event) =>
                  setSettings({
                    ...settings,
                    nonpayment_policy: event.target.value as Settings["nonpayment_policy"],
                  })
                }
                className="h-11 w-full rounded-md border bg-background px-3 font-normal"
              >
                <option value="ALLOW_NATURAL_EXPIRATION">
                  {t("Permitir expiração natural (recomendado)")}
                </option>
                <option value="SUSPEND_AFTER_GRACE">
                  {t("Suspender licença depois da tolerância")}
                </option>
              </select>
              <span className="block text-xs font-normal text-muted-foreground">
                {t("Suspensão não revoga a licença nem apaga dados.")}
              </span>
            </label>
            <label className="block space-y-1.5 text-sm font-medium">
              {t("Gerar faturas antes do vencimento (dias)")}
              <input
                type="number"
                min="0"
                max="90"
                value={settings.invoice_lead_days}
                onChange={(event) =>
                  setSettings({ ...settings, invoice_lead_days: Number(event.target.value) })
                }
                className="h-11 w-full rounded-md border bg-background px-3 font-normal sm:max-w-sm"
              />
            </label>
            <div className="flex justify-end border-t pt-4">
              <button
                disabled={saving}
                onClick={() => void save()}
                className="rounded-md bg-primary px-5 py-2.5 text-sm font-semibold text-primary-foreground disabled:opacity-50"
              >
                {saving ? "Salvando…" : t("Salvar política")}
              </button>
            </div>
          </section>
        )
      )}
    </main>
  );
}
