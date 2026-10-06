import { describe, it, expect } from "vitest";
import {
  motivoParaExcluir,
  enderecoDoCandidato,
  classificarAudiencia,
} from "@/lib/campanhas/elegibilidade";
import {
  criarCampanhaSchema,
  editarCampanhaSchema,
  previaSchema,
} from "@/lib/campanhas/schemas";
import { MOTIVOS_DE_EXCLUSAO, TEXTO_DA_EXCLUSAO } from "@/lib/campanhas/tipos";

describe("Central de Campanhas Multicanal - Elegibilidade e Regras", () => {
  it("deve validar elegibilidade para canal WhatsApp", () => {
    expect(
      motivoParaExcluir(
        {
          contactId: "c1",
          telefone: "+5511999998888",
          bloqueado: false,
          anonimizado: false,
          recusouMarketing: false,
        },
        "whatsapp",
      ),
    ).toBeNull();

    expect(
      motivoParaExcluir(
        {
          contactId: "c2",
          telefone: null,
          bloqueado: false,
          anonimizado: false,
          recusouMarketing: false,
        },
        "whatsapp",
      ),
    ).toBe("sem_telefone");

    expect(
      motivoParaExcluir(
        {
          contactId: "c3",
          telefone: "11999998888", // Falta o + do E.164
          bloqueado: false,
          anonimizado: false,
          recusouMarketing: false,
        },
        "whatsapp",
      ),
    ).toBe("telefone_invalido");
  });

  it("deve validar elegibilidade para canal E-mail", () => {
    expect(
      motivoParaExcluir(
        {
          contactId: "c1",
          telefone: null,
          email: "contato@empresa.com.br",
          bloqueado: false,
          anonimizado: false,
          recusouMarketing: false,
        },
        "email",
      ),
    ).toBeNull();

    expect(
      motivoParaExcluir(
        {
          contactId: "c2",
          telefone: "+5511999998888",
          email: null,
          bloqueado: false,
          anonimizado: false,
          recusouMarketing: false,
        },
        "email",
      ),
    ).toBe("sem_email");

    expect(
      motivoParaExcluir(
        {
          contactId: "c3",
          telefone: null,
          email: "email-invalido-sem-arroba",
          bloqueado: false,
          anonimizado: false,
          recusouMarketing: false,
        },
        "email",
      ),
    ).toBe("email_invalido");
  });

  it("deve validar elegibilidade para canal Telegram", () => {
    expect(
      motivoParaExcluir(
        {
          contactId: "c1",
          telefone: null,
          telegramChatId: "123456789",
          bloqueado: false,
          anonimizado: false,
          recusouMarketing: false,
        },
        "telegram",
      ),
    ).toBeNull();

    expect(
      motivoParaExcluir(
        {
          contactId: "c2",
          telefone: "+5511999998888",
          telegramChatId: null,
          bloqueado: false,
          anonimizado: false,
          recusouMarketing: false,
        },
        "telegram",
      ),
    ).toBeNull();

    expect(
      motivoParaExcluir(
        {
          contactId: "c3",
          telefone: null,
          telegramChatId: null,
          bloqueado: false,
          anonimizado: false,
          recusouMarketing: false,
        },
        "telegram",
      ),
    ).toBe("sem_telegram");
  });

  it("deve honrar opt-out, anonimização LGPD e recusa comercial em qualquer canal", () => {
    const canais: Array<"whatsapp" | "telegram" | "email"> = ["whatsapp", "telegram", "email"];

    for (const canal of canais) {
      expect(
        motivoParaExcluir(
          {
            contactId: "c1",
            telefone: "+5511999998888",
            email: "teste@teste.com",
            telegramChatId: "12345",
            bloqueado: true,
            anonimizado: false,
            recusouMarketing: false,
          },
          canal,
        ),
      ).toBe("opt_out");

      expect(
        motivoParaExcluir(
          {
            contactId: "c2",
            telefone: "+5511999998888",
            email: "teste@teste.com",
            telegramChatId: "12345",
            bloqueado: false,
            anonimizado: true,
            recusouMarketing: false,
          },
          canal,
        ),
      ).toBe("anonimizado");

      expect(
        motivoParaExcluir(
          {
            contactId: "c3",
            telefone: "+5511999998888",
            email: "teste@teste.com",
            telegramChatId: "12345",
            bloqueado: false,
            anonimizado: false,
            recusouMarketing: true,
          },
          canal,
        ),
      ).toBe("recusou_marketing");
    }
  });

  it("deve resolver o endereço correto para deduplicação e envio por canal", () => {
    const contato = {
      contactId: "c1",
      telefone: "+5511999998888",
      email: "Cliente@EMPRESA.com",
      telegramChatId: "987654321",
      bloqueado: false,
      anonimizado: false,
      recusouMarketing: false,
    };

    expect(enderecoDoCandidato(contato, "whatsapp")).toBe("+5511999998888");
    expect(enderecoDoCandidato(contato, "email")).toBe("cliente@empresa.com");
    expect(enderecoDoCandidato(contato, "telegram")).toBe("987654321");
  });

  it("deve ter rótulos legíveis para todos os novos motivos de exclusão", () => {
    expect(MOTIVOS_DE_EXCLUSAO).toContain("sem_email");
    expect(MOTIVOS_DE_EXCLUSAO).toContain("email_invalido");
    expect(MOTIVOS_DE_EXCLUSAO).toContain("sem_telegram");

    expect(TEXTO_DA_EXCLUSAO.sem_email).toBe("Sem endereço de e-mail no cadastro");
    expect(TEXTO_DA_EXCLUSAO.email_invalido).toBe("E-mail fora do formato de envio");
    expect(TEXTO_DA_EXCLUSAO.sem_telegram).toBe("Sem identificador de Telegram no cadastro");
  });

  it("deve classificar audiência multicanal e barrar duplicados pelo endereço do canal", () => {
    const candidatos = [
      {
        contactId: "c1",
        nome: "Ana",
        telefone: "+5511911111111",
        email: "ana@teste.com",
        telegramChatId: "1001",
        bloqueado: false,
        anonimizado: false,
        recusouMarketing: false,
      },
      {
        contactId: "c2",
        nome: "Ana Segunda",
        telefone: "+5511922222222",
        email: "ana@teste.com", // Mesmo e-mail que c1!
        telegramChatId: "1002",
        bloqueado: false,
        anonimizado: false,
        recusouMarketing: false,
      },
    ];

    const ctx = {
      canal: "email" as const,
      excluidosAMao: new Set<string>(),
      jaEmCampanha: new Set<string>(),
      suprimidos: new Set<string>(),
      hashDoEndereco: (e: string) => `hash:${e}`,
      renderizar: () => ({ texto: "Olá!", faltando: [] }),
    };

    const resultado = classificarAudiencia(candidatos, ctx);
    expect(resultado).toHaveLength(2);
    expect(resultado[0]?.elegivel).toBe(true);
    expect(resultado[1]?.elegivel).toBe(false);
    expect(resultado[1]?.motivo).toBe("duplicado");
  });
});

