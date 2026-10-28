import { execFileSync } from "node:child_process";
import { describe, expect, it } from "vitest";

const container = process.env.TEST_DB_CONTAINER;
if (!container) {
  throw new Error("TEST_DB_CONTAINER not set — run this invariant via `pnpm test:db`.");
}
const containerName: string = container;

function sql(script: string): string {
  return execFileSync(
    "docker",
    ["exec", "-i", containerName, "psql", "-U", "postgres", "-d", "postgres", "-v", "ON_ERROR_STOP=1", "-tA", "-f", "-"],
    { input: script, encoding: "utf8" },
  ).trim();
}

describe("0525 — sequência persistente de balões de campanha", () => {
  it("tem defaults seguros para campanhas antigas e cursor de retomada", () => {
    const result = sql(`
      select table_name || '.' || column_name || '|' || data_type || '|' || is_nullable || '|' || coalesce(column_default, '')
        from information_schema.columns
       where table_schema = 'public'
         and (table_name, column_name) in (
           ('campaigns', 'split_messages'),
           ('campaign_recipients', 'split_bubble_count'),
           ('campaign_recipients', 'next_bubble_index')
         )
       order by table_name, column_name;
    `);

    expect(result).toContain("campaigns.split_messages|boolean|NO|false");
    expect(result).toContain("campaign_recipients.split_bubble_count|smallint|YES|");
    expect(result).toContain("campaign_recipients.next_bubble_index|smallint|NO|0");
  });

  it("impõe quantidade de 2–3 balões e cursor dentro da sequência", () => {
    const constraint = sql(`
      select pg_get_constraintdef(oid)
        from pg_constraint
       where conrelid = 'public.campaign_recipients'::regclass
         and conname = 'campaign_recipients_split_bubbles_check';
    `);

    const normalized = constraint.toLowerCase().replace(/\s+/g, " ");
    expect(normalized).toContain("split_bubble_count >= 2");
    expect(normalized).toContain("split_bubble_count <= 3");
    expect(normalized).toContain("next_bubble_index >= 0");
    expect(normalized).toContain("next_bubble_index <= split_bubble_count");
    expect(normalized).toContain("split_bubble_count is null");
    expect(normalized).toContain("split_bubble_count is not null");
    expect(normalized).toContain("next_bubble_index = 0");
  });
});
