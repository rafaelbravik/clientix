"use client";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { useT } from "@/hooks/i18n/useT";
import type { EstrategiaDoCandidato } from "@/lib/prospecting/estrategia-site";
import type { PreviaSalva } from "@/lib/prospecting/previa";

const CENARIO_I18N: Record<string, string> = {
  "Verificação pendente": "Verificação pendente",
  "Sem site informado": "Sem site informado",
  "Link de rede ou diretório": "Link de rede ou diretório",
  "Site medido sem os sinais avaliados": "Site medido sem os sinais avaliados",
  "Ponto técnico medido": "Ponto técnico medido",
  "Certificado de segurança inválido": "Certificado de segurança inválido",
  "Endereço não respondeu à medição": "Endereço não respondeu à medição",
};

const ANGULO_I18N: Record<string, string> = {
  "A verificação não confirmou um ponto que possa ser citado. Não afirme um defeito do site.": "A verificação não confirmou um ponto que possa ser citado. Não afirme um defeito do site.",
  "O cadastro não trouxe um site próprio. Apresente a possibilidade de ter uma página própria como opção, sem prometer mais clientes ou resultados.": "O cadastro não trouxe um site próprio. Apresente a possibilidade de ter uma página própria como opção, sem prometer mais clientes ou resultados.",
  "O link cadastrado leva a uma rede ou diretório, não a um site próprio. Trate um site próprio como possibilidade complementar, sem desvalorizar os canais atuais.": "O link cadastrado leva a uma rede ou diretório, não a um site próprio. Trate um site próprio como possibilidade complementar, sem desvalorizar os canais atuais.",
  "A medição não encontrou os sinais técnicos avaliados. Não apresente uma abordagem de conserto; se houver conversa, trate-a como exploração de objetivos futuros.": "A medição não encontrou os sinais técnicos avaliados. Não apresente uma abordagem de conserto; se houver conversa, trate-a como exploração de objetivos futuros.",
  "A medição não encontrou a configuração de viewport para celular. Apresente como observação pontual e confirme se a empresa reconhece essa necessidade, sem prometer resultados.": "A medição não encontrou a configuração de viewport para celular. Apresente como observação pontual e confirme se a empresa reconhece essa necessidade, sem prometer resultados.",
  "A página apresentou pouco conteúdo visível na medição. Apresente como observação pontual e confirme se a empresa reconhece essa necessidade, sem prometer resultados.": "A página apresentou pouco conteúdo visível na medição. Apresente como observação pontual e confirme se a empresa reconhece essa necessidade, sem prometer resultados.",
  "A resposta da página levou mais de cinco segundos na medição. Apresente como observação pontual e confirme se a empresa reconhece essa necessidade, sem prometer resultados.": "A resposta da página levou mais de cinco segundos na medição. Apresente como observação pontual e confirme se a empresa reconhece essa necessidade, sem prometer resultados.",
  "A página carregou ao menos um recurso por uma conexão sem criptografia. Apresente como observação pontual e confirme se a empresa reconhece essa necessidade, sem prometer resultados.": "A página carregou ao menos um recurso por uma conexão sem criptografia. Apresente como observação pontual e confirme se a empresa reconhece essa necessidade, sem prometer resultados.",
  "O endereço abriu sem redirecionar para a versão com conexão segura. Apresente como observação pontual e confirme se a empresa reconhece essa necessidade, sem prometer resultados.": "O endereço abriu sem redirecionar para a versão com conexão segura. Apresente como observação pontual e confirme se a empresa reconhece essa necessidade, sem prometer resultados.",
  "A medição não encontrou uma versão com conexão segura. Apresente como observação pontual e confirme se a empresa reconhece essa necessidade, sem prometer resultados.": "A medição não encontrou uma versão com conexão segura. Apresente como observação pontual e confirme se a empresa reconhece essa necessidade, sem prometer resultados.",
  "A medição identificou um construtor de páginas; isso, por si só, não prova um defeito. Apresente como observação pontual e confirme se a empresa reconhece essa necessidade, sem prometer resultados.": "A medição identificou um construtor de páginas; isso, por si só, não prova um defeito. Apresente como observação pontual e confirme se a empresa reconhece essa necessidade, sem prometer resultados.",
  "A auditoria registrou um ponto técnico que pode ser revisto com a empresa. Apresente como observação pontual e confirme se a empresa reconhece essa necessidade, sem prometer resultados.": "A auditoria registrou um ponto técnico que pode ser revisto com a empresa. Apresente como observação pontual e confirme se a empresa reconhece essa necessidade, sem prometer resultados.",
  "A validação do certificado de segurança falhou na medição. Comunique isso como observação de cortesia, sem exagerar consequências.": "A validação do certificado de segurança falhou na medição. Comunique isso como observação de cortesia, sem exagerar consequências.",
  "A medição conclusiva não conseguiu acessar o endereço. Trate como aviso de cortesia e confirme com a empresa antes de propor uma correção.": "A medição conclusiva não conseguiu acessar o endereço. Trate como aviso de cortesia e confirme com a empresa antes de propor uma correção.",
};

