"use client";
import { useRef, useState } from "react";
import { useT } from "@/hooks/i18n/useT";
import { ChipDeEtiqueta } from "@/components/tags/ChipDeEtiqueta";
import { PontoDaEtiqueta } from "@/components/tags/PontoDaEtiqueta";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { X, Plus } from "@/lib/ui/icons";
import { useUpdateContact } from "@/hooks/contacts/useUpdateContact";
import { useContactTagVocabulary } from "@/hooks/contacts/useContactTagVocabulary";
import { TAMANHO_MAXIMO_DA_TAG } from "@/lib/contacts/tag-normalizada";
import {
  etiquetaParaGravar,
  etiquetasConhecidas,
  opcaoDeCriar,
  sugestoesDeEtiqueta,
} from "@/lib/contacts/etiquetas";

interface Props {
  contactId: string;
  orgId: string;
  tags: string[];
}

/** Edita as tags do CONTATO (distinto de ConversationTagsEditor, que edita as
 * tags da conversa) — aberto pelo botão "Tag" do painel do Inbox. */
export function ContactTagsEditor({ contactId, orgId, tags }: Props) {
  const t = useT();
  const [draft, setDraft] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);
  const mutation = useUpdateContact(contactId);
  const { data: vocabulary } = useContactTagVocabulary(orgId);

  function apply(next: string[]) {
    mutation.mutate({ tags: next });
  }

  function add(raw: string) {
    const tag = etiquetaParaGravar({ conhecidas, selecionadas: tags, digitado: raw });
    if (!tag || tags.length >= 20) return;
    apply([...tags, tag]);
    setDraft("");
    inputRef.current?.focus();
  }

  function remove(tag: string) {
    apply(tags.filter((v) => v !== tag));
  }

  const conhecidas = etiquetasConhecidas(vocabulary);
  const suggestions = sugestoesDeEtiqueta({ conhecidas, selecionadas: tags, digitado: draft });
  const createOption = tags.length < 20
    ? opcaoDeCriar({ conhecidas, selecionadas: tags, digitado: draft })
    : null;

  return (
    <div className="mt-2 space-y-2 rounded-md border border-border p-2">
      <div className="flex flex-wrap gap-1">
        {tags.length > 0 ? (
          tags.map((tag) => (
            <ChipDeEtiqueta key={tag} tag={tag} className="h-5 gap-1 px-1.5 text-[10px]">
              <button
                type="button"
                onClick={() => remove(tag)}
                disabled={mutation.isPending}
                aria-label={`${t("Remover tag")} ${tag}`}
                className="-m-2 inline-flex size-11 items-center justify-center rounded-sm hover:text-destructive lg:m-0 lg:size-auto"
              >
                <X size={10} weight="bold" aria-hidden />
              </button>
            </ChipDeEtiqueta>
          ))
        ) : (
          <span className="text-xs text-muted-foreground">{t("Sem tags no contato.")}</span>
        )}
      </div>

      <div className="flex gap-1">
        <Input
          ref={inputRef}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              add(draft);
            }
          }}
          placeholder={t("Nova tag…")}
          maxLength={TAMANHO_MAXIMO_DA_TAG}
          disabled={mutation.isPending || tags.length >= 20}
          className="h-11 text-xs lg:h-7"
          aria-label={t("Adicionar tag ao contato")}
        />
        <Button
          size="sm"
          variant="outline"
          className="h-11 min-w-11 px-2 lg:h-7 lg:min-w-0"
          onClick={() => add(draft)}
          disabled={mutation.isPending || !draft.trim() || tags.length >= 20}
          aria-label={t("Adicionar tag")}
        >
          <Plus size={12} weight="regular" aria-hidden />
        </Button>
      </div>

      {(suggestions.length > 0 || createOption !== null) && (
        <div className="flex flex-wrap gap-1">
          {suggestions.map((tag) => (
            <button
              key={tag}
              type="button"
              onClick={() => add(tag)}
              disabled={mutation.isPending || tags.length >= 20}
              className="inline-flex min-h-11 items-center gap-1 rounded-full border border-dashed border-border px-3 py-2 text-xs text-muted-foreground hover:border-solid hover:text-foreground disabled:opacity-50 lg:min-h-0 lg:px-2 lg:py-0.5 lg:text-[10px]"
            >
              <PontoDaEtiqueta tag={tag} />
              + {tag}
            </button>
          ))}
          {createOption !== null && (
            <button
              type="button"
              onClick={() => add(draft)}
              disabled={mutation.isPending || tags.length >= 20}
              className="inline-flex min-h-11 items-center gap-1 rounded-full border border-dashed border-border px-3 py-2 text-xs text-muted-foreground hover:border-solid hover:text-foreground disabled:opacity-50 lg:min-h-0 lg:px-2 lg:py-0.5 lg:text-[10px]"
            >
              {t("Criar")} «{createOption}»
            </button>
          )}
        </div>
      )}
    </div>
  );
}
