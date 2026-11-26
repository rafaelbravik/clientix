import Link from "next/link";
import { notFound } from "next/navigation";
import { headers } from "next/headers";

import { loadAuthUser } from "@/lib/auth/server";
import { requirePlatformOwner } from "@/lib/auth/requirePlatformAdmin";
import { appDaMetaDoAmbiente } from "@/lib/channels/meta/app";
import {
  configuracaoDoAmbiente,
  enderecoDeRetorno,
  origemLocalDosCabecalhos,
} from "@/lib/agenda/google/config";
import { getSmtpConfig } from "@/lib/email/config";
import { transporteEmVigor } from "@/lib/email/roteador";
import { CATALOGO_DA_INSTALACAO } from "@/lib/instalacao/catalogo";
import { estadoParaTela } from "@/lib/instalacao/config";
import type { Idioma } from "@/lib/i18n/idiomas";
import { normalizarIdioma } from "@/lib/i18n/idiomas";
import { traduzir } from "@/lib/i18n/dicionario";
import { tagDeIdioma } from "@/lib/i18n/datas";
import { createAdminClient } from "@/lib/supabase/admin";
import { FormularioDaMeta } from "@/components/installation/integrations/FormularioDaMeta";
import { FormularioDoGoogle } from "@/components/installation/integrations/FormularioDoGoogle";
import { FormularioDeSmtp } from "@/components/installation/integrations/FormularioDeSmtp";
import { TelegramInstallationConfig } from "@/components/installation/integrations/TelegramInstallationConfig";

export const dynamic = "force-dynamic";
export const metadata = { title: "Integrações da instalação" };

export default async function IntegracoesDoOwnerPage() {
  await requirePlatformOwner();
  const usuario = await loadAuthUser();
  if (!usuario?.is_platform_admin) notFound();
  const idioma = normalizarIdioma(usuario.locale);

  const [meta, google, smtp, transporte, canal, emailExterno] = await Promise.all([
    carregarMeta(idioma),
    carregarGoogle(idioma),
    getSmtpConfig(),
    transporteEmVigor(),
    Promise.all(
      CATALOGO_DA_INSTALACAO.filter((item) => item.telaDona === "owner").map(async (definicao) => ({
        definicao,
        estado: await estadoParaTela(definicao.chave, definicao.natureza === "segredo"),
      })),
    ),
    Promise.all(
      CATALOGO_DA_INSTALACAO.filter((item) => item.telaDona === "email").map(async (definicao) => ({
        definicao,
        estado: await estadoParaTela(definicao.chave, definicao.natureza === "segredo"),
      })),
    ),
  ]);

  const cabecalhos = await headers();
  const origemLocal = origemLocalDosCabecalhos(cabecalhos);
  const t = (texto: string) => traduzir(texto, idioma);

  return (
    <main className="mx-auto min-h-screen w-full max-w-5xl space-y-8 px-4 py-10 sm:px-6">
      <header className="space-y-3">
        <Link href="/owner" className="text-sm text-muted-foreground underline underline-offset-4">
          {t("Voltar ao painel do proprietário")}
        </Link>
        <div>
          <p className="text-sm font-medium text-muted-foreground">{usuario.email}</p>
          <h1 className="mt-1 text-3xl font-semibold tracking-tight">
            {t("Integrações e credenciais")}
          </h1>
          <p className="mt-2 max-w-3xl text-sm text-muted-foreground">
            {t(
              "Estas são as credenciais dos aplicativos usados por esta instalação do Clientix. Todas as empresas daqui compartilham os mesmos aplicativos. Cada tenant mantém seus próprios números e contas conectados em Conexões; o serviço de e-mail de saída é configurado para a instalação.",
            )}
          </p>
        </div>
      </header>

      <section id="meta" className="scroll-mt-6 rounded-xl border p-4 sm:p-6">
        <FormularioDaMeta compacto {...meta} />
      </section>

      <section id="google-agenda" className="scroll-mt-6 rounded-xl border p-4 sm:p-6">
        <FormularioDoGoogle
          compacto
          clientIdSalvo={google.clientId}
          temSegredoSalvo={google.temSegredo}
          atualizadoEm={google.atualizadoEm}
          temNoAmbiente={google.temNoAmbiente}
          enderecoDeRetorno={enderecoDeRetorno(origemLocal ?? undefined)}
        />
      </section>

      <section id="telegram" className="scroll-mt-6 rounded-xl border p-4 sm:p-6">
        <TelegramInstallationConfig configs={canal} compacto />
      </section>

      <section id="email" className="scroll-mt-6 rounded-xl border p-4 sm:p-6">
        <FormularioDeSmtp
          compacto
          host={smtp.host}
          porta={smtp.port}
          seguranca={smtp.security}
          usuario={smtp.username}
          remetente={smtp.fromEmail}
          nomeDoRemetente={smtp.fromName}
          temSenhaSalva={Boolean(smtp.password)}
          origem={smtp.source}
          transporte={transporte}
          servicoExterno={emailExterno}
          idioma={idioma}
        />
      </section>
    </main>
  );
}

async function carregarMeta(idioma: Idioma) {
  const { data, error } = await createAdminClient()
    .from("platform_meta_app")
    .select("app_secret_encrypted, verify_token_encrypted, verify_token_created_at, updated_at")
    .eq("id", 1)
    .maybeSingle();
  const linha = data as {
    app_secret_encrypted: string | null;
    verify_token_encrypted: string | null;
    verify_token_created_at: string | null;
    updated_at: string | null;
  } | null;
  const ambiente = appDaMetaDoAmbiente();
  return {
    temSegredoSalvo: Boolean(linha?.app_secret_encrypted),
    temTokenSalvo: Boolean(linha?.verify_token_encrypted),
    tokenGeradoEm: formatar(linha?.verify_token_created_at ?? null, idioma),
    atualizadoEm: formatar(linha?.updated_at ?? null, idioma),
    temNoAmbiente: Boolean(ambiente.appSecret && ambiente.verifyToken),
    leituraFalhou: Boolean(error),
  };
}

async function carregarGoogle(idioma: Idioma) {
  const { data } = await createAdminClient()
    .from("platform_google_oauth")
    .select("client_id, client_secret_encrypted, updated_at")
    .eq("id", 1)
    .maybeSingle();
  const linha = data as {
    client_id: string | null;
    client_secret_encrypted: string | null;
    updated_at: string | null;
  } | null;
  const ambiente = configuracaoDoAmbiente();
  return {
    clientId: linha?.client_id ?? null,
    temSegredo: Boolean(linha?.client_secret_encrypted),
    atualizadoEm: formatar(linha?.updated_at ?? null, idioma),
    temNoAmbiente: ambiente !== null,
  };
}

function formatar(iso: string | null, idioma: Idioma): string | null {
  if (!iso) return null;
  return new Date(iso).toLocaleString(tagDeIdioma(idioma), {
    timeZone: "America/Sao_Paulo",
    dateStyle: "short",
    timeStyle: "short",
  });
}
