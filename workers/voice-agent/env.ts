import { z } from "zod";

const schema = z.object({
  ARI_URL: z.string().url(),
  ARI_WS_URL: z.string().url(),
  ARI_USERNAME: z.string().min(1),
  ARI_PASSWORD: z.string().min(1),
  ARI_APP: z.string().min(1).default("voice-agent"),
});

export type VoiceAgentEnv = z.infer<typeof schema>;

export function loadVoiceAgentEnv(source: NodeJS.ProcessEnv = process.env): VoiceAgentEnv {
  const parsed = schema.safeParse(source);
  if (!parsed.success) {
    const missing = [...new Set(parsed.error.issues.map((issue) => issue.path.join(".")))];
    throw new Error(`env de telefonia inválido — verifique no .env: ${missing.join(", ")}`);
  }
  return parsed.data;
}
