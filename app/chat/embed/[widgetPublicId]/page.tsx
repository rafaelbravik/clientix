import { notFound } from "next/navigation";
import { z } from "zod";

import { WebchatEmbedClient } from "@/components/chat-widget/WebchatEmbedClient";

export const dynamic = "force-dynamic";

export default async function WebchatEmbedPage(props: {
  params: Promise<{ widgetPublicId: string }>;
}) {
  const { widgetPublicId } = await props.params;
  const parsed = z.string().uuid().safeParse(widgetPublicId);
  if (!parsed.success) notFound();

  return <WebchatEmbedClient widgetPublicId={parsed.data} />;
}