const GANCHO_I18N: Record<string, string> = {
  "Perguntar se a empresa já considera ter uma página própria.": "Perguntar se a empresa já considera ter uma página própria.",
  "Perguntar se a empresa já avaliou uma página própria além dos canais atuais.": "Perguntar se a empresa já avaliou uma página própria além dos canais atuais.",
  "Perguntar quais objetivos digitais a empresa gostaria de priorizar.": "Perguntar quais objetivos digitais a empresa gostaria de priorizar.",
  "A medição não encontrou a configuração de viewport para celular.": "A medição não encontrou a configuração de viewport para celular.",
  "A página apresentou pouco conteúdo visível na medição.": "A página apresentou pouco conteúdo visível na medição.",
  "A resposta da página levou mais de cinco segundos na medição.": "A resposta da página levou mais de cinco segundos na medição.",
  "A página carregou ao menos um recurso por uma conexão sem criptografia.": "A página carregou ao menos um recurso por uma conexão sem criptografia.",
  "O endereço abriu sem redirecionar para a versão com conexão segura.": "O endereço abriu sem redirecionar para a versão com conexão segura.",
  "A medição não encontrou uma versão com conexão segura.": "A medição não encontrou uma versão com conexão segura.",
  "A medição identificou um construtor de páginas; isso, por si só, não prova um defeito.": "A medição identificou um construtor de páginas; isso, por si só, não prova um defeito.",
  "A auditoria registrou um ponto técnico que pode ser revisto com a empresa.": "A auditoria registrou um ponto técnico que pode ser revisto com a empresa.",
  "Avisar que o navegador pode sinalizar um problema no certificado e confirmar se a empresa já está tratando disso.": "Avisar que o navegador pode sinalizar um problema no certificado e confirmar se a empresa já está tratando disso.",
  "Perguntar se a equipe já sabe que o endereço não respondeu na verificação.": "Perguntar se a equipe já sabe que o endereço não respondeu na verificação.",
};

const OBJECAO_I18N: Record<string, string> = {
  "Já tenho uma solução para isso.": "Já tenho uma solução para isso.",
};

const RESPOSTA_I18N: Record<string, string> = {
  "Entendi. A conversa pode ser apenas para comparar opções, sem compromisso.": "Entendi. A conversa pode ser apenas para comparar opções, sem compromisso.",
};

const PROXIMO_PASSO_I18N: Record<string, string> = {
  "Aguardar uma medição conclusiva antes de usar o site como argumento.": "Aguardar uma medição conclusiva antes de usar o site como argumento.",
  "Confirmar com a empresa se a ausência do site no cadastro corresponde à situação atual.": "Confirmar com a empresa se a ausência do site no cadastro corresponde à situação atual.",
  "Confirmar se existe outro site próprio antes de sugerir qualquer mudança.": "Confirmar se existe outro site próprio antes de sugerir qualquer mudança.",
  "Prioridade baixa para uma abordagem sobre reparo de site.": "Prioridade baixa para uma abordagem sobre reparo de site.",
  "Convidar para revisar somente o ponto técnico que a medição confirmou.": "Convidar para revisar somente o ponto técnico que a medição confirmou.",
  "Oferecer uma revisão do certificado após confirmar que o registro ainda está atual.": "Oferecer uma revisão do certificado após confirmar que o registro ainda está atual.",
  "Confirmar a situação antes de recomendar qualquer serviço.": "Confirmar a situação antes de recomendar qualquer serviço.",
};

