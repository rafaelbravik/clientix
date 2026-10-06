import { ChatWidgetClient } from "../[token]/_client";

export default function ChatWidgetSessionPage() {
  // Inicializa o widget utilizando a sessão autenticada persistida no cookie HttpOnly __clientix_widget
  return <ChatWidgetClient />;
}
