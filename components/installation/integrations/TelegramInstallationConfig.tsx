"use client";

import { useState, useTransition } from "react";

import {
  limparCredencialDoCanal,
  salvarCredencialDoCanal,
} from "@/app/actions/owner/configurarCredenciaisDoCanal";
import { useT } from "@/hooks/i18n/useT";
import type { ChaveDaInstalacao } from "@/lib/instalacao/catalogo";
import type { EstadoParaTela } from "@/lib/instalacao/config";

export interface TelegramConfigLine {
  definicao: ChaveDaInstalacao;
  estado: EstadoParaTela;
}

export function TelegramInstallationConfig({
  configs,
  compacto = false,
}: {
  configs: TelegramConfigLine[];
  compacto?: boolean;
}) {
  const t = useT();
  const [linhas, setLinhas] = useState(configs);
  const [valores, setValores] = useState<Record<string, string>>({});
  const [feedback, setFeedback] = useState<string | null>(null);
  const [salvando, comecar] = useTransition();

  function atualizarEstado(chave: string, estado: EstadoParaTela) {
    setLinhas((atuais) =>
      atuais.map((linha) => (linha.definicao.chave === chave ? { ...linha, estado } : linha)),
    );
  }

  function salvar(linha: TelegramConfigLine) {
    const valor = valores[linha.definicao.chave] ?? "";
    comecar(async () => {
      const resultado = await salvarCredencialDoCanal(linha.definicao.chave, valor);
      if (!resultado.ok) {
        setFeedback(t(resultado.erro));
        return;
      }
      atualizarEstado(linha.definicao.chave, resultado.estado);
      setValores((atuais) => ({ ...atuais, [linha.definicao.chave]: "" }));
      setFeedback(t("Credencial salva e já disponível para as empresas desta instalação."));
    });
  }

  function voltarAoPadrao(linha: TelegramConfigLine) {
    comecar(async () => {
      const resultado = await limparCredencialDoCanal(linha.definicao.chave);
      if (!resultado.ok) {
        setFeedback(t(resultado.erro));
        return;
      }
      atualizarEstado(linha.definicao.chave, resultado.estado);
      setFeedback(t("Credencial voltou ao valor do arquivo de instalação."));
    });
  }

  function nomeDaOrigem(fonte: EstadoParaTela["fonte"]): string {
    if (fonte === "banco") return t("Definido pelo Dono");
    if (fonte === "ambiente") return t("Vem do arquivo de instalação do servidor");
    return t("Não configurado");
  }

  return (
    <section
      aria-labelledby="owner-telegram-config-title"
      className={compacto ? "space-y-4" : "space-y-4 rounded-lg border p-5"}
    >
      <div>
        <h2 id="owner-telegram-config-title" className="text-xl font-semibold">
          {t("Credenciais do aplicativo Telegram")}
        </h2>
        <p className="mt-1 text-sm text-muted-foreground">
          {t(
            "Configure uma vez as credenciais de my.telegram.org. Todas as empresas desta instalação usarão o mesmo aplicativo; cada tenant conecta o próprio telefone.",
          )}
        </p>
        <p className="mt-2 rounded-md border border-amber-500/40 bg-amber-500/5 p-3 text-sm text-muted-foreground">
          {t(
            "Ao trocar o API ID ou o API Hash, algumas contas já conectadas podem precisar ser conectadas novamente.",
          )}
        </p>
      </div>

      {linhas.map((linha) => {
        const { definicao, estado } = linha;
        const id = `owner-config-${definicao.chave}`;
        return (
          <div
            key={definicao.chave}
            className="space-y-2 border-t pt-4 first:border-t-0 first:pt-0"
          >
            <div className="flex flex-wrap items-baseline justify-between gap-2">
              <label htmlFor={id} className="block text-sm font-medium">
                {t(definicao.rotulo)}
              </label>
              <span className="text-xs text-muted-foreground">{nomeDaOrigem(estado.fonte)}</span>
            </div>
            <p className="text-sm text-muted-foreground">{t(definicao.explicacao)}</p>
            {estado.configurado && (
              <p className="text-xs text-muted-foreground">
                {definicao.natureza === "segredo"
                  ? `${t("Guardado, terminando em")} ••••${estado.last4 ?? ""}`
                  : `${t("Agora:")} ${estado.valorVisivel ?? ""}`}
              </p>
            )}
            <div className="flex flex-wrap gap-2">
              <input
                id={id}
                aria-describedby={`${id}-help`}
                inputMode={definicao.natureza === "numero" ? "numeric" : undefined}
                type={definicao.natureza === "segredo" ? "password" : "text"}
                autoComplete="off"
                value={valores[definicao.chave] ?? ""}
                onChange={(event) =>
                  setValores((atuais) => ({
                    ...atuais,
                    [definicao.chave]: event.target.value,
                  }))
                }
                placeholder={
                  estado.configurado ? t("Escreva para substituir") : t("Escreva para configurar")
                }
                className="min-w-0 flex-1 rounded-md border bg-background px-3 py-2 text-sm"
                disabled={salvando}
              />
              <button
                type="button"
                onClick={() => salvar(linha)}
                disabled={salvando || !(valores[definicao.chave] ?? "").trim()}
                className="rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground disabled:opacity-50"
              >
                {t("Salvar")}
              </button>
              {estado.fonte === "banco" && (
                <button
                  type="button"
                  onClick={() => voltarAoPadrao(linha)}
                  disabled={salvando}
                  className="rounded-md border px-4 py-2 text-sm font-medium disabled:opacity-50"
                >
                  {t("Voltar ao padrão")}
                </button>
              )}
            </div>
            <span id={`${id}-help`} className="sr-only">
              {t("O API Hash é guardado cifrado. Não compartilhe esse dado com os tenants.")}
            </span>
          </div>
        );
      })}

      {feedback && (
        <p role="status" className="text-sm text-muted-foreground">
          {feedback}
        </p>
      )}
    </section>
  );
}
