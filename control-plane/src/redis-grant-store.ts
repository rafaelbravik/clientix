import type {
  DistributionGrant,
  DistributionTokenClaims,
  TargetArchitecture,
} from "./distribution-types";
import type { IRedisClient } from "./redis-client-interface";

/**
 * Clientix L8.1G.3 — Production Shared Distribution Grant Store (Redis/Upstash)
 *
 * Implements canonical DistributionGrantStore interface with:
 * 1. Explicit namespace: `clientix:distribution:grant:<tokenHash>`
 * 2. Revocation markers: `clientix:distribution:revoked:<grantId>`
 * 3. Atomic consumption via single-turn Lua script (validates existence, revocation, TTL, artifact permission, and decrements quota).
 * 4. Strict fail-closed schema validation on deserialize.
 * 5. Outage policy: throws controlled Error / returns fail-closed when store is unreachable.
 */

export interface ConsumeArtifactResult {
  allowed: boolean;
  code?: "OK" | "GRANT_NOT_FOUND" | "GRANT_REVOKED" | "GRANT_EXPIRED" | "ARTIFACT_NOT_ALLOWED" | "ARTIFACT_GRANT_EXHAUSTED" | "MALFORMED_GRANT";
  reason?: string;
}

export interface DistributionGrantStore {
  createGrant(grant: DistributionGrant, ttlSeconds: number): Promise<void>;
  getGrant(tokenHash: string): Promise<DistributionGrant | null>;
  consumeArtifactUse(tokenHash: string, artifactId: string, currentUnixSeconds: number): Promise<ConsumeArtifactResult>;
  revokeGrant(grantId: string): Promise<void>;
  isRevoked(grantId: string): Promise<boolean>;
}

/**
 * Raw JSON-serializable schema for Redis storage
 */
export interface RedisGrantPayload {
  grantId: string;
  tokenHash: string;
  installationId: string;
  licenseId: string;
  releaseId: string;
  architecture: TargetArchitecture;
  allowedArtifactIds: string[];
  expiresAt: number;
  createdAt: number;
  revoked: boolean;
  remainingUses: Record<string, number>;
}

export function validateAndParseGrantPayload(rawJson: string): DistributionGrant | null {
  try {
    const parsed = JSON.parse(rawJson);
    if (typeof parsed !== "object" || parsed === null) return null;

    if (
      typeof parsed.grantId !== "string" ||
      typeof parsed.tokenHash !== "string" ||
      typeof parsed.installationId !== "string" ||
      typeof parsed.licenseId !== "string" ||
      typeof parsed.releaseId !== "string" ||
      (parsed.architecture !== "amd64" && parsed.architecture !== "arm64") ||
      !Array.isArray(parsed.allowedArtifactIds) ||
      typeof parsed.expiresAt !== "number" ||
      typeof parsed.createdAt !== "number" ||
      typeof parsed.remainingUses !== "object" ||
      parsed.remainingUses === null
    ) {
      return null;
    }

    const claims: DistributionTokenClaims = {
      grantId: parsed.grantId,
      installationId: parsed.installationId,
      licenseId: parsed.licenseId,
      releaseId: parsed.releaseId,
      architecture: parsed.architecture,
      allowedArtifactIds: parsed.allowedArtifactIds,
      expiresAt: parsed.expiresAt,
      createdAt: parsed.createdAt,
    };

    const remainingUses = new Map<string, number>();
    for (const [artId, count] of Object.entries(parsed.remainingUses)) {
      if (typeof count === "number" && Number.isInteger(count) && count >= 0) {
        remainingUses.set(artId, count);
      } else {
        return null;
      }
    }

    return {
      grantId: parsed.grantId,
      tokenHash: parsed.tokenHash,
      claims,
      remainingUses,
    };
  } catch {
    return null;
  }
}

/**
 * Lua script for atomic artifact use consumption.
 *
 * KEYS[1]: grant key (clientix:distribution:grant:<tokenHash>)
 * KEYS[2]: revoke key (clientix:distribution:revoked:<grantIdPrefix>... resolved via grant body or passed)
 * ARGV[1]: artifactId
 * ARGV[2]: currentUnixSeconds
 *
 * Returns integer code:
 *  0: SUCCESS (decremented remaining uses)
 *  1: GRANT_NOT_FOUND
 *  2: GRANT_EXPIRED
 *  3: GRANT_REVOKED
 *  4: ARTIFACT_NOT_ALLOWED
 *  5: ARTIFACT_GRANT_EXHAUSTED
 *  6: MALFORMED_GRANT
 */
