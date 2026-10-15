/** Synthetic, credential-free subset used by installer unit tests. */
export function createHostgatorTemplateFixture(images: {
  app: string;
  worker: string;
  scheduler: string;
}): string {
  return [
    "# Fixture sintética de configuração do instalador; não contém credenciais.",
    `APP_IMAGE=${images.app}`,
    `WORKER_IMAGE=${images.worker}`,
    `SCHEDULER_IMAGE=${images.scheduler}`,
    "",
    "# O install.sh pergunta na primeira instalação; a escolha fica persistida.",
    "# SENTRY_DSN=",
    "# SENTRY_DSN=off",
    "# SENTRY_DSN=             → aceita o Sentry da comunidade",
    "# SENTRY_DSN=<seu-dsn>",
    "",
    "# AI_BUDGET_ENFORCEMENT=on",
    "# Use off para liberar a alavanca de emergência.",
  ].join("\n");
}
