import { describe, expect, it } from "vitest";

import { renderTemplate } from "@/lib/automation/template";
import { interpolateTemplate } from "@/lib/inbox/template-vars";

describe("Protocolo de atendimento (Etapa 1 Clientix)", () => {
  describe("interpolateTemplate (Inbox)", () => {
    it("interpola {{protocolo}} quando informado", () => {
      const texto = "Olá {{nome}}, seu protocolo é {{protocolo}}.";
      const res = interpolateTemplate(texto, {
        name: "Carlos Eduardo",
        protocolo: "PROT-20261001-1042",
      });
      expect(res).toBe("Olá Carlos Eduardo, seu protocolo é PROT-20261001-1042.");
    });

    it("mantém {{protocolo}} literal se não houver protocolo", () => {
      const texto = "Olá {{nome}}, seu protocolo é {{protocolo}}.";
      const res = interpolateTemplate(texto, {
        name: "Carlos",
        protocolo: null,
      });
      expect(res).toBe("Olá Carlos, seu protocolo é {{protocolo}}.");
    });

    it("funciona com caixa alta ou espaços extras", () => {
      const texto = "Protocolo: {{ PROTOCOLO }}";
      const res = interpolateTemplate(texto, {
        protocolo: "PROT-20261001-9999",
      });
      expect(res).toBe("Protocolo: PROT-20261001-9999");
    });
  });

  describe("renderTemplate (Automações)", () => {
    it("resolve alias {{protocolo}} a partir de conversation.protocolo", () => {
      const res = renderTemplate("Atendimento iniciado: {{protocolo}}", {
        conversation: { protocolo: "PROT-20261001-0005" },
      });
      expect(res).toBe("Atendimento iniciado: PROT-20261001-0005");
    });

    it("resolve caminho explícito {{conversation.protocolo}}", () => {
      const res = renderTemplate("Seu código: {{conversation.protocolo}}", {
        conversation: { protocolo: "PROT-20261001-0007" },
      });
      expect(res).toBe("Seu código: PROT-20261001-0007");
    });
  });
});
