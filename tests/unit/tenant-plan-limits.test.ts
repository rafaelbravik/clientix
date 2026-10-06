import { describe, it, expect, vi } from "vitest";
import {
  DEFAULT_PLAN_LIMITS,
  resolveTenantPlanLimits,
  checkUserQuota,
  checkChannelQuota,
  checkFeatureQuota,
} from "@/lib/tenant/plan-limits";
import type { SupabaseClient } from "@supabase/supabase-js";

describe("Tenant Plan Limits & Quota Guards", () => {
  describe("resolveTenantPlanLimits", () => {
    it("deve resolver limites padrão para plano standard", () => {
      const limits = resolveTenantPlanLimits({ plan: "standard" });
      expect(limits.plan).toBe("standard");
      expect(limits.max_users).toBe(3);
      expect(limits.max_channels).toBe(1);
      expect(limits.allowed_channels).toEqual(["whatsapp", "email"]);
      expect(limits.features.campaigns).toBe(false);
      expect(limits.features.ai_agent).toBe(true);
    });

    it("deve resolver limites padrão para plano pro", () => {
      const limits = resolveTenantPlanLimits({ plan: "pro" });
      expect(limits.plan).toBe("pro");
      expect(limits.max_users).toBe(10);
      expect(limits.max_channels).toBe(5);
      expect(limits.features.campaigns).toBe(true);
      expect(limits.allowed_channels).toContain("instagram");
    });

    it("deve resolver plano enterprise como irrestrito", () => {
      const limits = resolveTenantPlanLimits({ plan: "enterprise" });
      expect(limits.plan).toBe("enterprise");
      expect(limits.max_users).toBeNull();
      expect(limits.max_channels).toBeNull();
      expect(limits.allowed_channels).toBeNull();
      expect(limits.features.campaigns).toBe(true);
    });

    it("deve aceitar overrides em plan_limits", () => {
      const limits = resolveTenantPlanLimits({
        plan: "standard",
        plan_limits: {
          max_users: 7,
          features: { campaigns: true },
        },
      });
      expect(limits.plan).toBe("standard");
      expect(limits.max_users).toBe(7); // Overriden
      expect(limits.max_channels).toBe(1); // Default standard
      expect(limits.features.campaigns).toBe(true); // Overriden
    });

    it("deve assumir standard quando plano não for informado", () => {
      const limits = resolveTenantPlanLimits(null);
      expect(limits.plan).toBe("standard");
      expect(limits.max_users).toBe(DEFAULT_PLAN_LIMITS.standard.max_users);
    });
  });

  describe("checkUserQuota", () => {
    it("deve barrar quando o número de usuários exceder o teto do plano", async () => {
      const mockSupabase = {
        from: vi.fn((table: string) => {
          if (table === "organizations") {
            return {
              select: () => ({
                eq: () => ({
                  single: async () => ({
                    data: { settings: { plan: "standard" } },
                    error: null,
                  }),
                }),
              }),
            };
          }
          if (table === "user_organizations") {
            return {
              select: () => ({
                eq: () => ({
                  is: async () => ({ count: 3, error: null }),
                }),
              }),
            };
          }
          if (table === "team_invites") {
            return {
              select: () => ({
                eq: () => ({
                  is: () => ({
                    is: () => ({
                      gt: async () => ({ count: 0, error: null }),
                    }),
                  }),
                }),
              }),
            };
          }
          return {};
        }),
      } as unknown as SupabaseClient;

      const result = await checkUserQuota(mockSupabase, "org-123", 1);
      expect(result.allowed).toBe(false);
      expect(result.current).toBe(3);
      expect(result.max).toBe(3);
      expect(result.reason).toContain("Limite de usuários atingido");
    });

    it("deve barrar quando convites pendentes consumirem os assentos restantes", async () => {
      const mockSupabase = {
        from: vi.fn((table: string) => {
          if (table === "organizations") {
            return {
              select: () => ({
                eq: () => ({
                  single: async () => ({
                    data: { settings: { plan: "standard" } }, // max 3
                    error: null,
                  }),
                }),
              }),
            };
          }
          if (table === "user_organizations") {
            return {
              select: () => ({
                eq: () => ({
                  is: async () => ({ count: 1, error: null }), // 1 ativo
                }),
              }),
            };
          }
          if (table === "team_invites") {
            return {
              select: () => ({
                eq: () => ({
                  is: () => ({
                    is: () => ({
                      gt: async () => ({ count: 2, error: null }), // 2 convidados pendentes -> total 3
                    }),
                  }),
                }),
              }),
            };
          }
          return {};
        }),
      } as unknown as SupabaseClient;

      const result = await checkUserQuota(mockSupabase, "org-123", 1);
      expect(result.allowed).toBe(false);
      expect(result.current).toBe(3);
      expect(result.max).toBe(3);
      expect(result.reason).toContain("Limite de usuários atingido");
    });

    it("deve permitir quando houver assentos livres", async () => {
      const mockSupabase = {
        from: vi.fn((table: string) => {
          if (table === "organizations") {
            return {
              select: () => ({
                eq: () => ({
                  single: async () => ({
                    data: { settings: { plan: "standard" } },
                    error: null,
                  }),
                }),
              }),
            };
          }
          if (table === "user_organizations") {
            return {
              select: () => ({
                eq: () => ({
                  is: async () => ({ count: 1, error: null }),
                }),
              }),
            };
          }
          if (table === "team_invites") {
            return {
              select: () => ({
                eq: () => ({
                  is: () => ({
                    is: () => ({
                      gt: async () => ({ count: 0, error: null }),
                    }),
                  }),
                }),
              }),
            };
          }
          return {};
        }),
      } as unknown as SupabaseClient;

      const result = await checkUserQuota(mockSupabase, "org-123", 1);
      expect(result.allowed).toBe(true);
      expect(result.current).toBe(1);
    });

    it("deve permitir irrestrito no plano enterprise", async () => {
      const mockSupabase = {
        from: vi.fn(() => ({
          select: () => ({
            eq: () => ({
              single: async () => ({
                data: { settings: { plan: "enterprise" } },
                error: null,
              }),
            }),
          }),
        })),
      } as unknown as SupabaseClient;

      const result = await checkUserQuota(mockSupabase, "org-123", 100);
      expect(result.allowed).toBe(true);
      expect(result.max).toBeNull();
    });
  });

  describe("checkChannelQuota", () => {
    it("deve recusar canal que não faz parte do plano contratado", async () => {
      const mockSupabase = {
        from: vi.fn(() => ({
          select: () => ({
            eq: () => ({
              single: async () => ({
                data: { settings: { plan: "standard" } }, // standard só tem whatsapp e email
                error: null,
              }),
            }),
          }),
        })),
      } as unknown as SupabaseClient;

      const result = await checkChannelQuota(mockSupabase, "org-123", "telegram");
      expect(result.allowed).toBe(false);
      expect(result.reason).toContain("não está disponível no plano");
    });

    it("deve recusar quando ultrapassar o total de canais ativos permitidos", async () => {
      const mockSupabase = {
        from: vi.fn((table: string) => {
          if (table === "organizations") {
            return {
              select: () => ({
                eq: () => ({
                  single: async () => ({
                    data: { settings: { plan: "standard" } }, // max_channels = 1
                    error: null,
                  }),
                }),
              }),
            };
          }
          if (table === "channel_sessions") {
            return {
              select: () => ({
                eq: () => ({
                  is: async () => ({ count: 1, error: null }), // Já tem 1 canal ativo
                }),
              }),
            };
          }
          return {};
        }),
      } as unknown as SupabaseClient;

      const result = await checkChannelQuota(mockSupabase, "org-123", "whatsapp");
      expect(result.allowed).toBe(false);
      expect(result.reason).toContain("Limite de conexões de canais atingido");
    });

    it("deve permitir reconectar canal existente com excludeChannelSessionId mesmo com quota cheia", async () => {
      let excludeFiltroAplicado = false;
      const mockSupabase = {
        from: vi.fn((table: string) => {
          if (table === "organizations") {
            return {
              select: () => ({
                eq: () => ({
                  single: async () => ({
                    data: { settings: { plan: "standard" } }, // Max 1 canal
                    error: null,
                  }),
                }),
              }),
            };
          }
          if (table === "channel_sessions") {
            const builder = {
              eq: () => builder,
              is: () => builder,
              neq: (col: string, val: unknown) => {
                if (col === "id" && val === "sess-existente") {
                  excludeFiltroAplicado = true;
                }
                return builder;
              },
              then: (resolve: (v: unknown) => unknown) => {
                // Se excluiu a sessão existente, count é 0; caso contrário seria 1
                return Promise.resolve({ count: excludeFiltroAplicado ? 0 : 1, error: null }).then(resolve);
              },
            };
            return {
              select: () => builder,
            };
          }
          return {};
        }),
      } as unknown as SupabaseClient;

      const result = await checkChannelQuota(mockSupabase, "org-123", "whatsapp", {
        excludeChannelSessionId: "sess-existente",
      });
      expect(excludeFiltroAplicado).toBe(true);
      expect(result.allowed).toBe(true);
    });
  });

  describe("checkFeatureQuota", () => {
    it("deve bloquear funcionalidade campaigns no plano standard", async () => {
      const mockSupabase = {
        from: vi.fn(() => ({
          select: () => ({
            eq: () => ({
              single: async () => ({
                data: { settings: { plan: "standard" } },
                error: null,
              }),
            }),
          }),
        })),
      } as unknown as SupabaseClient;

      const result = await checkFeatureQuota(mockSupabase, "org-123", "campaigns");
      expect(result.allowed).toBe(false);
      expect(result.reason).toContain("não está disponível no plano");
    });

    it("deve liberar funcionalidade campaigns no plano pro", async () => {
      const mockSupabase = {
        from: vi.fn(() => ({
          select: () => ({
            eq: () => ({
              single: async () => ({
                data: { settings: { plan: "pro" } },
                error: null,
              }),
            }),
          }),
        })),
      } as unknown as SupabaseClient;

      const result = await checkFeatureQuota(mockSupabase, "org-123", "campaigns");
      expect(result.allowed).toBe(true);
    });
  });

  describe("AUD-05: Robustez contra Fail-Open, Overrides Inválidos e Erros de Infra", () => {
    // 1. checkChannelQuota — Standard permitido
    it("1. checkChannelQuota — permite canal autorizado no plano standard", async () => {
      const mockSupabase = {
        from: vi.fn((table: string) => {
          if (table === "organizations") {
            return {
              select: () => ({
                eq: () => ({
                  single: async () => ({
                    data: { settings: { plan: "standard" } },
                    error: null,
                  }),
                }),
              }),
            };
          }
          if (table === "channel_sessions") {
            return {
              select: () => ({
                eq: () => ({
                  is: async () => ({ count: 0, error: null }),
                }),
              }),
            };
          }
          return {};
        }),
      } as unknown as SupabaseClient;

      const result = await checkChannelQuota(mockSupabase, "org-1", "whatsapp");
      expect(result.allowed).toBe(true);
    });

    // 2. checkChannelQuota — provider proibido
    it("2. checkChannelQuota — recusa canal não autorizado no plano standard", async () => {
      const mockSupabase = {
        from: vi.fn(() => ({
          select: () => ({
            eq: () => ({
              single: async () => ({
                data: { settings: { plan: "standard" } },
                error: null,
              }),
            }),
          }),
        })),
      } as unknown as SupabaseClient;

      const result = await checkChannelQuota(mockSupabase, "org-1", "instagram");
      expect(result.allowed).toBe(false);
      expect(result.reason).toContain("não está disponível no plano STANDARD");
    });

    // 3. checkChannelQuota — DB error
    it("3. checkChannelQuota — DB error opera fail-closed", async () => {
      const mockSupabase = {
        from: vi.fn(() => ({
          select: () => ({
            eq: () => ({
              single: async () => ({
                data: null,
                error: { message: "database timeout", code: "PGRST500" },
              }),
            }),
          }),
        })),
      } as unknown as SupabaseClient;

      const result = await checkChannelQuota(mockSupabase, "org-1", "whatsapp");
      expect(result.allowed).toBe(false);
      expect(result.reason).toContain("Falha ao carregar configurações do plano");
    });

    // 4. checkChannelQuota — runtime exception
    it("4. checkChannelQuota — runtime exception opera fail-closed", async () => {
      const mockSupabase = {
        from: vi.fn(() => {
          throw new Error("Network crash");
        }),
      } as unknown as SupabaseClient;

      const result = await checkChannelQuota(mockSupabase, "org-1", "whatsapp");
      expect(result.allowed).toBe(false);
      expect(result.reason).toContain("Falha ao carregar configurações do plano");
    });

    // 5. checkFeatureQuota — permitido
    it("5. checkFeatureQuota — libera feature autorizada no plano pro", async () => {
      const mockSupabase = {
        from: vi.fn(() => ({
          select: () => ({
            eq: () => ({
              single: async () => ({
                data: { settings: { plan: "pro" } },
                error: null,
              }),
            }),
          }),
        })),
      } as unknown as SupabaseClient;

      const result = await checkFeatureQuota(mockSupabase, "org-1", "campaigns");
      expect(result.allowed).toBe(true);
    });

    // 6. checkFeatureQuota — feature desativada
    it("6. checkFeatureQuota — bloqueia feature não inclusa no plano standard", async () => {
      const mockSupabase = {
        from: vi.fn(() => ({
          select: () => ({
            eq: () => ({
              single: async () => ({
                data: { settings: { plan: "standard" } },
                error: null,
              }),
            }),
          }),
        })),
      } as unknown as SupabaseClient;

      const result = await checkFeatureQuota(mockSupabase, "org-1", "campaigns");
      expect(result.allowed).toBe(false);
      expect(result.reason).toContain("não está disponível no plano STANDARD");
    });

    // 7. checkFeatureQuota — DB error
    it("7. checkFeatureQuota — DB error opera fail-closed", async () => {
      const mockSupabase = {
        from: vi.fn(() => ({
          select: () => ({
            eq: () => ({
              single: async () => ({
                data: null,
                error: { message: "database offline" },
              }),
            }),
          }),
        })),
      } as unknown as SupabaseClient;

      const result = await checkFeatureQuota(mockSupabase, "org-1", "campaigns");
      expect(result.allowed).toBe(false);
    });

    // 8. checkFeatureQuota — runtime exception
    it("8. checkFeatureQuota — runtime exception opera fail-closed", async () => {
      const mockSupabase = {
        from: vi.fn(() => {
          throw new Error("fatal memory fault");
        }),
      } as unknown as SupabaseClient;

      const result = await checkFeatureQuota(mockSupabase, "org-1", "campaigns");
      expect(result.allowed).toBe(false);
    });

    // 9. checkUserQuota — dentro do limite
    it("9. checkUserQuota — permite dentro do limite", async () => {
      const mockSupabase = {
        from: vi.fn((table: string) => {
          if (table === "organizations") {
            return { select: () => ({ eq: () => ({ single: async () => ({ data: { settings: { plan: "standard" } }, error: null }) }) }) };
          }
          if (table === "user_organizations") {
            return { select: () => ({ eq: () => ({ is: async () => ({ count: 1, error: null }) }) }) };
          }
          if (table === "team_invites") {
            return { select: () => ({ eq: () => ({ is: () => ({ is: () => ({ gt: async () => ({ count: 0, error: null }) }) }) }) }) };
          }
          return {};
        }),
      } as unknown as SupabaseClient;

      const result = await checkUserQuota(mockSupabase, "org-1", 1);
      expect(result.allowed).toBe(true);
      expect(result.current).toBe(1);
    });

    // 10. checkUserQuota — limite atingido
    it("10. checkUserQuota — bloqueia quando limite é atingido", async () => {
      const mockSupabase = {
        from: vi.fn((table: string) => {
          if (table === "organizations") {
            return { select: () => ({ eq: () => ({ single: async () => ({ data: { settings: { plan: "standard" } }, error: null }) }) }) };
          }
          if (table === "user_organizations") {
            return { select: () => ({ eq: () => ({ is: async () => ({ count: 3, error: null }) }) }) };
          }
          if (table === "team_invites") {
            return { select: () => ({ eq: () => ({ is: () => ({ is: () => ({ gt: async () => ({ count: 0, error: null }) }) }) }) }) };
          }
          return {};
        }),
      } as unknown as SupabaseClient;

      const result = await checkUserQuota(mockSupabase, "org-1", 1);
      expect(result.allowed).toBe(false);
      expect(result.reason).toContain("Limite de usuários atingido");
    });

    // 11. checkUserQuota — DB error
    it("11. checkUserQuota — DB error opera fail-closed", async () => {
      const mockSupabase = {
        from: vi.fn(() => ({
          select: () => ({
            eq: () => ({
              single: async () => ({ data: null, error: { message: "query timeout" } }),
            }),
          }),
        })),
      } as unknown as SupabaseClient;

      const result = await checkUserQuota(mockSupabase, "org-1", 1);
      expect(result.allowed).toBe(false);
      expect(result.reason).toContain("Falha ao carregar configurações do plano");
    });

    // 12. plano desconhecido
    it("12. resolveTenantPlanLimits — plano desconhecido cai seguramente em standard (não ilimitado)", () => {
      const limits = resolveTenantPlanLimits({ plan: "hacker_gold_tier" });
      expect(limits.plan).toBe("standard");
      expect(limits.max_users).toBe(3);
      expect(limits.max_channels).toBe(1);
      expect(limits.features.campaigns).toBe(false);
    });

    // 13. plano null
    it("13. resolveTenantPlanLimits — plano null cai seguramente em standard", () => {
      const limits = resolveTenantPlanLimits({ plan: null });
      expect(limits.plan).toBe("standard");
      expect(limits.max_users).toBe(3);
      expect(limits.max_channels).toBe(1);
    });

    // 14. override válido
    it("14. resolveTenantPlanLimits — override válido é aplicado corretamente", () => {
      const limits = resolveTenantPlanLimits({
        plan: "standard",
        plan_limits: {
          max_users: 15,
          max_channels: 4,
          allowed_channels: ["whatsapp", "telegram"],
          features: { campaigns: true },
        },
      });
      expect(limits.max_users).toBe(15);
      expect(limits.max_channels).toBe(4);
      expect(limits.allowed_channels).toEqual(["whatsapp", "telegram"]);
      expect(limits.features.campaigns).toBe(true);
    });

    // 15. override inválido não contamina nem libera permissões
    it("15. resolveTenantPlanLimits — override malformado/inválido é descartado seguramente", () => {
      const limits = resolveTenantPlanLimits({
        plan: "standard",
        plan_limits: {
          max_users: -5, // Inválido: negativo
          max_channels: "ilimitado", // Inválido: tipo string
          allowed_channels: "todos", // Inválido: não é array
          features: { campaigns: "sim" }, // Inválido: não é booleano
        },
      });
      // Mantém os limites base seguros do plano standard
      expect(limits.max_users).toBe(3);
      expect(limits.max_channels).toBe(1);
      expect(limits.allowed_channels).toEqual(["whatsapp", "email"]);
      expect(limits.features.campaigns).toBe(false);
    });

    // 16. Enterprise irrestrito legítimo
    it("16. resolveTenantPlanLimits — enterprise opera como irrestrito por especificação", () => {
      const limits = resolveTenantPlanLimits({ plan: "enterprise" });
      expect(limits.plan).toBe("enterprise");
      expect(limits.max_users).toBeNull();
      expect(limits.max_channels).toBeNull();
      expect(limits.allowed_channels).toBeNull();
      expect(limits.features.campaigns).toBe(true);
    });

    // 17. Organização sem settings em checkChannelQuota opera fail-closed assumindo limites padrão standard
    it("17. checkChannelQuota — organização sem settings registradas opera fail-closed aplicando standard", async () => {
      const mockSupabase = {
        from: vi.fn(() => ({
          select: () => ({
            eq: () => ({
              single: async () => ({ data: null, error: null }),
            }),
          }),
        })),
      } as unknown as SupabaseClient;

      // Canal 'instagram' não é permitido no standard -> bloqueia com fail-closed
      const result = await checkChannelQuota(mockSupabase, "org-sem-settings", "instagram");
      expect(result.allowed).toBe(false);
      expect(result.reason).toContain("não está disponível no plano STANDARD");
    });
  });
});
