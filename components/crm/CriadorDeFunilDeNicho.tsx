"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { TEMPLATES_DE_NICHO, type NichoTemplate } from "@/lib/crm/templates-de-nicho";
import { apiClient } from "@/lib/api/client";
import { useT } from "@/hooks/i18n/useT";

export function CriadorDeFunilDeNicho({ onCriado }: { onCriado?: () => void }) {
  const t = useT();
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [selectedNicho, setSelectedNicho] = useState<NichoTemplate | null>(null);
  const [nomeFunil, setNomeFunil] = useState("");
  const [saving, setSaving] = useState(false);

  function selecionarTemplate(template: NichoTemplate) {
    setSelectedNicho(template);
    setNomeFunil(template.name);
  }

  async function handleCriar() {
    if (!nomeFunil.trim()) {
      toast.error(t("Informe um nome para o funil"));
      return;
    }

    setSaving(true);
    try {
      const payload: Record<string, unknown> = {
        name: nomeFunil.trim(),
      };

      if (selectedNicho) {
        payload.vocabulary = selectedNicho.vocabulary;
        payload.settings = {
          lost_reasons: selectedNicho.lost_reasons,
          won_reasons: selectedNicho.won_reasons,
        };
        payload.stages = selectedNicho.stages;
      }

      await apiClient.post("/api/v1/pipelines", payload);
      toast.success(t("Funil criado com sucesso!"));
      setOpen(false);
      setSelectedNicho(null);
      setNomeFunil("");
      onCriado?.();
      router.refresh();
    } catch (err: unknown) {
      toast.error(err instanceof Error ? err.message : t("Falha ao criar funil"));
    } finally {
      setSaving(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button className="gap-2">
          <span>+</span>
          <span>{t("Novo Funil por Nicho")}</span>
        </Button>
      </DialogTrigger>
      <DialogContent className="max-w-3xl max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{t("Criar Novo Funil de Vendas (Kanban)")}</DialogTitle>
          <DialogDescription>
            {t("Escolha um modelo de nicho pré-configurado com etapas, vocabulário e motivos de perda ou crie em branco.")}
          </DialogDescription>
        </DialogHeader>

        {!selectedNicho ? (
          <div className="space-y-4 pt-2">
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              {TEMPLATES_DE_NICHO.map((nicho) => (
                <div
                  key={nicho.id}
                  onClick={() => selecionarTemplate(nicho)}
                  className="flex flex-col justify-between p-4 rounded-lg border border-border bg-surface hover:border-emerald-500 hover:bg-emerald-500/5 cursor-pointer transition-all text-left group"
                >
                  <div className="space-y-1">
                    <div className="flex items-center gap-2">
                      <span className="text-2xl">{nicho.icone}</span>
                      <h4 className="font-semibold text-sm group-hover:text-emerald-600 transition-colors">
                        {nicho.name}
                      </h4>
                    </div>
                    <p className="text-xs text-muted-foreground leading-relaxed">
                      {nicho.descricao}
                    </p>
                  </div>
                  <div className="mt-3 flex flex-wrap gap-1 text-[10px] text-muted-foreground">
                    <Badge variant="secondary" className="text-[10px] py-0 px-1.5">
                      {nicho.stages.length} etapas
                    </Badge>
                    <Badge variant="outline" className="text-[10px] py-0 px-1.5">
                      Lead: {nicho.vocabulary.lead}
                    </Badge>
                  </div>
                </div>
              ))}
            </div>

            <div className="pt-2 text-center">
              <Button
                variant="ghost"
                size="sm"
                onClick={() => {
                  setSelectedNicho({
                    id: "custom",
                    name: "Funil Geral de Vendas",
                    icone: "⚡",
                    descricao: "Funil clássico com etapas de primeiro contato, proposta e fechamento.",
                    vocabulary: { lead: "Lead", deal: "Negócio", won: "Ganho", lost: "Perdido" },
                    stages: [
                      { name: "Primeiro contato", slug: "contato" },
                      { name: "Proposta", slug: "proposta" },
                      { name: "Negociação", slug: "negociacao" },
                      { name: "Fechado", slug: "fechado", is_won: true },
                      { name: "Perdido", slug: "perdido", is_lost: true },
                    ],
                    lost_reasons: ["Preço", "Sem interesse", "Optou por concorrente"],
                    won_reasons: ["Proposta aceita"],
                  });
                  setNomeFunil("Funil Geral de Vendas");
                }}
              >
                {t("Ou criar um funil simples em branco")}
              </Button>
            </div>
          </div>
        ) : (
          <div className="space-y-5 pt-2">
            <div className="flex items-center justify-between border-b pb-3">
              <div className="flex items-center gap-3">
                <span className="text-3xl">{selectedNicho.icone}</span>
                <div>
                  <h3 className="font-semibold">{selectedNicho.name}</h3>
                  <p className="text-xs text-muted-foreground">{selectedNicho.descricao}</p>
                </div>
              </div>
              <Button variant="ghost" size="sm" onClick={() => setSelectedNicho(null)}>
                {t("Trocar nicho")}
              </Button>
            </div>

            <div className="space-y-2">
              <Label htmlFor="funil-nome">{t("Nome do Funil")}</Label>
              <Input
                id="funil-nome"
                value={nomeFunil}
                onChange={(e) => setNomeFunil(e.target.value)}
                placeholder={t("Ex.: Atendimento Clínica Principal")}
              />
            </div>

            <div className="space-y-2">
              <Label className="text-xs font-medium text-muted-foreground uppercase tracking-wider">
                {t("Vocabulário Aplicado")}
              </Label>
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 text-xs">
                <div className="p-2 rounded-md bg-muted/60 border">
                  <span className="text-muted-foreground block text-[10px]">Lead</span>
                  <span className="font-medium">{selectedNicho.vocabulary.lead}</span>
                </div>
                <div className="p-2 rounded-md bg-muted/60 border">
                  <span className="text-muted-foreground block text-[10px]">{t("Negócio (Deal)")}</span>
                  <span className="font-medium">{selectedNicho.vocabulary.deal}</span>
                </div>
                <div className="p-2 rounded-md bg-muted/60 border">
                  <span className="text-muted-foreground block text-[10px]">{t("Ganho (Won)")}</span>
                  <span className="font-medium">{selectedNicho.vocabulary.won}</span>
                </div>
                <div className="p-2 rounded-md bg-muted/60 border">
                  <span className="text-muted-foreground block text-[10px]">Perdido (Lost)</span>
                  <span className="font-medium">{selectedNicho.vocabulary.lost}</span>
                </div>
              </div>
            </div>

            <div className="space-y-2">
              <Label className="text-xs font-medium text-muted-foreground uppercase tracking-wider">
                {t("Etapas do Kanban que serão criadas")}
              </Label>
              <div className="flex flex-wrap gap-1.5">
                {selectedNicho.stages.map((etapa, idx) => (
                  <Badge
                    key={etapa.slug}
                    variant={etapa.is_won ? "default" : etapa.is_lost ? "destructive" : "secondary"}
                    className="text-xs py-1"
                  >
                    {idx + 1}. {etapa.name}
                    {etapa.expected_duration_hours && ` (${etapa.expected_duration_hours}h)`}
                  </Badge>
                ))}
              </div>
            </div>

            <div className="flex justify-end gap-2 pt-3 border-t">
              <Button variant="outline" onClick={() => setSelectedNicho(null)} disabled={saving}>
                {t("Voltar")}
              </Button>
              <Button onClick={handleCriar} disabled={saving} className="gap-2">
                {saving ? t("Criando funil…") : t("Criar Funil com este Modelo")}
              </Button>
            </div>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
