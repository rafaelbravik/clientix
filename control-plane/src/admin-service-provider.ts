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

  if (customerDatabaseUrl && pointsToSameDatabase(parsed.data.CONTROL_PLANE_DATABASE_URL, customerDatabaseUrl)) {
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
    return a.hostname.toLowerCase() === b.hostname.toLowerCase() && portA === portB && databaseA === databaseB;
  } catch {
    return true;
  }
}

class PostgresDatabaseClient implements DatabaseClient {
  constructor(private readonly pool: ReturnType<typeof createPool>) {}

  async query<R = Record<string, unknown>>(
    sql: string,
    params: unknown[] = []
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

export function getControlPlaneAdminService(): ControlPlaneAdminService {
  if (!_adminService) {
    const config = resolveControlPlaneConfig(process.env);
    _databasePool ??= createPool(config.databaseUrl);
    _adminService = new ControlPlaneAdminService({
      db: new PostgresDatabaseClient(_databasePool),
      pepper: config.pepper,
    });
  }
  return _adminService;
}
