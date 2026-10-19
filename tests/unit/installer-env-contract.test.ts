import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { loadEnv as loadWorkerEnv } from "@/lib/agent-engine/env";
import { loadVoiceAgentEnv } from "@/workers/voice-agent/env";

async function readInstallerTemplateKeys() {
  const template = await fs.readFile(path.resolve("distribution/installer/.env.example"), "utf8");
  return new Set(
    template
      .split(/\r?\n/)
      .map((line) => line.match(/^([A-Z][A-Z0-9_]*)=/)?.[1])
      .filter((key): key is string => key !== undefined),
  );
}

describe("commercial installer runtime environment contract", () => {
  it("declares app, worker, scheduler, voice, and migration inputs in the distribution template", async () => {
    const keys = await readInstallerTemplateKeys();
    const required = [
      "NODE_ENV",
      "INSTALLATION_ID",
      "NEXT_PUBLIC_APP_URL",
      "NEXT_PUBLIC_SUPABASE_URL",
      "NEXT_PUBLIC_SUPABASE_ANON_KEY",
      "SUPABASE_SERVICE_ROLE_KEY",
      "SUPABASE_DB_URL",
      "SUPABASE_DB_ADMIN_URL",
      "INTERNAL_SECRET",
      "CPF_ENCRYPTION_KEY",
      "WAHA_BYO_ENCRYPTION_KEY",
      "AI_CRED_AES_KEY",
      "WAHA_API_BASE_URL",
      "WAHA_API_KEY",
      "WAHA_WEBHOOK_BASE_URL",
      "UPSTASH_REDIS_REST_URL",
      "UPSTASH_REDIS_REST_TOKEN",
      "APP_IMAGE",
      "WORKER_IMAGE",
      "SCHEDULER_IMAGE",
      "VOICE_AGENT_IMAGE",
      "MIGRATOR_IMAGE",
      "ARI_URL",
      "ARI_WS_URL",
      "ARI_USERNAME",
      "ARI_PASSWORD",
    ];
    for (const key of required)
      expect(keys.has(key), `${key} is missing from .env.example`).toBe(true);
  });

  it("mounts licenses writable only for the app and grants the non-root readers access", async () => {
    const compose = await fs.readFile(path.resolve("distribution/installer/compose.yaml"), "utf8");
    expect(compose).toContain("- ./licenses:/opt/clientix/licenses:rw");
    expect(compose).toContain("- ./licenses:/opt/clientix/licenses:ro");
    expect(compose.match(/group_add:\n      - "1001"/g)).toHaveLength(2);
  });

  it("keeps runtime bind mounts group-readable without granting group write access", async () => {
    const installer = await fs.readFile(path.resolve("distribution/installer/install.sh"), "utf8");
    expect(installer).toContain('chmod 2750 "$INSTALL_DIR/state" "$INSTALL_DIR/licenses"');
    expect(installer).not.toContain('chmod 2770 "$INSTALL_DIR/state" "$INSTALL_DIR/licenses"');
  });

  it("waits for the dependency-aware application health endpoint after startup", async () => {
    const installer = await fs.readFile(path.resolve("distribution/installer/install.sh"), "utf8");
    const compose = await fs.readFile(path.resolve("distribution/installer/compose.yaml"), "utf8");
    expect(installer).toContain('"http://127.0.0.1:${port}/api/v1/health"');
    expect(installer).not.toContain('"http://127.0.0.1:${port}/login"');
    expect(installer).toContain('if [ "$http_code" = "200" ]; then');
    expect(compose).toContain("http://127.0.0.1:3000/api/v1/health");
    expect(compose).not.toContain("require('net').connect");
  });

  it("keeps the host-published PORT separate from the app's internal port", async () => {
    const compose = await fs.readFile(path.resolve("distribution/installer/compose.yaml"), "utf8");
    const template = await fs.readFile(path.resolve("distribution/installer/.env.example"), "utf8");
    const appService = compose.match(/  app:\n([\s\S]*?)\n  worker:/)?.[1] ?? "";

    expect(compose).toContain('- "${PORT:-3000}:3000"');
    expect(appService).toMatch(/^      PORT: "3000"$/m);
    expect(compose).toContain("http://127.0.0.1:3000/api/v1/health");
    expect(template).toMatch(/# Porta publicada no host\. O app escuta internamente em 3000\.\nPORT=3000/);
  });

  it("keeps credentials out of host process arguments and preflights runtime DB access", async () => {
    const installer = await fs.readFile(path.resolve("distribution/installer/install.sh"), "utf8");
    expect(installer).toContain('--env-file "$env_file"');
    expect(installer).toContain("--config -");
    expect(installer).not.toMatch(/-e DATABASE_URL=/);
    expect(installer).not.toMatch(/-H\s+"(?:apikey|Authorization|X-Api-Key):\s*\$[A-Z_]+/);
    expect(installer).not.toContain('awk -v key="$key" -v value="$value"');
    expect(installer).toContain("run_runtime_db_preflight");
  });

  it("requires the voice profile's startup credentials when telephony is enabled", async () => {
    const installer = await fs.readFile(path.resolve("distribution/installer/install.sh"), "utf8");
    expect(installer).toContain("ARI_URL ARI_WS_URL ARI_USERNAME ARI_PASSWORD OPENAI_API_KEY");
  });

  it("loads the app's production environment from the commercial template", async () => {
    const values: Record<string, string> = {
      NODE_ENV: "production",
      NEXT_PUBLIC_APP_URL: "https://client.example.test",
      NEXT_PUBLIC_SUPABASE_URL: "https://supabase.example.test",
      NEXT_PUBLIC_SUPABASE_ANON_KEY: "test-anon-key",
      SUPABASE_SERVICE_ROLE_KEY: "test-service-role",
      INTERNAL_SECRET: "i".repeat(64),
      CPF_ENCRYPTION_KEY: "c".repeat(64),
      WAHA_BYO_ENCRYPTION_KEY: "w".repeat(64),
      AI_CRED_AES_KEY: Buffer.alloc(32).toString("base64"),
      SUPABASE_DB_URL: "postgresql://app:password@db.example.test:5432/postgres",
      SUPABASE_DB_ADMIN_URL: "",
      WAHA_API_BASE_URL: "https://waha.example.test",
      WAHA_API_KEY: "test-waha-key",
      WAHA_WEBHOOK_BASE_URL: "https://client.example.test",
      UPSTASH_REDIS_REST_URL: "https://redis.example.test",
      UPSTASH_REDIS_REST_TOKEN: "test-redis-token",
    };

    try {
      for (const [key, value] of Object.entries(values)) vi.stubEnv(key, value);
      vi.resetModules();
      const { env } = await import("@/lib/env");
      expect(env.NEXT_PUBLIC_APP_URL).toBe(values.NEXT_PUBLIC_APP_URL);
      expect(env.SUPABASE_DB_ADMIN_URL).toBe("");
    } finally {
      vi.unstubAllEnvs();
      vi.resetModules();
    }
  });

  it("loads worker and optional voice envs and covers the scheduler entrypoint contract", async () => {
    const worker = loadWorkerEnv({
      NODE_ENV: "test",
      SUPABASE_DB_URL: "postgresql://app:password@db.example.test:5432/postgres",
      NEXT_PUBLIC_SUPABASE_URL: "https://supabase.example.test",
      SUPABASE_SERVER_URL: "",
      SUPABASE_SERVICE_ROLE_KEY: "test-service-role",
      UPSTASH_REDIS_REST_URL: "https://redis.example.test",
      UPSTASH_REDIS_REST_TOKEN: "test-redis-token",
      WAHA_API_BASE_URL: "https://waha.example.test",
      WAHA_API_KEY: "test-waha-key",
    });
    const voice = loadVoiceAgentEnv({
      NODE_ENV: "test",
      ARI_URL: "http://asterisk.example.test:8088",
      ARI_WS_URL: "ws://asterisk.example.test:8088/ari/events",
      ARI_USERNAME: "test-user",
      ARI_PASSWORD: "test-password",
    });

    expect(worker.SUPABASE_DB_URL).toContain("postgresql://");
    expect(voice.ARI_APP).toBe("voice-agent");

    const scheduler = await fs.readFile(path.resolve("docker/scheduler/entrypoint.sh"), "utf8");
    const keys = await readInstallerTemplateKeys();
    expect(scheduler).toContain('if [ -z "${INTERNAL_SECRET:-}" ]');
    expect(keys.has("INTERNAL_SECRET")).toBe(true);
    expect(keys.has("COMPOSE_PROFILES")).toBe(true);
    expect(keys.has("UPSTASH_REDIS_REST_TOKEN")).toBe(true);
  });
});
