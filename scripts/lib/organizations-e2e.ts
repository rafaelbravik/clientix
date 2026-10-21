/**
 * Criação de organizações descartáveis para fixtures E2E locais.
 *
 * A aplicação não pode inserir diretamente em `organizations`: a criação
 * comercial passa pelas RPCs que aplicam o limite licenciado atomicamente.
 * Estes fixtures deliberadamente bypassam o limite usando a conexão de banco
 * administrativa, mas só aceitam Supabase HTTP e PostgreSQL em loopback.
 */
import { Pool } from "pg";

import type { CredenciaisSupabase } from "./env-de-teste";
import { destinoEhLocal } from "./env-de-teste";

export interface OrganizacaoFixtureE2E {
  slug: string;
  displayName: string;
  legalName: string;
  timezone?: string;
  locale?: string;
  settings?: Record<string, unknown>;
  onboardedAt?: string | null;
}

/** Impede que uma fixture administrativa toque qualquer instância remota. */
export function exigirSupabaseLocalParaFixture(
  credenciais: Pick<CredenciaisSupabase, "url" | "dbUrl">,
  script: string,
): void {
  if (
    credenciais.dbUrl.trim() === "" ||
    !destinoEhLocal(credenciais.url) ||
    !destinoEhLocal(credenciais.dbUrl)
  ) {
    throw new Error(
      `[${script}] fixture administrativa exige Supabase HTTP e PostgreSQL locais; operação recusada`,
    );
  }
}

/**
 * Cria ou recupera uma organização fixture. O slug é parâmetro SQL, nunca SQL.
 * O lock da restrição única resolve seeds concorrentes com o mesmo slug.
 */
export async function criarOrganizacaoFixtureE2E(
  credenciais: CredenciaisSupabase,
  organizacao: OrganizacaoFixtureE2E,
  script: string,
): Promise<string> {
  exigirSupabaseLocalParaFixture(credenciais, script);

  if (!/^[a-z0-9][a-z0-9-]{1,62}$/.test(organizacao.slug)) {
    throw new Error(`[${script}] slug de organização fixture inválido`);
  }

  const pool = new Pool({
    connectionString: credenciais.dbUrl,
    max: 1,
    connectionTimeoutMillis: 5_000,
    idleTimeoutMillis: 1_000,
  });

  try {
    const valoresBase = [
      organizacao.slug,
      organizacao.displayName,
      organizacao.legalName,
      organizacao.timezone ?? "America/Sao_Paulo",
      organizacao.locale ?? "pt-BR",
      organizacao.onboardedAt === undefined
        ? new Date().toISOString()
        : organizacao.onboardedAt,
    ];

    const resultado = organizacao.settings === undefined
      ? await pool.query<{ id: string }>(
          `insert into public.organizations
             (slug, display_name, legal_name, timezone, locale, onboarded_at)
           values ($1, $2, $3, $4, $5, $6)
           on conflict do nothing
           returning id`,
          valoresBase,
        )
      : await pool.query<{ id: string }>(
          `insert into public.organizations
             (slug, display_name, legal_name, timezone, locale, settings, onboarded_at)
           values ($1, $2, $3, $4, $5, $6::jsonb, $7)
           on conflict do nothing
           returning id`,
          [
            ...valoresBase.slice(0, 5),
            JSON.stringify(organizacao.settings),
            valoresBase[5],
          ],
        );

    if (resultado.rows[0]?.id) return resultado.rows[0].id;

    const existente = await pool.query<{ id: string }>(
      "select id from public.organizations where slug = $1",
      [organizacao.slug],
    );
    if (existente.rows.length !== 1 || !existente.rows[0]?.id) {
      throw new Error("conflito ao criar fixture sem organização correspondente");
    }
    return existente.rows[0].id;
  } catch (erro) {
    const codigo =
      typeof erro === "object" && erro !== null && "code" in erro
        ? String((erro as { code: unknown }).code)
        : "erro";
    throw new Error(`[${script}] criação de organização fixture falhou (${codigo})`);
  } finally {
    await pool.end();
  }
}
