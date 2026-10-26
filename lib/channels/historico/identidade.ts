import { chatIdFromWaMessageId } from "@/lib/waha/message-id";
import type { WahaPayload } from "@/lib/waha/envelope";

export type IdentityVerdict = "IDENTITY_VALID" | "IDENTITY_AMBIGUOUS" | "IDENTITY_MISMATCH";
export type IdentityKind = "phone" | "lid" | "chat";

export interface HistoryIdentity {
  kind: IdentityKind;
  value: string;
  token: string;
}

export interface ConversationIdentityCheck {
  verdict: IdentityVerdict;
  identities: HistoryIdentity[];
  phone: string | null;
  lid: string | null;
}

function normalizarEndereco(raw: string): HistoryIdentity | null {
  const value = raw.trim().toLowerCase();
  const at = value.lastIndexOf("@");
  if (at <= 0) return null;
  const local = value.slice(0, at).replace(/^\+/, "");
  const suffix = value.slice(at + 1);
  if (suffix === "g.us" || suffix === "broadcast" || suffix === "newsletter") return null;
  if (suffix === "lid") {
    if (!/^[a-z0-9.-]{1,100}$/.test(local)) return null;
    return { kind: "lid", value: local, token: `lid:${local}` };
  }
  if (suffix === "c.us" || suffix === "s.whatsapp.net") {
    // JIDs reais usam somente dígitos (com `+` opcional). Remover letras ou
    // pontuação inesperada poderia transformar uma identidade malformada no
    // número válido de outra pessoa.
    if (!/^\+?\d{8,15}$/.test(local)) return null;
    const digits = local.replace(/^\+/, "");
    if (digits.length < 8 || digits.length > 15) return null;
    return { kind: "phone", value: digits, token: `phone:${digits}` };
  }
  return null;
}

function phoneFromAlternate(raw: unknown): HistoryIdentity | null {
  if (typeof raw !== "string") return null;
  return normalizarEndereco(raw.includes("@") ? raw : `${raw}@c.us`);
}

function idsDaMensagem(payload: WahaPayload): string[] {
  const key = payload._data?.key;
  const remoteJid = key && typeof key.remoteJid === "string" ? key.remoteJid : null;
  const remoteAddress = payload.fromMe === true ? payload.to : payload.from;
  return [
    chatIdFromWaMessageId(payload.id ?? ""),
    remoteAddress,
    remoteJid,
  ].filter((value): value is string => typeof value === "string" && value.length > 0);
}

function tokensDaIdentidade(identity: HistoryIdentity): HistoryIdentity[] {
  if (identity.kind === "lid") {
    return [identity, { kind: "chat", value: `${identity.value}@lid`, token: `chat:${identity.value}@lid` }];
  }
  return [
    identity,
    { kind: "chat", value: `${identity.value}@c.us`, token: `chat:${identity.value}@c.us` },
    { kind: "chat", value: `${identity.value}@s.whatsapp.net`, token: `chat:${identity.value}@s.whatsapp.net` },
  ];
}

/**
 * Confere a página inteira contra o chat que o WAHA listou. Toda mensagem
 * precisa carregar ao menos uma identidade remota verificável; conflito em
 * qualquer campo invalida a conversa inteira antes de persistir.
 */
export function validarIdentidadeDaConversa(input: {
  chatId: string;
  messages: WahaPayload[];
  resolvedPhone?: string | null;
  localPhone?: string | null;
}): ConversationIdentityCheck {
  const requested = normalizarEndereco(input.chatId);
  if (!requested || input.chatId.endsWith("@g.us")) {
    return { verdict: "IDENTITY_AMBIGUOUS", identities: [], phone: null, lid: null };
  }
  const targetPhone = input.resolvedPhone
    ? phoneFromAlternate(input.resolvedPhone)
    : requested.kind === "phone" ? requested : null;
  const local = input.localPhone ? phoneFromAlternate(input.localPhone) : null;
  const unique = new Map<string, HistoryIdentity>();
  for (const identity of tokensDaIdentidade(requested)) unique.set(identity.token, identity);
  if (targetPhone) for (const identity of tokensDaIdentidade(targetPhone)) unique.set(identity.token, identity);

  let verdict: IdentityVerdict = "IDENTITY_VALID";
  for (const message of input.messages) {
    if (typeof message.id !== "string" || !message.id.trim() || typeof message.fromMe !== "boolean") {
      verdict = "IDENTITY_AMBIGUOUS";
      break;
    }
    const candidates = new Map<string, HistoryIdentity>();
    for (const raw of idsDaMensagem(message)) {
      const identity = normalizarEndereco(raw);
      if (identity) candidates.set(identity.token, identity);
    }
    const alt = phoneFromAlternate(message._data?.key?.remoteJidAlt);
    if (alt) candidates.set(alt.token, alt);

    const remotos = [...candidates.values()].filter((candidate) => !(
      local?.kind === "phone" && candidate.kind === "phone" && local.value === candidate.value
    ));
    if (remotos.length === 0) {
      verdict = "IDENTITY_AMBIGUOUS";
      break;
    }

    const matches = remotos.some((candidate) => {
      if (candidate.kind === "phone" && targetPhone?.kind === "phone") return candidate.value === targetPhone.value;
      if (candidate.kind === "lid" && requested.kind === "lid") return candidate.value === requested.value;
      return candidate.kind === requested.kind && candidate.value === requested.value;
    });
    const hasDifferentStrongIdentity = remotos.some((candidate) => {
      if (candidate.kind === "phone" && targetPhone?.kind === "phone") return candidate.value !== targetPhone.value;
      if (candidate.kind === "lid" && requested.kind === "lid") return candidate.value !== requested.value;
      return candidate.kind === requested.kind && candidate.value !== requested.value;
    });
    if (hasDifferentStrongIdentity) {
      verdict = "IDENTITY_MISMATCH";
      break;
    }
    if (!matches) {
      // LID e telefone são equivalentes somente quando o WAHA fornece o telefone
      // alternativo/resolvido. Sem essa ponte não adivinhamos identidade.
      verdict = remotos.some((candidate) => candidate.kind !== requested.kind)
        ? "IDENTITY_AMBIGUOUS"
        : "IDENTITY_MISMATCH";
      break;
    }
    for (const candidate of remotos) {
      for (const expanded of tokensDaIdentidade(candidate)) unique.set(expanded.token, expanded);
    }
  }

  const identities = [...unique.values()];
  const phone = identities.find((identity) => identity.kind === "phone")?.value ?? null;
  const lid = identities.find((identity) => identity.kind === "lid")?.value ?? null;
  return { verdict, identities, phone: phone ? `+${phone}` : null, lid };
}
