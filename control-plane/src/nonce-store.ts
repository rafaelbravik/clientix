import type { DatabaseClient } from "../scripts/migrator";
import type { NonceStore } from "@/lib/licensing/installation-auth";

/**
 * PostgreSQL-backed NonceStore for Control Plane using control_plane.licensing_nonces.
 */
export class PostgresNonceStore implements NonceStore {
  constructor(private readonly client: DatabaseClient) {}

  async consumeNonce(
    installationId: string,
    nonce: string,
    expiresAtUnixSeconds: number,
    currentUnixSeconds?: number,
  ): Promise<boolean> {
    const now = currentUnixSeconds ?? Math.floor(Date.now() / 1000);
    const expiresAtIso = new Date(expiresAtUnixSeconds * 1000).toISOString();

    try {
      // First attempt prune expired nonces for this installation if any (lightweight maintenance)
      await this.client.query(
        `delete from control_plane.licensing_nonces where installation_id = $1 and expires_at <= $2;`,
        [installationId, new Date(now * 1000).toISOString()],
      );

      // Attempt atomic insert
      await this.client.query(
        `insert into control_plane.licensing_nonces (installation_id, nonce, expires_at)
         values ($1, $2, $3);`,
        [installationId, nonce, expiresAtIso],
      );
      return true;
    } catch (err: unknown) {
      // Unique constraint violation (23505) indicates duplicate/replayed nonce
      const msg = (err as Error).message || "";
      if (msg.includes("duplicate key") || msg.includes("23505") || msg.includes("primary key")) {
        return false;
      }
      throw err;
    }
  }
}
