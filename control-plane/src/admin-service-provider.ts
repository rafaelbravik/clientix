import { z } from "zod";

import { createPool } from "@/lib/agent-engine/db/pool";
import { ControlPlaneAdminService } from "./admin-service";
import type { DatabaseClient } from "../scripts/migrator";

const controlPlaneConfigSchema = z.object({
  CONTROL_PLANE_DATABASE_URL: z.string().url(),
  CONTROL_PLANE_PEPPER: z.string().min(32),
});

type ControlPlaneEnvironment = {
  [key: string]: string | undefined;
  CONTROL_PLANE_DATABASE_URL?: string;
  CONTROL_PLANE_PEPPER?: string;
  SUPABASE_DB_URL?: string;
};

export class ControlPlaneConfigurationError extends Error {
  constructor() {
    super("Control Plane exige banco e pepper próprios, configurados fora do runtime do cliente.");
    this.name = "ControlPlaneConfigurationError";
  }
}

export function resolveControlPlaneConfig(
  source: ControlPlaneEnvironment,
  customerDatabaseUrl: string | undefined = source.SUPABASE_DB_URL,
): { databaseUrl: string; pepper: string } {
  const parsed = controlPlaneConfigSchema.safeParse(source);
  if (!parsed.success) throw new ControlPlaneConfigurationError();

  if (
    customerDatabaseUrl &&
    pointsToSameDatabase(parsed.data.CONTROL_PLANE_DATABASE_URL, customerDatabaseUrl)
  ) {
    throw new ControlPlaneConfigurationError();
  }

  return {
    databaseUrl: parsed.data.CONTROL_PLANE_DATABASE_URL,
    pepper: parsed.data.CONTROL_PLANE_PEPPER,
  };
}

function pointsToSameDatabase(first: string, second: string): boolean {
  try {
    const a = new URL(first);
    const b = new URL(second);
    const portA = a.port || "5432";
    const portB = b.port || "5432";
    const databaseA = decodeURIComponent(a.pathname.replace(/\/$/, ""));
    const databaseB = decodeURIComponent(b.pathname.replace(/\/$/, ""));
    return (
      a.hostname.toLowerCase() === b.hostname.toLowerCase() &&
      portA === portB &&
      databaseA === databaseB
    );
  } catch {
    return true;
  }
}

class PostgresDatabaseClient implements DatabaseClient {
  constructor(private readonly pool: ReturnType<typeof createPool>) {}

  async query<R = Record<string, unknown>>(
    sql: string,
    params: unknown[] = [],
  ): Promise<{ rows: R[]; rowCount?: number }> {
    const result = await this.pool.query(sql, params);
    return {
      rows: result.rows as R[],
      rowCount: result.rowCount ?? undefined,
    };
  }
}

let _adminService: ControlPlaneAdminService | null = null;
let _databasePool: ReturnType<typeof createPool> | null = null;

export const CONTROL_PLANE_BILLING_SCHEDULER_LOCK_ID = "8182838485861104";

export function getControlPlaneAdminService(): ControlPlaneAdminService {
  if (!_adminService) {
    const config = resolveControlPlaneConfig(process.env);
    _adminService = new ControlPlaneAdminService({
      db: getControlPlaneDatabaseClient(),
      pepper: config.pepper,
    });
  }
  return _adminService;
}

/** Shared vendor-only Control Plane connection for billing and admin services. */
export function getControlPlaneDatabaseClient(): DatabaseClient {
  const config = resolveControlPlaneConfig(process.env);
  _databasePool ??= createPool(config.databaseUrl, undefined, {
    localDockerHosts: ["control-plane-db"],
  });
  return new PostgresDatabaseClient(_databasePool);
}

/** Holds one Vendor-only PostgreSQL session lock for the full scheduler cycle. */
export async function withControlPlaneBillingSchedulerLock<T>(
  operation: () => Promise<T>,
): Promise<{ acquired: false } | { acquired: true; value: T }> {
  getControlPlaneDatabaseClient();
  const pool = _databasePool;
  if (!pool) throw new ControlPlaneConfigurationError();
  const client = await pool.connect();
  let acquired = false;
  let destroyClient = false;
  try {
    const result = await client.query<{ acquired: boolean }>(
      "select pg_try_advisory_lock($1::bigint) as acquired;",
      [CONTROL_PLANE_BILLING_SCHEDULER_LOCK_ID],
    );
    acquired = result.rows[0]?.acquired === true;
    if (!acquired) return { acquired: false };
    return { acquired: true, value: await operation() };
  } finally {
    if (acquired) {
      try {
        const result = await client.query<{ released: boolean }>(
          "select pg_advisory_unlock($1::bigint) as released;",
          [CONTROL_PLANE_BILLING_SCHEDULER_LOCK_ID],
        );
        destroyClient = result.rows[0]?.released !== true;
      } catch {
        destroyClient = true;
      }
    }
    client.release(destroyClient ? new Error("Billing scheduler lock release failed.") : undefined);
  }
}
