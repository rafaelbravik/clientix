import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { loadEnv as loadWorkerEnv } from "@/lib/agent-engine/env";
import { LICENSE_RUNTIME_READER_GID } from "@/lib/licensing/enforcement";
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
  it("persists the strict ingress policy in the HostGator-generated environment", async () => {
    const installer = await fs.readFile(path.resolve("hostgator-setup-kit/install.sh"), "utf8");
    const start = installer.indexOf("  printf '# Gerado por install.sh");
    const end = installer.indexOf("} > .env", start);
    const generatedEnvBlock = start >= 0 && end > start ? installer.slice(start, end) : "";

    expect(generatedEnvBlock).toContain('envq CLIENTIX_INGRESS_MODE "production"');
    expect(generatedEnvBlock).toContain('envq CLIENTIX_ALLOW_INSECURE_HTTP "false"');
  });

  it("declares app, worker, scheduler, voice, and migration inputs in the distribution template", async () => {
    const keys = await readInstallerTemplateKeys();
    const required = [
      "NODE_ENV",
      "INSTALLATION_ID",
      "DOMAIN",
      "ACME_EMAIL",
      "CLIENTIX_ACME_CHALLENGE",
      "CLIENTIX_ACME_DNS_PROVIDER",
      "NEXT_PUBLIC_APP_URL",
      "NEXT_PUBLIC_ADMIN_URL",
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
      "CADDY_IMAGE",
      "ARI_URL",
      "ARI_WS_URL",
      "ARI_USERNAME",
      "ARI_PASSWORD",
    ];
    for (const key of required)
      expect(keys.has(key), `${key} is missing from .env.example`).toBe(true);
  });

  it("keeps DNS-01 Cloudflare explicit, signed, and runtime-secret-only", async () => {
    const template = await fs.readFile(path.resolve("distribution/installer/.env.example"), "utf8");
    const installer = await fs.readFile(path.resolve("distribution/installer/install.sh"), "utf8");
    const compose = await fs.readFile(path.resolve("distribution/installer/compose.yaml"), "utf8");
    const dnsCompose = await fs.readFile(
      path.resolve("distribution/installer/compose.dns-cloudflare.yaml"),
      "utf8",
    );
    const dnsCaddyfile = await fs.readFile(
      path.resolve("distribution/installer/Caddyfile.dns-cloudflare"),
      "utf8",
    );
    const caddyDockerfile = await fs.readFile(path.resolve("Dockerfile.caddy"), "utf8");

    expect(template).toContain("CLIENTIX_ACME_CHALLENGE=direct");
    expect(template).toContain("CLIENTIX_ACME_DNS_PROVIDER=");
    expect(template).toContain("CLIENTIX_ACME_SECRET_MODE=external");
    expect(template).toContain("CLIENTIX_CLOUDFLARE_TOKEN_FILE=");
    expect(template).toContain("CLIENTIX_CLOUDFLARE_TOKEN_OWNER_UID=");
    expect(template).not.toMatch(/^CLOUDFLARE_API_TOKEN=/m);
    expect(compose).toContain("caddy:2.11.7-alpine@sha256:");
    expect(dnsCompose).toContain("CADDY_IMAGE:?a signed release manifest");
    expect(dnsCompose).toContain("source: ${CLIENTIX_CLOUDFLARE_TOKEN_FILE:?DNS-01 external secret path is required}");
    expect(dnsCompose).toContain("read_only: true");
    expect(dnsCompose).toContain("create_host_path: false");
    expect(dnsCompose).not.toContain("state/secrets/cloudflare-api-token");
    const ephemeralCompose = await fs.readFile(
      path.resolve("distribution/installer/compose.dns-cloudflare-ephemeral.yaml"),
      "utf8",
    );
    expect(ephemeralCompose).toContain("/run/secrets:mode=0700");
    expect(ephemeralCompose).toContain("clientix-caddy-ephemeral-entrypoint");
    expect(dnsCaddyfile).toContain("dns cloudflare {file./run/secrets/cloudflare_api_token}");
    expect(dnsCaddyfile).toContain("disable_http_challenge");
    expect(dnsCaddyfile).toContain("disable_tlsalpn_challenge");
    expect(caddyDockerfile).toContain("caddy:2.11.7-builder-alpine@sha256:");
    expect(caddyDockerfile).toContain("github.com/caddy-dns/cloudflare@v0.2.4");
    expect(caddyDockerfile).toContain("ARG SOURCE_DATE_EPOCH=0");
    expect(caddyDockerfile).toContain("RUN --mount=type=bind,from=builder,source=/usr/bin/caddy");
    expect(caddyDockerfile).toContain(
      'touch -m -d "@${SOURCE_DATE_EPOCH}" /usr /usr/bin /usr/local /usr/local/bin /usr/bin/caddy /usr/local/bin/clientix-caddy-ephemeral-entrypoint',
    );
    expect(installer).toContain("INGRESS_DNS_IMAGE_UNAVAILABLE");
    expect(installer).toContain('d.images.caddy || ""');
    expect(installer).toContain("CLOUDFLARE_EXTERNAL_SECRET_INVALID");
    expect(installer).toContain("CLOUDFLARE_EPHEMERAL_STDIN_REQUIRED");
    expect(installer).toContain("CLOUDFLARE_TOKEN_ENV_FORBIDDEN");
    expect(installer).toContain("validate_external_cloudflare_secret_file");
    expect(installer).toContain("compose exec -T caddy");
    expect(installer).toContain("remove_legacy_cloudflare_secret_after_ready");
    expect(installer).not.toContain('printf \'%s\' "$CLOUDFLARE_API_TOKEN"');
  });

  it("mounts licenses writable only for the app and grants the canonical reader group to app, worker, and voice", async () => {
    const compose = await fs.readFile(path.resolve("distribution/installer/compose.yaml"), "utf8");
    const installer = await fs.readFile(path.resolve("distribution/installer/install.sh"), "utf8");
    expect(compose).toContain("- ./licenses:/opt/clientix/licenses:rw");
    expect(compose).toContain("- ./licenses:/opt/clientix/licenses:ro");
    const readerGroup = `group_add:\n      - "${LICENSE_RUNTIME_READER_GID}"`;
    expect(compose.match(/group_add:\n      - "1001"/g)).toHaveLength(3);
    const appService = compose.match(/  app:\n([\s\S]*?)\n  worker:/)?.[1] ?? "";
    const workerService = compose.match(/  worker:\n([\s\S]*?)\n  scheduler:/)?.[1] ?? "";
    const voiceService = compose.match(/  voice-agent:\n([\s\S]*?)\nnetworks:/)?.[1] ?? "";
    const schedulerService = compose.match(/  scheduler:\n([\s\S]*?)\n  voice-agent:/)?.[1] ?? "";
    for (const service of [appService, workerService, voiceService]) {
      expect(service).toContain(readerGroup);
    }
    expect(appService).toContain("- ./licenses:/opt/clientix/licenses:rw");
    expect(workerService).toContain("- ./licenses:/opt/clientix/licenses:ro");
    expect(voiceService).toContain("- ./licenses:/opt/clientix/licenses:ro");
    expect(schedulerService).not.toContain("group_add:");
    expect(schedulerService).not.toContain("/opt/clientix/licenses");
    expect(installer).toContain(
      `chown ${LICENSE_RUNTIME_READER_GID}:${LICENSE_RUNTIME_READER_GID} "$INSTALL_DIR/state" "$INSTALL_DIR/licenses"`,
    );
    expect(installer).toContain(
      `chown ${LICENSE_RUNTIME_READER_GID}:${LICENSE_RUNTIME_READER_GID} "$INSTALL_DIR/licenses/license.json"`,
    );
    expect(installer).toContain('chmod 2750 "$INSTALL_DIR/state" "$INSTALL_DIR/licenses"');
    expect(installer).toContain('chmod 640 "$INSTALL_DIR/licenses/license.json"');
  });

  it("keeps runtime bind mounts group-readable without granting group write access", async () => {
    const installer = await fs.readFile(path.resolve("distribution/installer/install.sh"), "utf8");
    expect(installer).toContain('chmod 2750 "$INSTALL_DIR/state" "$INSTALL_DIR/licenses"');
    expect(installer).not.toContain('chmod 2770 "$INSTALL_DIR/state" "$INSTALL_DIR/licenses"');
  });

  it("waits for a verified public HTTPS health response after startup", async () => {
    const installer = await fs.readFile(path.resolve("distribution/installer/install.sh"), "utf8");
    const compose = await fs.readFile(path.resolve("distribution/installer/compose.yaml"), "utf8");
    expect(installer).toContain('--resolve "${DOMAIN}:443:127.0.0.1"');
    expect(installer).toContain('"https://${DOMAIN}/api/v1/health"');
    expect(installer).toContain("strict-transport-security: max-age=31536000");
    expect(installer).toContain("HTTPS_INGRESS_NOT_READY");
    expect(compose).toContain("http://127.0.0.1:3000/api/v1/health");
    expect(compose).not.toContain("require('net').connect");
  });

  it("publishes only the TLS ingress and keeps the app on private networks", async () => {
    const compose = await fs.readFile(path.resolve("distribution/installer/compose.yaml"), "utf8");
    const template = await fs.readFile(path.resolve("distribution/installer/.env.example"), "utf8");
    const appService = compose.match(/  app:\n([\s\S]*?)\n  worker:/)?.[1] ?? "";
    const caddyService = compose.match(/  caddy:\n([\s\S]*?)\nnetworks:/)?.[1] ?? "";

    expect(appService).not.toContain("ports:");
    expect(appService).toContain("clientix-ingress");
    expect(caddyService).toContain('"80:80"');
    expect(caddyService).toContain('"443:443"');
    expect(caddyService).toContain("caddy-data:/data");
    expect(appService).toMatch(/^      PORT: "3000"$/m);
    expect(compose).toContain("http://127.0.0.1:3000/api/v1/health");
    expect(template).toContain("DOMAIN=");
    expect(template).toContain("ACME_EMAIL=");
    expect(template).not.toMatch(/^PORT=/m);
  });

  it("fails closed for production HTTP and permits it only with explicit local loopback opt-in", async () => {
    const base: Record<string, string> = {
      NODE_ENV: "production",
      CLIENTIX_INGRESS_MODE: "production",
      CLIENTIX_ALLOW_INSECURE_HTTP: "false",
      DOMAIN: "client.example.com",
      NEXT_PUBLIC_APP_URL: "https://client.example.com",
      NEXT_PUBLIC_ADMIN_URL: "https://client.example.com",
      NEXT_PUBLIC_SUPABASE_URL: "https://supabase.example.test",
      NEXT_PUBLIC_SUPABASE_ANON_KEY: "test-anon-key",
      SUPABASE_SERVICE_ROLE_KEY: "test-service-role",
      INTERNAL_SECRET: "i".repeat(64),
      CPF_ENCRYPTION_KEY: "c".repeat(64),
      WAHA_BYO_ENCRYPTION_KEY: "w".repeat(64),
      AI_CRED_AES_KEY: Buffer.alloc(32).toString("base64"),
      SUPABASE_DB_URL: "postgresql://app:password@db.example.test:5432/postgres",
      WAHA_API_BASE_URL: "https://waha.example.test",
      WAHA_API_KEY: "test-waha-key",
      // A integração WAHA pode usar HTTP só no bridge privado do Compose;
      // o instalador comercial externo exige a origem pública HTTPS.
      WAHA_WEBHOOK_BASE_URL: "http://app:3000",
      UPSTASH_REDIS_REST_URL: "https://redis.example.test",
      UPSTASH_REDIS_REST_TOKEN: "test-redis-token",
    };

    try {
      for (const [key, value] of Object.entries({
        ...base,
        NEXT_PUBLIC_APP_URL: "http://client.example.com",
      }))
        vi.stubEnv(key, value);
      vi.resetModules();
      await expect(import("@/lib/env")).rejects.toThrow();

      for (const [key, value] of Object.entries({
        ...base,
        NEXT_PUBLIC_APP_URL: "https://attacker.example.com",
      }))
        vi.stubEnv(key, value);
      vi.resetModules();
      await expect(import("@/lib/env")).rejects.toThrow();

      for (const [key, value] of Object.entries({
        ...base,
        NODE_ENV: "development",
        CLIENTIX_INGRESS_MODE: "local",
        CLIENTIX_ALLOW_INSECURE_HTTP: "true",
        NEXT_PUBLIC_APP_URL: "http://localhost:3000",
        NEXT_PUBLIC_ADMIN_URL: "http://localhost:3000",
        WAHA_WEBHOOK_BASE_URL: "http://localhost:3000",
      }))
        vi.stubEnv(key, value);
      vi.resetModules();
      const { env } = await import("@/lib/env");
      expect(env.CLIENTIX_INGRESS_MODE).toBe("local");
      expect(env.CLIENTIX_ALLOW_INSECURE_HTTP).toBe("true");

      for (const [key, value] of Object.entries({
        ...base,
        CLIENTIX_INGRESS_MODE: "local",
        CLIENTIX_ALLOW_INSECURE_HTTP: "true",
        NEXT_PUBLIC_APP_URL: "http://localhost:3000",
        NEXT_PUBLIC_ADMIN_URL: "http://localhost:3000",
        WAHA_WEBHOOK_BASE_URL: "http://localhost:3000",
      }))
        vi.stubEnv(key, value);
      const avisoHttpLocal = vi.fn();
      vi.doMock("@/lib/logger", () => ({ logger: { warn: avisoHttpLocal } }));
      vi.resetModules();
      const appLocal = await import("@/lib/env");
      expect(appLocal.env.NODE_ENV).toBe("production");
      expect(appLocal.env.CLIENTIX_INGRESS_MODE).toBe("local");
      expect(avisoHttpLocal).toHaveBeenCalledWith(
        "HTTP inseguro habilitado apenas para uso local; não exponha esta instalação à internet.",
        { ingress_mode: "local", insecure_http_opt_in: true },
      );
      vi.doUnmock("@/lib/logger");

      for (const [key, value] of Object.entries({
        ...base,
        CLIENTIX_INGRESS_MODE: "local",
        CLIENTIX_ALLOW_INSECURE_HTTP: "false",
        NEXT_PUBLIC_APP_URL: "http://localhost:3000",
        NEXT_PUBLIC_ADMIN_URL: "http://localhost:3000",
        WAHA_WEBHOOK_BASE_URL: "http://localhost:3000",
      }))
        vi.stubEnv(key, value);
      vi.resetModules();
      await expect(import("@/lib/env")).rejects.toThrow();

      for (const [key, value] of Object.entries({
        ...base,
        META_WEBHOOK_BASE_URL: "https://hooks.client-webhooks.net",
      }))
        vi.stubEnv(key, value);
      vi.resetModules();
      const comWebhookSeparado = await import("@/lib/env");
      expect(comWebhookSeparado.env.META_WEBHOOK_BASE_URL).toBe(
        "https://hooks.client-webhooks.net",
      );
    } finally {
      vi.doUnmock("@/lib/logger");
      vi.unstubAllEnvs();
      vi.resetModules();
    }
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
      CLIENTIX_INGRESS_MODE: "production",
      CLIENTIX_ALLOW_INSECURE_HTTP: "false",
      DOMAIN: "client.example.com",
      NEXT_PUBLIC_APP_URL: "https://client.example.com",
      NEXT_PUBLIC_ADMIN_URL: "https://client.example.com",
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
      WAHA_WEBHOOK_BASE_URL: "http://app:3000",
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
