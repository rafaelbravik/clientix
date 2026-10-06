/**
 * Resolução da identidade de IP para proteção e rate limiting de webhooks.
 *
 * ─── Topologia de Proxies do Repositório (Caddy e Traefik) ───────────────────
 *
 * Nas instalações self-host suportadas pelo DeskcommCRM:
 * 1. Caddy (`Caddyfile`): opera na borda da VPS (portas 80/443). Ao fazer
 *    `reverse_proxy app:3000`, o Caddy anexa o endereço IP remoto da conexão TCP
 *    ao final da cadeia do cabeçalho `X-Forwarded-For`.
 * 2. Traefik (`docker-compose.traefik.yml`): igualmente anexa o IP remoto do cliente
 *    ao final do cabeçalho `X-Forwarded-For` e repassa `X-Real-IP`.
 *
 * ─── Risco de IP Spoofing (Confiar em parts[0]) ─────────────────────────────
 *
 * Confiar cegamente no primeiro elemento de `X-Forwarded-For` é uma vulnerabilidade
 * clássica: qualquer cliente pode enviar `X-Forwarded-For: 1.2.3.4`, e o proxy
 * repassa `1.2.3.4, <IP_REAL>`. Ler o primeiro elemento permitiria que um atacante
 * forjasse um IP arbitrário a cada requisição, contornando o rate limit.
 *
 * Portanto, o IP confiável inserido pelo proxy de borda da instalação é o ÚLTIMO
 * elemento válido de `X-Forwarded-For`, ou o `X-Real-IP` injetado pelo proxy.
 *
 * ─── Prevenção de Bloqueio Coletivo (Evitar "unknown_ip") ────────────────────
 *
 * Se nenhum IP confiável puder ser determinado (ex: requisição direta sem proxy
 * ou cabeçalhos ausentes), a função retorna `null`.
 *
 * NUNCA agrupar conexões anônimas em um balde compartilhado único "unknown_ip":
 * isso permitiria que um único cliente abusivo bloqueasse todas as outras conexões
 * anônimas legítimas (ataque de negação de serviço coletivo / noisy neighbor).
 * Na ausência de IP determinável, o rate limit por IP é ignorado e a defesa
 * recai integralmente sobre o rate limit estrito por token de canal.
 */

import { isIP } from "node:net";

export function isValidIp(ip: string): boolean {
  return isIP(ip) !== 0;
}

export function resolveClientIp(headers: Headers): string | null {
  // 1. Inspeciona X-Forwarded-For pegando o ÚLTIMO elemento da cadeia.
  // Tanto Caddy (`reverse_proxy`) quanto Traefik anexam o endereço remoto real
  // da conexão TCP de borda ao final de X-Forwarded-For.
  // O cliente pode enviar qualquer valor inicial (spoofing), mas não pode controlar o último item anexado pelo proxy.
  const xForwardedFor = headers.get("x-forwarded-for");
  if (xForwardedFor) {
    const parts = xForwardedFor
      .split(",")
      .map((p) => p.trim())
      .filter(Boolean);

    if (parts.length > 0) {
      const edgeIp = parts[parts.length - 1];
      if (edgeIp && isValidIp(edgeIp)) {
        return edgeIp;
      }
    }
  }

  // 2. Se X-Forwarded-For não estiver presente, inspeciona X-Real-IP
  // que o Caddy agora sobrescreve explicitamente com {remote_host}.
  const xRealIp = headers.get("x-real-ip")?.trim();
  if (xRealIp && isValidIp(xRealIp)) {
    return xRealIp;
  }

  // Se nenhum IP confiável for extraído, retorna null.
  // NUNCA agrupar em balde compartilhado (ex: "unknown_ip").
  return null;
}