export const ATOMIC_CONSUME_LUA_SCRIPT = `
local grantKey = KEYS[1]
local artifactId = ARGV[1]
local now = tonumber(ARGV[2])

local raw = redis.call('GET', grantKey)
if not raw then
  return 1
end

local ok, grant = pcall(cjson.decode, raw)
if not ok or type(grant) ~= 'table' then
  return 6
end

if grant.revoked == true then
  return 3
end

-- Check revoked key marker if set
if grant.grantId then
  local revokeMarker = redis.call('GET', 'clientix:distribution:revoked:' .. grant.grantId)
  if revokeMarker then
    return 3
  end
end

if tonumber(grant.expiresAt) <= now then
  return 2
end

-- Check artifact in allowedArtifactIds
local allowed = false
if type(grant.allowedArtifactIds) == 'table' then
  for _, id in ipairs(grant.allowedArtifactIds) do
    if id == artifactId then
      allowed = true
      break
    end
  end
end

if not allowed then
  return 4
end

-- Check remaining uses
if type(grant.remainingUses) ~= 'table' then
  return 6
end

local count = tonumber(grant.remainingUses[artifactId])
if not count or count <= 0 then
  return 5
end

-- Atomic Decrement & Save
grant.remainingUses[artifactId] = count - 1
local updatedJson = cjson.encode(grant)
local ttl = redis.call('TTL', grantKey)

if ttl > 0 then
  redis.call('SET', grantKey, updatedJson, 'EX', ttl)
else
  redis.call('SET', grantKey, updatedJson)
end

return 0
`;

export class RedisGrantStore implements DistributionGrantStore {
  private readonly prefix = "clientix:distribution:grant:";
  private readonly revokePrefix = "clientix:distribution:revoked:";

  constructor(private readonly redis: IRedisClient) {}

  private getGrantKey(tokenHash: string): string {
    return `${this.prefix}${tokenHash}`;
  }

  private getRevokeKey(grantId: string): string {
    return `${this.revokePrefix}${grantId}`;
  }

  async createGrant(grant: DistributionGrant, ttlSeconds: number): Promise<void> {
    const key = this.getGrantKey(grant.tokenHash);
    const ttl = Math.min(Math.max(ttlSeconds, 60), 3600); // Bounded 60s - 3600s

    const remainingUsesObj: Record<string, number> = {};
    for (const [artId, count] of grant.remainingUses.entries()) {
      remainingUsesObj[artId] = count;
    }

    const payload: RedisGrantPayload = {
      grantId: grant.grantId,
      tokenHash: grant.tokenHash,
      installationId: grant.claims.installationId,
      licenseId: grant.claims.licenseId,
      releaseId: grant.claims.releaseId,
      architecture: grant.claims.architecture,
      allowedArtifactIds: grant.claims.allowedArtifactIds,
      expiresAt: grant.claims.expiresAt,
      createdAt: grant.claims.createdAt,
      revoked: false,
      remainingUses: remainingUsesObj,
    };

    await this.redis.set(key, JSON.stringify(payload), { ex: ttl });
  }

  async getGrant(tokenHash: string): Promise<DistributionGrant | null> {
    const key = this.getGrantKey(tokenHash);
    const raw = await this.redis.get(key);
    if (!raw) return null;

    const grant = validateAndParseGrantPayload(raw);
    if (!grant) return null;

    const isRev = await this.isRevoked(grant.grantId);
    if (isRev) return null;

    return grant;
  }

  async isRevoked(grantId: string): Promise<boolean> {
    const revokeKey = this.getRevokeKey(grantId);
    const res = await this.redis.get(revokeKey);
    return res !== null;
  }

  async revokeGrant(grantId: string): Promise<void> {
    const revokeKey = this.getRevokeKey(grantId);
    // Keep revocation marker in Redis for up to 3600s (max lifetime of grant)
    await this.redis.set(revokeKey, "1", { ex: 3600 });
  }

  async consumeArtifactUse(
    tokenHash: string,
    artifactId: string,
    currentUnixSeconds: number
  ): Promise<ConsumeArtifactResult> {
    const grantKey = this.getGrantKey(tokenHash);

    const resultCode = await this.redis.eval<number>(
      ATOMIC_CONSUME_LUA_SCRIPT,
      [grantKey],
      [artifactId, currentUnixSeconds]
    );

    switch (resultCode) {
      case 0:
        return { allowed: true, code: "OK" };
      case 1:
        return { allowed: false, code: "GRANT_NOT_FOUND", reason: "Distribution grant not found." };
      case 2:
        return { allowed: false, code: "GRANT_EXPIRED", reason: "Distribution grant expired." };
      case 3:
        return { allowed: false, code: "GRANT_REVOKED", reason: "Distribution grant revoked." };
      case 4:
        return { allowed: false, code: "ARTIFACT_NOT_ALLOWED", reason: "Artifact not allowed for this grant." };
      case 5:
        return { allowed: false, code: "ARTIFACT_GRANT_EXHAUSTED", reason: "Download attempt quota exhausted for this artifact grant." };
      case 6:
      default:
        return { allowed: false, code: "MALFORMED_GRANT", reason: "Malformed grant state in store." };
    }
  }
}
