import { Client } from "pg";

/**
 * Insere uma organização como fixture E2E usando a conexão local do Postgres.
 *
 * A chave service_role não pode inserir diretamente em `organizations`: essa
 * permissão é revogada de propósito, e a criação comercial passa pelas RPCs
 * limitadas. Este helper existe apenas para preparar organizações de controle
 * para jornadas que não testam criação de tenant. Ele recusa qualquer banco
 * que não esteja no próprio computador.
 */
export async function insertOrganizationFixture(
  values: Record<string, unknown>,
): Promise<string> {
  const connectionString = process.env.SUPABASE_DB_URL;
  if (!connectionString) {
    throw new Error("SUPABASE_DB_URL ausente; não é possível preparar fixture E2E local.");
  }

  let host: string;
  try {
    host = new URL(connectionString).hostname.replace(/^\[|\]$/g, "");
  } catch {
    throw new Error("SUPABASE_DB_URL inválida; fixture de organização recusada.");
  }
  if (!["localhost", "127.0.0.1", "::1"].includes(host)) {
    throw new Error("Fixture de organização recusada: o banco E2E precisa ser local.");
  }

  const entries = Object.entries(values);
  if (entries.length === 0 || entries.some(([column]) => !/^[a-z][a-z0-9_]*$/.test(column))) {
    throw new Error("Fixture de organização recusada: colunas inválidas.");
  }

  const columns = entries.map(([column]) => `"${column}"`).join(", ");
  const parameters = entries.map((_, index) => `$${index + 1}`).join(", ");
  const client = new Client({ connectionString });
  await client.connect();
  try {
    const result = await client.query<{ id: string }>(
      `insert into public.organizations (${columns}) values (${parameters}) returning id`,
      entries.map(([, value]) => value),
    );
    const id = result.rows[0]?.id;
    if (!id) throw new Error("O Postgres não retornou o id da organização de fixture.");
    return id;
  } finally {
    await client.end();
  }
}
