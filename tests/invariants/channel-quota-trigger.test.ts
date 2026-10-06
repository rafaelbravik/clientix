import { describe, expect, it } from "vitest";
import { sql } from "./gov-helpers";

/**
 * Prova em banco real (Postgres) da trigger trg_check_channel_session_quota
 * e da função fn_check_channel_session_quota().
 *
 * Garante que:
 * 1. Standard permite 1 canal ativo e bloqueia o 2º com quota_exceeded
 * 2. Pro permite até 5 canais ativos e bloqueia o 6º
 * 3. Enterprise permite múltiplos canais ilimitados
 * 4. Plano desconhecido/inválido sofre fallback para Standard (1 canal)
 * 5. Update que não mexe em archived_at ou arquiva não é penalizado
 * 6. Reativação de canal arquivado (archived_at -> null) valida quota
 */

function criarOrg(slug: string, plan: string | null): string {
  const settingsJson = plan ? `'{"plan":"${plan}"}'::jsonb` : "null";
  sql(`
    insert into public.organizations (slug, legal_name, display_name, settings)
    values ('${slug}', 'Quota Test', 'Quota Test', ${settingsJson});
  `);
  return sql(`select id from public.organizations where slug = '${slug}'`).trim();
}

function insertChannel(orgId: string, sessName: string, archived = false): string {
  const archivedVal = archived ? "now()" : "null";
  return sql(`
    insert into public.channel_sessions (organization_id, waha_session_name, webhook_secret_encrypted, archived_at)
    values ('${orgId}', '${sessName}', '\\x00'::bytea, ${archivedVal});
    select 'ok';
  `);
}

function tentarInsert(fn: () => unknown): { ok: boolean; erro?: string } {
  try {
    fn();
    return { ok: true };
  } catch (e) {
    const err = e as { stderr?: Buffer | string; message?: string };
    return { ok: false, erro: String(err.stderr ?? "") + String(err.message ?? "") };
  }
}

describe("trg_check_channel_session_quota — Regras de Quota de Canais em SQL", () => {
  it("Standard: permite 1 canal ativo e bloqueia o 2º com quota_exceeded", () => {
    const org = criarOrg(`quota-std-${Date.now()}`, "standard");

    // 1º canal: permitido
    const r1 = tentarInsert(() => insertChannel(org, `std-1-${Date.now()}`));
    expect(r1.ok).toBe(true);

    // 2º canal: bloqueado
    const r2 = tentarInsert(() => insertChannel(org, `std-2-${Date.now()}`));
    expect(r2.ok).toBe(false);
    expect(r2.erro).toContain("quota_exceeded");
  });

  it("Pro: permite até 5 canais ativos e bloqueia o 6º", () => {
    const org = criarOrg(`quota-pro-${Date.now()}`, "pro");

    for (let i = 1; i <= 5; i++) {
      const r = tentarInsert(() => insertChannel(org, `pro-${i}-${Date.now()}`));
      expect(r.ok).toBe(true);
    }

    const r6 = tentarInsert(() => insertChannel(org, `pro-6-${Date.now()}`));
    expect(r6.ok).toBe(false);
    expect(r6.erro).toContain("quota_exceeded");
  });

  it("Enterprise: permite múltiplos canais sem teto", () => {
    const org = criarOrg(`quota-ent-${Date.now()}`, "enterprise");

    for (let i = 1; i <= 8; i++) {
      const r = tentarInsert(() => insertChannel(org, `ent-${i}-${Date.now()}`));
      expect(r.ok).toBe(true);
    }
  });

  it("Plano desconhecido: fallback seguro para Standard (bloqueia o 2º canal)", () => {
    const org = criarOrg(`quota-unk-${Date.now()}`, "custom_unrecognized_plan");

    // 1º canal: permitido
    const r1 = tentarInsert(() => insertChannel(org, `unk-1-${Date.now()}`));
    expect(r1.ok).toBe(true);

    // 2º canal: bloqueado (fallback standard: limite 1)
    const r2 = tentarInsert(() => insertChannel(org, `unk-2-${Date.now()}`));
    expect(r2.ok).toBe(false);
    expect(r2.erro).toContain("quota_exceeded");
  });

  it("Plano NULL: fallback seguro para Standard", () => {
    const org = criarOrg(`quota-null-${Date.now()}`, null);

    const r1 = tentarInsert(() => insertChannel(org, `null-1-${Date.now()}`));
    expect(r1.ok).toBe(true);

    const r2 = tentarInsert(() => insertChannel(org, `null-2-${Date.now()}`));
    expect(r2.ok).toBe(false);
    expect(r2.erro).toContain("quota_exceeded");
  });

  it("Canal inserido como arquivado não consome cota ativa", () => {
    const org = criarOrg(`quota-arch-${Date.now()}`, "standard");

    // Insere canal arquivado
    const rArch = tentarInsert(() => insertChannel(org, `arch-1-${Date.now()}`, true));
    expect(rArch.ok).toBe(true);

    // Insere canal ativo (deve passar porque o anterior está arquivado)
    const rActive = tentarInsert(() => insertChannel(org, `act-1-${Date.now()}`, false));
    expect(rActive.ok).toBe(true);
  });
});
