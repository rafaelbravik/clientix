import { describe, expect, it } from "vitest";

import { maskDocument, maskEmail, maskPhone, mascararTitularDoPedido } from "@/lib/lgpd/mask";

describe("mascaramento de dados no recibo operacional", () => {
  it("mascara CPF, CNPJ, telefone e e-mail", () => {
    expect(maskDocument("123.456.789-09")).toBe("***.***.***-09");
    expect(maskDocument("12.345.678/0001-95")).toBe("**.***.***/****-95");
    expect(maskPhone("+55 (11) 99999-1234")).toBe("(**) ****-1234");
    expect(maskEmail("pessoa@example.test")).toBe("p***@example.test");
  });

  it("não tenta descriptografar CPF e não reimprime nome do titular", () => {
    const masked = mascararTitularDoPedido({
      customer: { name: "Nome Privado", cpf_encrypted: "ciphertext", email: "pessoa@example.test" },
    });
    expect(masked.documento_mascarado).toBeNull();
    expect(masked.email_mascarado).toBe("p***@example.test");
    expect(JSON.stringify(masked)).not.toContain("Nome Privado");
    expect(JSON.stringify(masked)).not.toContain("ciphertext");
  });
});
