import { getRequestPool } from "@/lib/agent-engine/db/request-pool";
import { ControlPlaneAdminService } from "./admin-service";
import type { DatabaseClient } from "../scripts/migrator";

class PostgresDatabaseClient implements DatabaseClient {
  async query<R = Record<string, unknown>>(
    sql: string,
    params: unknown[] = []
  ): Promise<{ rows: R[]; rowCount?: number }> {
    const pool = getRequestPool();
    const result = await pool.query(sql, params);
    return {
      rows: result.rows as R[],
      rowCount: result.rowCount ?? undefined,
    };
  }
}

let _adminService: ControlPlaneAdminService | null = null;

export function getControlPlaneAdminService(): ControlPlaneAdminService {
  if (!_adminService) {
    const pepper = process.env.CONTROL_PLANE_PEPPER || process.env.LICENSE_PEPPER || "clientix_default_control_plane_pepper_min_32_bytes";
    _adminService = new ControlPlaneAdminService({
      db: new PostgresDatabaseClient(),
      pepper,
    });
  }
  return _adminService;
}
