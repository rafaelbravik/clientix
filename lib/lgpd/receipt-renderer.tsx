import {
  Document,
  Page,
  StyleSheet,
  Text,
  View,
  renderToBuffer,
} from "@react-pdf/renderer";

import type { ReceiptContent, ReceiptIntegrity } from "@/lib/lgpd/operational-receipt";

const CATEGORY_LABELS: Record<string, string> = {
  contacts: "Contatos",
  conversations: "Conversas",
  messages: "Mensagens",
  crm_leads: "Negócios",
  crm_lead_activities: "Atividades do CRM",
  orders: "Pedidos",
  appointments: "Agendamentos",
  agent_cases: "Casos de atendimento",
  campaigns: "Campanhas",
  notes: "Notas",
  proposals: "Propostas",
};

const styles = StyleSheet.create({
  page: { paddingTop: 42, paddingBottom: 40, paddingHorizontal: 48, fontSize: 10, color: "#202124", fontFamily: "Helvetica" },
  title: { fontSize: 18, fontFamily: "Helvetica-Bold", marginBottom: 6 },
  subtitle: { fontSize: 9, color: "#555", marginBottom: 18 },
  notice: { padding: 10, borderWidth: 1, borderColor: "#c9d3df", backgroundColor: "#f4f7fa", marginBottom: 16, lineHeight: 1.45 },
  section: { marginTop: 11, marginBottom: 5, fontSize: 11, fontFamily: "Helvetica-Bold", color: "#26394d" },
  row: { flexDirection: "row", marginBottom: 4, lineHeight: 1.35 },
  label: { width: 145, fontFamily: "Helvetica-Bold", color: "#4a4a4a" },
  value: { flexGrow: 1, flexShrink: 1 },
  list: { marginLeft: 10, marginBottom: 3, lineHeight: 1.35 },
  code: { marginTop: 4, fontFamily: "Courier", fontSize: 9, lineHeight: 1.4 },
  footer: { position: "absolute", bottom: 20, left: 48, right: 48, fontSize: 8, color: "#666", textAlign: "center" },
});

function dataHora(value: string, timezone: string, locale: string): string {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return value;
  try {
    return new Intl.DateTimeFormat(locale, {
      dateStyle: "long",
      timeStyle: "short",
      timeZone: timezone,
    }).format(date);
  } catch {
    return new Intl.DateTimeFormat(locale, {
      dateStyle: "long",
      timeStyle: "short",
      timeZone: "UTC",
    }).format(date);
  }
}

function scopeLabel(scope: ReceiptContent["request_scope"]): string {
  return scope === "tenant" ? "Organização" : "Contato";
}

export async function renderOperationalReceiptPdf(
  content: ReceiptContent,
  integrity: ReceiptIntegrity,
): Promise<Buffer> {
  const categories = content.result_counts.length
    ? content.result_counts
    : [{ category: "contacts", count: 0 }];
  const doc = (
    <Document
      title="Recibo Operacional de Anonimização"
      author={content.organization_name}
      creationDate={new Date(content.completed_at)}
      modificationDate={new Date(content.completed_at)}
      pdfVersion="1.7"
    >
      <Page size="A4" style={styles.page}>
        <Text style={styles.title}>Recibo Operacional de Anonimização</Text>
        <Text style={styles.subtitle}>Evidência operacional do processamento registrado pelo sistema</Text>

        <Text style={styles.notice}>
          Este recibo registra as ações executadas pelo sistema em atendimento ao pedido identificado abaixo.
          Ele não declara certificação jurídica nem conformidade absoluta.
        </Text>

        <Text style={styles.section}>Controlador</Text>
        <View style={styles.row}><Text style={styles.label}>Nome / razão social</Text><Text style={styles.value}>{content.organization_name}</Text></View>
        {content.organization_cnpj ? <View style={styles.row}><Text style={styles.label}>CNPJ</Text><Text style={styles.value}>{content.organization_cnpj}</Text></View> : null}
        <View style={styles.row}><Text style={styles.label}>Contato de privacidade</Text><Text style={styles.value}>{content.dpo_email ?? "Não informado pelo controlador"}</Text></View>

        <Text style={styles.section}>Pedido</Text>
        <View style={styles.row}><Text style={styles.label}>Protocolo</Text><Text style={styles.value}>{content.request_id}</Text></View>
        <View style={styles.row}><Text style={styles.label}>Recebido em</Text><Text style={styles.value}>{dataHora(content.request_received_at, content.timezone, content.locale)}</Text></View>
        <View style={styles.row}><Text style={styles.label}>Escopo</Text><Text style={styles.value}>{scopeLabel(content.request_scope)}</Text></View>
        <View style={styles.row}><Text style={styles.label}>Origem</Text><Text style={styles.value}>{content.request_source}</Text></View>
        <View style={styles.row}><Text style={styles.label}>Titular</Text><Text style={styles.value}>{content.requester.identificacao_nao_reimpressa}</Text></View>
        {content.requester.documento_mascarado ? <View style={styles.row}><Text style={styles.label}>Documento</Text><Text style={styles.value}>{content.requester.documento_mascarado}</Text></View> : null}
        {content.requester.telefone_mascarado ? <View style={styles.row}><Text style={styles.label}>Telefone</Text><Text style={styles.value}>{content.requester.telefone_mascarado}</Text></View> : null}
        {content.requester.email_mascarado ? <View style={styles.row}><Text style={styles.label}>E-mail</Text><Text style={styles.value}>{content.requester.email_mascarado}</Text></View> : null}

        <Text style={styles.section}>Execução</Text>
        <View style={styles.row}><Text style={styles.label}>Concluída em</Text><Text style={styles.value}>{dataHora(content.completed_at, content.timezone, content.locale)} ({content.timezone})</Text></View>
        <View style={styles.row}><Text style={styles.label}>Modo</Text><Text style={styles.value}>{content.execution_mode}</Text></View>
        <View style={styles.row}><Text style={styles.label}>Origem da execução</Text><Text style={styles.value}>{content.execution_origin}</Text></View>
        {content.execution_actor_user_id ? (
          <View style={styles.row}>
            <Text style={styles.label}>Aprovado por (ID interno)</Text>
            <Text style={styles.value}>{content.execution_actor_user_id}</Text>
          </View>
        ) : null}

        <Text style={styles.section}>Resultado operacional</Text>
        {categories.map((entry) => (
          <Text key={entry.category} style={styles.list}>
            • {CATEGORY_LABELS[entry.category] ?? "Dados/processos"}: {entry.count}
          </Text>
        ))}
        <View style={styles.row}>
          <Text style={styles.label}>Anexos e mídias</Text>
          <Text style={styles.value}>
            {content.media_queued > 0
              ? `${content.media_queued} item(ns) enfileirado(s) para remoção segura`
              : "Nenhum item foi enfileirado para remoção"}
          </Text>
        </View>

        <Text style={styles.section}>Integridade</Text>
        <View style={styles.row}>
          <Text style={styles.label}>{integrity.code_type === "autenticidade" ? "Código de autenticidade" : "Código de integridade"}</Text>
          <Text style={styles.value}>{integrity.code} · {integrity.algorithm}</Text>
        </View>
        <Text style={styles.code}>SHA-256 do conteúdo estruturado: {integrity.content_sha256}</Text>

        <Text style={styles.footer}>
          Recibo operacional do sistema · controlador: {content.organization_name} · fuso horário: {content.timezone}
        </Text>
      </Page>
    </Document>
  );
  return Buffer.from(await renderToBuffer(doc));
}
