import { gerarTokenDeAcessoWidget } from "./token";

/**
 * Monta o link absoluto de acesso ao Web Widget para a conversa informada.
 */
export function gerarLinkDoWidget(
  baseUrl: string,
  conversationId: string,
  organizationId: string,
): string {
  const token = gerarTokenDeAcessoWidget(conversationId, organizationId);
  const cleanBase = baseUrl.replace(/\/+$/, "");
  return `${cleanBase}/chat/${token}`;
}

/**
 * Retorna o texto padrão de convite para transição do atendimento para a Web.
 */
export function gerarMensagemDeConviteWidget(
  link: string,
  protocolo?: string | null,
): string {
  if (protocolo) {
    return (
      `Olá! Para um atendimento mais rápido e interativo, você também pode continuar nossa conversa por este link seguro:\n\n` +
      `${link}\n\n` +
      `Seu número de protocolo é: ${protocolo}`
    );
  }

  return (
    `Olá! Para um atendimento mais rápido e interativo, você também pode continuar nossa conversa por este link seguro:\n\n` +
    `${link}`
  );
}
