import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Atendimento Online",
  description: "Canal de atendimento e suporte via Web Chat",
  robots: { index: false, follow: false },
  referrer: "no-referrer",
};

export default function ChatWidgetLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <div className="flex h-dvh w-full flex-col bg-background text-foreground antialiased select-text">
      {children}
    </div>
  );
}
