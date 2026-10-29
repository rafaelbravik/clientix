/**
 * PII masking helpers for LGPD preview endpoints.
 *
 * NEVER expose CPF — omit entirely.
 * Email: a***@dominio.com
 * Phone: (**) ****-${last4}
 */

export function maskEmail(email: string | null | undefined): string | null {
  if (!email) return null;
  const atIdx = email.indexOf("@");
  if (atIdx <= 0) return "***";
  const local = email.slice(0, atIdx);
  const domain = email.slice(atIdx); // includes @
  const prefix = local[0] ?? "*";
  return `${prefix}***${domain}`;
}

export function maskPhone(phone: string | null | undefined): string | null {
  if (!phone) return null;
  // Strip non-digits to extract last 4
  const digits = phone.replace(/\D/g, "");
  if (digits.length < 4) return "(**) ****-****";
  const last4 = digits.slice(-4);
  return `(**) ****-${last4}`;
}

/**
 * Mascara documentos pessoais para evidência operacional. O controlador pode
 * optar por imprimir seu CNPJ empresarial por extenso; documentos do titular
 * nunca devem usar essa exceção.
 */
export function maskDocument(document: string | null | undefined): string | null {
  if (!document) return null;
  const digits = document.replace(/\D/g, "");
  if (digits.length === 11) return `***.***.***-${digits.slice(-2)}`;
  if (digits.length === 14) return `**.***.***/****-${digits.slice(-2)}`;
  return digits.length >= 4 ? `****${digits.slice(-2)}` : "***";
}

/** Nome e razão social do titular não são necessários no recibo operacional. */
export interface DadosMinimosDoTitular {
  documento_mascarado: string | null;
  telefone_mascarado: string | null;
  email_mascarado: string | null;
  identificacao_nao_reimpressa: string;
}

export function mascararTitularDoPedido(
  payload: Record<string, unknown> | null | undefined,
): DadosMinimosDoTitular {
  const customer = payload?.["customer"];
  const customerRecord =
    customer && typeof customer === "object" && !Array.isArray(customer)
      ? (customer as Record<string, unknown>)
      : null;
  const document =
    typeof customerRecord?.["cpf"] === "string"
      ? customerRecord["cpf"]
      : typeof customerRecord?.["document"] === "string"
        ? customerRecord["document"]
        : null;
  const phone = typeof customerRecord?.["phone"] === "string" ? customerRecord["phone"] : null;
  const email = typeof customerRecord?.["email"] === "string" ? customerRecord["email"] : null;

  return {
    documento_mascarado: maskDocument(document),
    telefone_mascarado: maskPhone(phone),
    email_mascarado: maskEmail(email),
    identificacao_nao_reimpressa: "Dados de identificação não são reimpressos neste recibo.",
  };
}
