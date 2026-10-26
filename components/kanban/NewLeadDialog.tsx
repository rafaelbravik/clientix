"use client";

import { useActiveOrg } from "@/hooks/auth/AuthProvider";
import { useT } from "@/hooks/i18n/useT";
import { useEffect, useMemo, useState } from "react";
import { useForm } from "react-hook-form";
import { toast } from "sonner";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useCreateLead } from "@/hooks/kanban/useCreateLead";
import type { CustomFieldDef } from "@/lib/schemas/settings";
import {
  LEAD_ATTACHMENT_MAX_FILES,
  LEAD_ATTACHMENT_MIME_TYPES,
  validateLeadAttachment,
} from "@/lib/leads/attachment-validation";
import type { Stage } from "@/lib/kanban/types";
import { createLeadSchema, type CreateLeadInput } from "@/lib/schemas/leads";
import { MOEDA_PADRAO, parseReaisToCents, simboloDaMoeda } from "@/lib/money";
import { rotuloDoContato } from "@/lib/contacts/rotulo-do-contato";
import type { Contact } from "@/lib/types/contacts";
import { EcoDoValor } from "./EcoDoValor";
import { SeletorDeContato } from "./SeletorDeContato";

interface FormShape {
  title: string;
  description: string;
  stage_id: string;
  valueReais: string;
  tagsRaw: string;
  expected_close_date: string;
}

interface Props {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  pipelineId: string;
  stages: Stage[];
  /** Vincula o lead criado a este contato de origem (ex.: painel do Inbox). */
  contactId?: string | null;
  /** Depois do INSERT — o inbox relê o resumo para o lead novo aparecer no formulário. */
  onCreated?: () => void;
  fieldDefs?: CustomFieldDef[];
}

function defaultStageId(stages: Stage[]): string {
  const open = stages.find((s) => !s.is_won && !s.is_lost && !s.is_archived);
  return open?.id ?? stages[0]?.id ?? "";
}

