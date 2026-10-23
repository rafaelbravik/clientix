import { env } from "@/lib/env";

/**
 * Secure do cookie de sessão derivado da URL pública configurada, não de
 * cabeçalhos do cliente. O ingress de produção valida HTTPS no boot; HTTP só
 * pode existir em modo local com opt-in explícito e endereço de loopback.
 *
 * ATENÇÃO: precisa ler de `lib/env` (parse do objeto process.env em RUNTIME),
 * nunca por acesso literal `process.env` + `NEXT_PUBLIC_APP_URL` encadeados —
 * o compilador do Next INLINA esse acesso em build time, e a imagem genérica
 * builda com o
 * placeholder `https://placeholder.invalid` (Dockerfile), congelando
 * Secure=true para sempre, qualquer que seja o .env de runtime.
 */
export function cookieSecure(): boolean {
  return env.NEXT_PUBLIC_APP_URL.startsWith("https://");
}
