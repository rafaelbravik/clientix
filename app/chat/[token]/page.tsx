import { ChatWidgetClient } from "./_client";

interface PageProps {
  params: Promise<{ token: string }>;
}

export default async function ChatWidgetPage({ params }: PageProps) {
  const { token } = await params;
  return <ChatWidgetClient token={token} />;
}