export function NewLeadDialog({
  open,
  onOpenChange,
  pipelineId,
  stages,
  contactId,
  onCreated,
  fieldDefs = [],
}: Props) {
  const t = useT();
  const org = useActiveOrg();
  // Negócio NOVO nasce na moeda da organização (createLeadHandler).
  const moedaDoValor = org?.currency ?? MOEDA_PADRAO;
  const create = useCreateLead(pipelineId);
  const initialStage = useMemo(() => defaultStageId(stages), [stages]);
  // Quem abre o diálogo já sabendo o contato (Inbox) não escolhe de novo.
  const [contato, setContato] = useState<Contact | null>(null);
  const [arquivosPendentes, setArquivosPendentes] = useState<Record<string, File[]>>({});
  const [errosDeArquivo, setErrosDeArquivo] = useState<Record<string, string>>({});
  // O contato é o único campo deste diálogo que cria VÍNCULO, e o componente
  // NÃO desmonta ao fechar: o funil o mantém montado enquanto há dados
  // (`app/app/pipelines/[id]/_client.tsx`). Sem esquecê-lo, quem escolheu um
  // contato, desistiu e fechou reabre com ele ainda selecionado — e o próximo
  // negócio nasce ligado a quem o operador desistiu de usar, sem nada na tela
  // dizendo. A limpeza é feita no RENDER, comparando com o valor anterior, e
  // não em `onOpenChange`: o botão "Cancelar" chama o `onOpenChange` do PAI
  // direto, então um wrapper aqui não cobriria esse caminho. É o padrão que o
  // React documenta para ajustar estado quando uma prop muda — sem efeito, e
  // portanto sem o aviso de `react-hooks/set-state-in-effect`.
  const [estavaAberto, setEstavaAberto] = useState(open);
  if (open !== estavaAberto) {
    setEstavaAberto(open);
    if (!open) {
      setContato(null);
      setArquivosPendentes({});
      setErrosDeArquivo({});
    }
  }

  const form = useForm<FormShape>({
    defaultValues: {
      title: "",
      description: "",
      stage_id: initialStage,
      valueReais: "",
      tagsRaw: "",
      expected_close_date: "",
    },
  });

  // Reset stage_id default if stages change while dialog mounted.
  useEffect(() => {
    if (!form.getValues("stage_id") && initialStage) {
      form.setValue("stage_id", initialStage);
    }
  }, [initialStage, form]);

  async function onSubmit(values: FormShape) {
    const erroDeArquivo = Object.values(errosDeArquivo)[0];
    if (erroDeArquivo) {
      toast.error(erroDeArquivo);
      return;
    }
    const tags = values.tagsRaw
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);

    const reais = values.valueReais.trim();
    let valueCents: number | null = null;
    if (reais.length > 0) {
      valueCents = parseReaisToCents(reais, moedaDoValor);
      if (valueCents === null) {
        form.setError("valueReais", { message: t("Valor inválido") });
        return;
      }
    }

    const payload: Record<string, unknown> = {
      pipeline_id: pipelineId,
      stage_id: values.stage_id,
      title: values.title.trim(),
      // A moeda NÃO vai daqui. O browser não sabe a moeda da organização, e
      // mandar "BRL" fazia toda instalação em peso ou dólar cadastrar lead em
      // real. Omitir é o conserto: quem decide é o servidor, que lê a
      // organização (`moedaDaOrganizacao`, em `createLeadHandler`).
      source: "manual",
      tags,
    };
    const idDoContato = contactId ?? contato?.id ?? null;
    if (idDoContato) payload.contact_id = idDoContato;
    if (values.description.trim()) payload.description = values.description.trim();
    if (valueCents !== null) payload.value_cents = valueCents;
    if (values.expected_close_date) payload.expected_close_date = values.expected_close_date;

    const parsed = createLeadSchema.safeParse(payload);
    if (!parsed.success) {
      const first = parsed.error.issues[0];
      toast.error(first?.message ?? t("Dados inválidos"));
      return;
    }

    try {
      const response = await create.mutateAsync(parsed.data as CreateLeadInput);
      const leadId = response.data.id;
      let falhouAnexo = false;
      for (const campo of fieldDefs.filter((f) => f.type === "file")) {
        const arquivos = arquivosPendentes[campo.key] ?? [];
        if (arquivos.length === 0) continue;
        const formData = new FormData();
        formData.set("custom_field_key", campo.key);
        for (const arquivo of arquivos) formData.append("files", arquivo, arquivo.name);
        const upload = await fetch(`/api/v1/leads/${encodeURIComponent(leadId)}/attachments`, {
          method: "POST",
          credentials: "same-origin",
          body: formData,
        }).catch(() => null);
        if (!upload?.ok) {
          falhouAnexo = true;
          break;
        }
      }
      if (falhouAnexo) toast.error(t("Lead criado, mas um ou mais anexos não foram enviados. Abra o dossiê para tentar novamente."));
      else toast.success(t("Lead criado"));
      onCreated?.();
      form.reset({
        title: "",
        description: "",
        stage_id: initialStage,
        valueReais: "",
        tagsRaw: "",
        expected_close_date: "",
      });
      setContato(null);
      setArquivosPendentes({});
      setErrosDeArquivo({});
      onOpenChange(false);
    } catch {
      // toast already shown
    }
  }

  const stageId = form.watch("stage_id");
  // Negócio sem pessoa não tem para quem o WhatsApp falar nem com quem a
  // automação casar. Dizer isso na hora vale mais que travar: quem abre o card
  // no meio da ligação e completa depois continua conseguindo, e a importação e
  // as automações seguem criando sem contato de propósito.
  const faltaContato = !contactId && !contato;

  function escolherContato(escolhido: Contact | null) {
    setContato(escolhido);
    if (escolhido && !form.getValues("title").trim()) {
      form.setValue("title", rotuloDoContato(escolhido, t));
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[calc(100dvh-2rem)] w-[calc(100vw-2rem)] overflow-y-auto sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{t("Novo Lead")}</DialogTitle>
          <DialogDescription>
            {t("Crie um lead manualmente neste pipeline.")}
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-4">
          {!contactId && (
            <>
              <SeletorDeContato escolhido={contato} onEscolher={escolherContato} />
              {faltaContato && (
                <p className="text-xs text-muted-foreground">
                  {t("Sem contato, este lead não recebe WhatsApp nem entra nas automações.")}
                </p>
              )}
            </>
          )}

          <div className="space-y-2">
            <Label htmlFor="title">{t("Título")}</Label>
            <Input
              id="title"
              placeholder={t("Ex: Pedido Maria — combo presente")}
              {...form.register("title", { required: true, minLength: 2 })}
            />
          </div>

          <div className="space-y-2">
            <Label htmlFor="description">{t("Descrição")}</Label>
            <Textarea
              id="description"
              rows={3}
              placeholder={t("Contexto, observações, links…")}
              {...form.register("description")}
            />
          </div>

          <div className="space-y-2">
            <Label>{t("Etapa")}</Label>
            <Select
              value={stageId}
              onValueChange={(v) => form.setValue("stage_id", v)}
            >
              <SelectTrigger>
                <SelectValue placeholder={t("Selecione a etapa")} />
              </SelectTrigger>
              <SelectContent>
                {stages
                  .filter((s) => !s.is_archived)
                  .map((s) => (
                    <SelectItem key={s.id} value={s.id}>
                      {s.name}
                    </SelectItem>
                  ))}
              </SelectContent>
            </Select>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-2">
              {/* Negócio novo: o rótulo segue a moeda da organização, que é onde ele
                  vai nascer. `R$` em duro mentia para quem opera em euro. */}
              <Label htmlFor="valueReais">{t("Valor")} ({simboloDaMoeda(moedaDoValor)})</Label>
              <Input
                id="valueReais"
                inputMode="decimal"
                placeholder="0,00"
                {...form.register("valueReais")}
              />
              <EcoDoValor control={form.control} moeda={moedaDoValor} />
              {form.formState.errors.valueReais && (
                <p className="text-xs text-error-fg">
                  {form.formState.errors.valueReais.message}
                </p>
              )}
            </div>
            <div className="space-y-2">
              <Label htmlFor="expected_close_date">{t("Fechamento previsto")}</Label>
              <Input
                id="expected_close_date"
                type="date"
                {...form.register("expected_close_date")}
              />
            </div>
          </div>

          <div className="space-y-2">
            <Label htmlFor="tagsRaw">{t("Tags (separadas por vírgula)")}</Label>
            <Input
              id="tagsRaw"
              placeholder="vip, recompra"
              {...form.register("tagsRaw")}
            />
          </div>

          {fieldDefs.some((campo) => campo.type === "file") && (
            <section className="space-y-3 border-t border-border pt-4" aria-label={t("Anexos do negócio")}>
              <p className="text-sm font-medium">{t("Anexos do negócio")}</p>
              {fieldDefs.filter((campo) => campo.type === "file").map((campo) => {
                const selecionados = arquivosPendentes[campo.key] ?? [];
                const limite = campo.multiple ? LEAD_ATTACHMENT_MAX_FILES : 1;
                return (
                  <div key={campo.key} className="space-y-2">
                    <Label htmlFor={`novo-file-${campo.key}`}>
                      {campo.label}{campo.required && <span className="ml-1 text-error-fg">*</span>}
                    </Label>
                    <input
                      id={`novo-file-${campo.key}`}
                      className="block min-w-0 w-full text-sm file:mr-3 file:min-h-11 file:rounded-sm file:border-0 file:bg-accent-soft file:px-3 file:text-sm file:font-medium file:text-text"
                      type="file"
                      accept={LEAD_ATTACHMENT_MIME_TYPES.join(",")}
                      multiple={campo.multiple === true}
                      disabled={create.isPending}
                      onChange={async (event) => {
                        const files = Array.from(event.currentTarget.files ?? []);
                        event.currentTarget.value = "";
                        if (files.length > limite) {
                          setErrosDeArquivo((current) => ({ ...current, [campo.key]: t("Este campo aceita até {limite} arquivo(s).").replace("{limite}", String(limite)) }));
                          return;
                        }
                        for (const file of files) {
                          const validation = validateLeadAttachment({
                            name: file.name,
                            type: file.type,
                            size: file.size,
                            bytes: new Uint8Array(await file.arrayBuffer()),
                          });
                          if (!validation.ok) {
                            setErrosDeArquivo((current) => ({
                              ...current,
                              [campo.key]: t("Cada arquivo deve ser PDF, PNG, JPEG ou WebP válido e ter até 5 MB."),
                            }));
                            return;
                          }
                        }
                        setArquivosPendentes((current) => ({
                          ...current,
                          [campo.key]: files,
                        }));
                        setErrosDeArquivo((current) => {
                          const next = { ...current };
                          delete next[campo.key];
                          return next;
                        });
                      }}
                    />
                    <p className="text-xs text-muted-foreground">{t("PDF, PNG, JPEG ou WebP · até 5 MB por arquivo")} · {t("máximo {limite}").replace("{limite}", String(limite))}</p>
                    {selecionados.length > 0 && <p className="break-all text-xs text-muted-foreground">{selecionados.map((file) => file.name).join(", ")}</p>}
                    {errosDeArquivo[campo.key] && <p role="alert" className="text-xs text-error-fg">{errosDeArquivo[campo.key]}</p>}
                    {campo.required && !selecionados.length && <p role="status" className="text-xs text-warning-fg">{t("Anexe o arquivo no dossiê após criar o negócio.")}</p>}
                  </div>
                );
              })}
            </section>
          )}

          <DialogFooter>
            <Button
              type="button"
              variant="ghost"
              onClick={() => onOpenChange(false)}
              disabled={create.isPending}
            >
              {t("Cancelar")}
            </Button>
            <Button type="submit" disabled={create.isPending || !stageId}>
              {create.isPending ? t("Criando…") : t("Criar lead")}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
