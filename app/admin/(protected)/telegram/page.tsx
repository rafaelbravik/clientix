import { notFound } from "next/navigation";

import { TelegramInstallationConfig } from "@/components/installation/integrations/TelegramInstallationConfig";
import { loadAuthUser } from "@/lib/auth/server";
import { requirePlatformOwner } from "@/lib/auth/requirePlatformAdmin";
import { traduzir } from "@/lib/i18n/dicionario";
import { CATALOGO_DA_INSTALACAO } from "@/lib/instalacao/catalogo";
import { estadoParaTela } from "@/lib/instalacao/config";

export const metadata = { title: "Telegram da instalação" };
export const dynamic = "force-dynamic";

/**
 * Credenciais do aplicativo Telegram desta instalação, no painel Vendor que o
 * proprietário do projeto já usa para Google Agenda e Meta. A configuração é
 * global para o Customer apontado pelo mesmo banco; cada tenant ainda conecta
 * seu próprio telefone. No build Customer isolado, o painel equivalente fica
 * em /owner/integracoes porque o artefato não leva app/admin/**.
 */
export default async function TelegramDaInstalacaoPage() {
  await requirePlatformOwner();
  const usuario = await loadAuthUser();
  if (!usuario?.is_platform_admin) notFound();
  const t = (texto: string) => traduzir(texto, usuario.idioma);

  const configs = await Promise.all(
    CATALOGO_DA_INSTALACAO.filter((item) => item.telaDona === "owner").map(async (definicao) => ({
      definicao,
      estado: await estadoParaTela(definicao.chave, definicao.natureza === "segredo"),
    })),
  );

  return (
    <div className="space-y-6">
      <div className="space-y-1">
        <h1 className="text-2xl font-semibold tracking-tight">{t("Telegram (conta de usuário)")}</h1>
        <p className="max-w-3xl text-sm text-muted-foreground">
          {t(
            "Configure o aplicativo MTProto uma vez para esta instalação. As empresas compartilham o API ID e o API Hash; cada tenant conecta o próprio telefone em Conexões.",
          )}
        </p>
      </div>
      <TelegramInstallationConfig configs={configs} compacto />
    </div>
  );
}