describe("Schemas de Validação de Campanhas Multicanal", () => {
  it("deve validar e aceitar criação de campanhas de WhatsApp, Telegram e E-mail", () => {
    const baseValida = {
      name: "Campanha Black Friday",
      channel_session_id: "11111111-1111-4111-8111-111111111111",
      message_body: "Confira as nossas ofertas exclusivas!",
      base_legal: "consent" as const,
    };

    // WhatsApp
    const rWhats = criarCampanhaSchema.safeParse({
      ...baseValida,
      channel: "whatsapp",
    });
    expect(rWhats.success).toBe(true);

    // Telegram
    const rTele = criarCampanhaSchema.safeParse({
      ...baseValida,
      channel: "telegram",
    });
    expect(rTele.success).toBe(true);

    // E-mail sem assunto deve falhar
    const rEmailSemAssunto = criarCampanhaSchema.safeParse({
      ...baseValida,
      channel: "email",
    });
    expect(rEmailSemAssunto.success).toBe(false);

    // E-mail com assunto deve passar
    const rEmailComAssunto = criarCampanhaSchema.safeParse({
      ...baseValida,
      channel: "email",
      email_subject: "Super Ofertas de Outubro",
    });
    expect(rEmailComAssunto.success).toBe(true);
  });

  it("deve aceitar canal e assunto no previaSchema", () => {
    const previa = previaSchema.safeParse({
      audience_filter: { com_alguma_tag: ["cliente"], limite: 100 },
      message_body: "Olá {{nome}}",
      channel: "email",
      email_subject: "Assunto da Prévia",
    });

    expect(previa.success).toBe(true);
    if (previa.success) {
      expect(previa.data.channel).toBe("email");
      expect(previa.data.email_subject).toBe("Assunto da Prévia");
    }
  });
});
