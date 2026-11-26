"use server";

import { revalidatePath } from "next/cache";

import { audit } from "@/lib/audit";
import { requirePlatformOwnerEscrita } from "@/lib/auth/requirePlatformAdmin";
import { validarValorDaCredencialDoCanal } from "@/lib/channels/chaves-da-instalacao";
import { acharChave } from "@/lib/instalacao/catalogo";
import {
  estadoParaTela,
  gravarPelaTela,
  voltarAoAmbiente,
  type EstadoParaTela,
} from "@/lib/instalacao/config";

export type ResultadoCredencialDoCanal =
  { ok: true; estado: EstadoParaTela } | { ok: false; erro: string };

function chaveEditavelDoOwner(chave: string) {
  const definicao = acharChave(chave);
  return definicao?.controle === "edita" && definicao.telaDona === "owner" ? definicao : null;
}

export async function salvarCredencialDoCanal(
  chave: string,
  valor: string,
): Promise<ResultadoCredencialDoCanal> {
  const { user } = await requirePlatformOwnerEscrita();
  const definicao = chaveEditavelDoOwner(chave);
  if (!definicao) return { ok: false, erro: "Esta credencial não pode ser alterada aqui." };

  const limpo = valor.trim();
  if (!limpo) return { ok: false, erro: "Informe um valor antes de salvar." };
  const erroValidacao = validarValorDaCredencialDoCanal(chave, limpo);
  if (erroValidacao) return { ok: false, erro: erroValidacao };

  const escrita = await gravarPelaTela(chave, limpo, {
    ehSegredo: definicao.natureza === "segredo",
    ator: user.id,
  });
  if (!escrita.ok) {
    return {
      ok: false,
      erro:
        escrita.motivo === "sem_chave_de_cifra"
          ? "Esta instalação está sem a chave que protege credenciais. Peça ao operador do servidor para conferir AI_CRED_AES_KEY. Nada foi salvo."
          : "Não foi possível salvar a credencial agora. Tente novamente.",
    };
  }

  await audit({
    action: "platform.config_changed",
    actorUserId: user.id,
    actingAsPlatformAdmin: true,
    resourceType: "platform_config",
    resourceId: null,
    metadata: {
      chave,
      last4: definicao.natureza === "segredo" ? limpo.slice(-4) : undefined,
      natureza: definicao.natureza,
    },
  });

  revalidatePath("/owner");
  revalidatePath("/owner/integracoes");
  return {
    ok: true,
    estado: await estadoParaTela(chave, definicao.natureza === "segredo"),
  };
}

export async function limparCredencialDoCanal(chave: string): Promise<ResultadoCredencialDoCanal> {
  const { user } = await requirePlatformOwnerEscrita();
  const definicao = chaveEditavelDoOwner(chave);
  if (!definicao) return { ok: false, erro: "Esta credencial não pode ser alterada aqui." };

  const escrita = await voltarAoAmbiente(chave);
  if (!escrita.ok) {
    return { ok: false, erro: "Não foi possível voltar ao padrão agora. Tente novamente." };
  }

  await audit({
    action: "platform.config_reset",
    actorUserId: user.id,
    actingAsPlatformAdmin: true,
    resourceType: "platform_config",
    resourceId: null,
    metadata: { chave },
  });

  revalidatePath("/owner");
  revalidatePath("/owner/integracoes");
  return {
    ok: true,
    estado: await estadoParaTela(chave, definicao.natureza === "segredo"),
  };
}