export function StrategyPreview({
  strategy,
  preview,
  previewState,
  busy,
  error,
  onGenerate,
}: {
  strategy: EstrategiaDoCandidato;
  preview: PreviaSalva | null;
  previewState: "none" | "ready" | "stale";
  busy: boolean;
  error: string | null;
  onGenerate: () => void;
}) {
  const t = useT();
  return (
    <section className="mt-3 space-y-3 rounded-md border bg-card p-3" aria-label={t("Estratégia e prévia")}
    >
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-xs font-medium">{t("Estratégia")}</span>
        <Badge variant={strategy.verificacaoPendente ? "secondary" : "outline"}>
          {t(CENARIO_I18N[strategy.cenario] as string)}
        </Badge>
        {strategy.dataVerificacao && (
          <span className="text-xs text-muted-foreground">
            {t("Verificado em")} {strategy.dataVerificacao}
          </span>
        )}
      </div>
      <p className="text-xs text-muted-foreground">{t(ANGULO_I18N[strategy.angulo] as string)}</p>
      {strategy.ganchos.length > 0 && (
        <div>
          <p className="text-xs font-medium">{t("Possíveis ganchos")}</p>
          <ul className="mt-1 list-disc space-y-1 pl-5 text-xs text-muted-foreground">
            {strategy.ganchos.slice(0, 3).map((hook) => <li key={hook}>{t(GANCHO_I18N[hook] as string)}</li>)}
          </ul>
        </div>
      )}
      {strategy.objecoes.length > 0 && (
        <details className="text-xs">
          <summary className="cursor-pointer font-medium">{t("Objeções possíveis")}</summary>
          <ul className="mt-2 space-y-2 text-muted-foreground">
            {strategy.objecoes.slice(0, 3).map((item) => (
              <li key={item.objecao}>
                <span className="font-medium">{t(OBJECAO_I18N[item.objecao] as string)}</span>
                <span className="block">{t(RESPOSTA_I18N[item.resposta] as string)}</span>
              </li>
            ))}
          </ul>
        </details>
      )}
      <p className="text-xs text-muted-foreground">
        <span className="font-medium">{t("Próximo passo:")}</span> {t(PROXIMO_PASSO_I18N[strategy.proximoPasso] as string)}
      </p>

      <div className="border-t pt-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex items-center gap-2">
            <span className="text-xs font-medium">{t("Prévia de abordagem")}</span>
            {previewState === "ready" && <Badge variant="outline">{t("Atual")}</Badge>}
            {previewState === "stale" && <Badge variant="secondary">{t("Desatualizada")}</Badge>}
          </div>
          <Button type="button" size="sm" variant="outline" disabled={busy} onClick={onGenerate}>
            {busy ? t("Gerando…") : previewState === "stale" ? t("Gerar nova prévia") : t("Gerar prévia")}
          </Button>
        </div>
        {previewState === "ready" && preview && (
          <p className="mt-2 whitespace-pre-wrap break-words rounded-md bg-muted/40 p-3 text-sm">
            {preview.texto}
          </p>
        )}
        {previewState === "stale" && (
          <p className="mt-2 text-xs text-muted-foreground">
            {t("A auditoria ou a versão do agente mudou. Gere uma nova prévia antes de usar o texto anterior.")}
          </p>
        )}
        {error && <p role="alert" className="mt-2 text-xs text-destructive">{t("Não foi possível gerar a prévia. A auditoria continua disponível.")}</p>}
        <p className="mt-2 text-xs text-muted-foreground">
          {t("A prévia é um rascunho para revisão. Nenhuma mensagem é enviada.")}
        </p>
      </div>
    </section>
  );
}
