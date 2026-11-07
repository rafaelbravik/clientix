import { createHash, randomUUID } from "node:crypto";

import { canonicalizeToBuffer } from "@/lib/licensing/canonicalize";
import type { LicensePayload, SignedLicenseDocument } from "@/lib/licensing/types";
import { SignedLicenseDocumentSchema } from "@/lib/licensing/schema";
import type { DatabaseClient } from "../scripts/migrator";
import { LicenseIssuer } from "./license-issuer";
import type { VendorSignerProvider } from "./signer";

interface LicenseArtifactContext {
  license_id: string;
  serial: string;
  customer_id: string;
  customer_name: string;
  customer_email: string | null;
  customer_country: string | null;
  customer_status: "ACTIVE" | "DISABLED";
  license_status: "DRAFT" | "ACTIVE" | "EXPIRED" | "SUSPENDED" | "REVOKED";
  installation_id: string;
  installation_status: string;
  clone_status: string;
  product: string;
  deployment: string;
  plan: "standard" | "pro" | "enterprise";
  license_type: LicensePayload["license_type"];
  signing_key_id: string;
  license_revision: number | string;
  max_installations: number;
  max_tenants: number | null;
  resale_allowed: boolean;
  white_label: boolean;
  features: string[];
  issued_at: string | null;
  valid_from: string;
  expires_at: string;
  maintenance_until: string | null;
  grace_days: number;
}

interface ArtifactJob {
  artifact_id: string;
  license_id: string;
  installation_id: string;
  license_revision: number | string;
  source: string;
  status: "PENDING" | "PROCESSING" | "ISSUED" | "SUPERSEDED";
  signed_document: unknown;
}

export interface LicenseArtifactProcessingResult {
  issued: number;
  pending: number;
  superseded: number;
  failed: number;
}

export class LicenseArtifactPendingError extends Error {
  constructor() {
    super("A signed license artifact is queued for safe retry.");
    this.name = "LicenseArtifactPendingError";
  }
}

export class LicenseArtifactService {
  constructor(
    private readonly db: DatabaseClient,
    private readonly signerProvider: VendorSignerProvider,
    private readonly trustedPublicKeys: Record<string, string>,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async issueCurrentForInstallation(params: {
    licenseId: string;
    installationId: string;
    source: "ACTIVATION" | "ONLINE_VALIDATION" | "ADMIN_EXPORT";
  }): Promise<SignedLicenseDocument> {
    let context = await this.loadContext(params.licenseId, params.installationId);
    if (
      !context ||
      context.license_status !== "ACTIVE" ||
      context.customer_status !== "ACTIVE" ||
      context.installation_status !== "ACTIVE" ||
      context.clone_status !== "NORMAL"
    ) {
      throw new Error("An active license installation is required for a signed artifact.");
    }

    const activeKey = await this.signerProvider.getSigningKey();
    if (context.signing_key_id !== activeKey.keyId) {
      await this.db.query(
        `update control_plane.licensing_licenses
            set signing_key_id = $2, issued_at = $3, updated_at = $3
          where id = $1 and signing_key_id <> $2;`,
        [context.license_id, activeKey.keyId, this.now().toISOString()],
      );
      context = await this.loadContext(params.licenseId, params.installationId);
      if (!context || context.signing_key_id !== activeKey.keyId) {
        throw new Error("The active signing key could not be selected for this license.");
      }
    }

    const revision = Number(context.license_revision);
    const idempotencyKey = `license:${context.license_id}:${context.installation_id}:${revision}`;
    await this.db.query(
      `insert into control_plane.licensing_license_artifacts
         (license_id, installation_id, license_revision, key_id, issued_at, expires_at,
          status, source, idempotency_key)
       values ($1::uuid, $2, $3, $4, coalesce($5::timestamptz, now()), $6, 'PENDING', $7, $8)
       on conflict (license_id, installation_id, license_revision) do nothing;`,
      [
        context.license_id,
        context.installation_id,
        revision,
        activeKey.keyId,
        context.issued_at,
        context.expires_at,
        params.source,
        idempotencyKey,
      ],
    );

    const existing = await this.getArtifact(context.license_id, context.installation_id, revision);
    if (existing?.status === "ISSUED") return parseStoredDocument(existing.signed_document);

    if (existing?.status === "PROCESSING") {
      const completed = await this.waitForConcurrentArtifact(existing.artifact_id);
      if (completed) return completed;
    }

    const document = await this.issueArtifact(existing?.artifact_id, activeKey.keyId);
    if (document) return document;
    if (existing) {
      const completed = await this.waitForConcurrentArtifact(existing.artifact_id);
      if (completed) return completed;
    }
    throw new LicenseArtifactPendingError();
  }

  async processPending(
    params: { licenseId?: string; limit?: number } = {},
  ): Promise<LicenseArtifactProcessingResult> {
    const limit = Math.max(1, Math.min(250, Math.trunc(params.limit ?? 100)));
    const pending = await this.db.query<{ artifact_id: string }>(
      `select artifact_id
         from control_plane.licensing_license_artifacts
        where ((status = 'PENDING' and next_attempt_at <= now())
           or (status = 'PROCESSING' and lease_expires_at <= now()))
          and ($1::uuid is null or license_id = $1::uuid)
        order by next_attempt_at, created_at
        limit $2;`,
      [params.licenseId ?? null, limit],
    );
    let issued = 0;
    let superseded = 0;
    let failed = 0;
    for (const row of pending.rows) {
      try {
        const result = await this.issueArtifact(row.artifact_id);
        if (result) issued += 1;
      } catch (error) {
        if (!(error instanceof LicenseArtifactPendingError)) throw error;
        failed += 1;
      }
      const status = await this.db.query<{ status: string }>(
        `select status from control_plane.licensing_license_artifacts where artifact_id = $1;`,
        [row.artifact_id],
      );
      if (status.rows[0]?.status === "SUPERSEDED") superseded += 1;
    }
    const remaining = await this.db.query<{ count: number | string }>(
      `select count(*)::int as count
         from control_plane.licensing_license_artifacts
        where status in ('PENDING', 'PROCESSING')
          and ($1::uuid is null or license_id = $1::uuid);`,
      [params.licenseId ?? null],
    );
    return { issued, pending: Number(remaining.rows[0]?.count ?? 0), superseded, failed };
  }

  private async issueArtifact(
    artifactId: string | undefined,
    requestedKeyId?: string,
  ): Promise<SignedLicenseDocument | null> {
    if (!artifactId) return null;
    const leaseOwner = `artifact-${randomUUID()}`;
    const claim = await this.db.query<ArtifactJob>(
      `with candidate as (
         select artifact_id
           from control_plane.licensing_license_artifacts
          where artifact_id = $1
            and ((status = 'PENDING' and next_attempt_at <= now())
              or (status = 'PROCESSING' and lease_expires_at <= now()))
          for update skip locked
       )
       update control_plane.licensing_license_artifacts a
          set status = 'PROCESSING', attempt_count = attempt_count + 1,
              lease_owner = $2, lease_expires_at = now() + interval '2 minutes'
         from candidate
        where a.artifact_id = candidate.artifact_id
       returning a.artifact_id, a.license_id, a.installation_id, a.license_revision,
                 a.source, a.status, a.signed_document;`,
      [artifactId, leaseOwner],
    );
    const job = claim.rows[0];
    if (!job) {
      const latest = await this.db.query<ArtifactJob>(
        `select artifact_id, license_id, installation_id, license_revision, source, status, signed_document
           from control_plane.licensing_license_artifacts where artifact_id = $1;`,
        [artifactId],
      );
      const current = latest.rows[0];
      return current?.status === "ISSUED" ? parseStoredDocument(current.signed_document) : null;
    }

    try {
      const context = await this.loadContext(job.license_id, job.installation_id);
      if (
        !context ||
        Number(context.license_revision) !== Number(job.license_revision) ||
        context.license_status !== "ACTIVE" ||
        context.customer_status !== "ACTIVE" ||
        context.installation_status !== "ACTIVE"
      ) {
        await this.finishSuperseded(job.artifact_id, leaseOwner);
        return null;
      }
      if (context.clone_status !== "NORMAL") {
        await this.db.query(
          `update control_plane.licensing_license_artifacts
              set status = 'PENDING', lease_owner = null, lease_expires_at = null,
                  last_failure_code = 'INSTALLATION_CONFLICT',
                  next_attempt_at = now() + interval '15 minutes'
            where artifact_id = $1 and lease_owner = $2;`,
          [job.artifact_id, leaseOwner],
        );
        return null;
      }

      const activeKey = await this.signerProvider.getSigningKey(requestedKeyId ?? undefined);
      if (context.signing_key_id !== activeKey.keyId) {
        await this.db.query(
          `update control_plane.licensing_license_artifacts
              set status = 'PENDING', lease_owner = null, lease_expires_at = null,
                  last_failure_code = 'SIGNING_KEY_CHANGED', next_attempt_at = now()
            where artifact_id = $1 and lease_owner = $2;`,
          [job.artifact_id, leaseOwner],
        );
        await this.db.query(
          `update control_plane.licensing_licenses
              set signing_key_id = $2, issued_at = $3, updated_at = $3
            where id = $1 and signing_key_id <> $2;`,
          [context.license_id, activeKey.keyId, this.now().toISOString()],
        );
        return null;
      }

      const payload = buildPayload(context);
      const issuer = new LicenseIssuer(this.signerProvider, this.trustedPublicKeys);
      const signed = await issuer.signPayload(payload, activeKey.keyId);
      issuer.verifyIssuedLicense(signed, context.installation_id);
      const payloadHash = createHash("sha256").update(canonicalizeToBuffer(payload)).digest("hex");
      const artifactHash = createHash("sha256").update(canonicalizeToBuffer(signed)).digest("hex");
      const signedAt = this.now().toISOString();

      const stored = await this.db.query<{ artifact_id: string; license_id: string }>(
        `with stored as (
           update control_plane.licensing_license_artifacts a
              set status = 'ISSUED', key_id = $3, issued_at = $4, expires_at = $5,
                  payload_sha256 = $6, artifact_sha256 = $7, signed_document = $8::jsonb,
                  signed_at = $4, lease_owner = null, lease_expires_at = null,
                  last_failure_code = null
            where a.artifact_id = $1 and a.lease_owner = $2 and a.status = 'PROCESSING'
              and exists (
                select 1 from control_plane.licensing_licenses l
                 where l.id = a.license_id and l.license_revision = a.license_revision
                   and l.status = 'ACTIVE'
                   and exists (
                     select 1
                       from control_plane.licensing_installations i
                       join control_plane.licensing_customers c on c.id = l.customer_id
                      where i.id = a.installation_id and i.license_id = l.id
                        and i.status = 'ACTIVE' and i.clone_status = 'NORMAL'
                        and c.status = 'ACTIVE'
                   )
              )
            returning a.artifact_id, a.license_id, a.installation_id,
                      a.license_revision, a.source, a.key_id, a.payload_sha256,
                      a.artifact_sha256
         ), license_event as (
           insert into control_plane.licensing_events
             (license_id, installation_id, event_type, payload, actor, actor_type, created_at)
           select license_id, installation_id, 'LICENSE_ARTIFACT_SIGNED',
                  jsonb_build_object(
                    'license_revision', license_revision,
                    'key_id', key_id,
                    'payload_sha256', payload_sha256,
                    'artifact_sha256', artifact_sha256,
                    'source', source
                  ), 'billing-artifact-issuer', 'SYSTEM', $4
             from stored
          returning id
         )
         select artifact_id, license_id from stored where exists (select 1 from license_event);`,
        [
          job.artifact_id,
          leaseOwner,
          signed.key_id,
          signedAt,
          payload.expires_at,
          payloadHash,
          artifactHash,
          JSON.stringify(signed),
        ],
      );
      if (!stored.rows[0]) return null;
      return signed;
    } catch {
      const retryDelaySeconds = 15;
      await this.db.query(
        `update control_plane.licensing_license_artifacts
            set status = 'PENDING', lease_owner = null, lease_expires_at = null,
                last_failure_code = 'SIGNING_OR_PERSISTENCE_FAILED',
                next_attempt_at = now() + make_interval(secs => $3)
          where artifact_id = $1 and lease_owner = $2;`,
        [artifactId, leaseOwner, retryDelaySeconds],
      );
      throw new LicenseArtifactPendingError();
    }
  }

  private async finishSuperseded(artifactId: string, leaseOwner: string): Promise<void> {
    await this.db.query(
      `update control_plane.licensing_license_artifacts
          set status = 'SUPERSEDED', lease_owner = null, lease_expires_at = null,
              last_failure_code = 'LICENSE_REVISION_ADVANCED'
        where artifact_id = $1 and lease_owner = $2;`,
      [artifactId, leaseOwner],
    );
  }

  private async loadContext(
    licenseId: string,
    installationId: string,
  ): Promise<LicenseArtifactContext | null> {
    const result = await this.db.query<LicenseArtifactContext>(
      `select l.id as license_id, l.serial, l.customer_id, c.name as customer_name,
              c.billing_email as customer_email, c.country as customer_country, c.status as customer_status,
              l.status as license_status, i.id as installation_id, i.status as installation_status,
              i.clone_status,
              l.product, l.deployment, l.plan, l.license_type, l.signing_key_id, l.license_revision,
              l.max_installations, l.max_tenants, l.resale_allowed, l.white_label, l.features,
              l.issued_at, l.valid_from, l.expires_at, l.maintenance_until, l.grace_days
         from control_plane.licensing_licenses l
         join control_plane.licensing_customers c on c.id = l.customer_id
         join control_plane.licensing_installations i on i.license_id = l.id
        where l.id = $1::uuid and i.id = $2;`,
      [licenseId, installationId],
    );
    return result.rows[0] ?? null;
  }

  private async getArtifact(
    licenseId: string,
    installationId: string,
    revision: number,
  ): Promise<ArtifactJob | null> {
    const result = await this.db.query<ArtifactJob>(
      `select artifact_id, license_id, installation_id, license_revision, source, status, signed_document
         from control_plane.licensing_license_artifacts
        where license_id = $1::uuid and installation_id = $2 and license_revision = $3;`,
      [licenseId, installationId, revision],
    );
    return result.rows[0] ?? null;
  }

  private async waitForConcurrentArtifact(
    artifactId: string,
  ): Promise<SignedLicenseDocument | null> {
    for (let attempt = 0; attempt < 40; attempt += 1) {
      const latest = await this.db.query<ArtifactJob & { lease_available: boolean }>(
        `select artifact_id, license_id, installation_id, license_revision, source, status,
                signed_document, coalesce(lease_expires_at <= now(), true) as lease_available
           from control_plane.licensing_license_artifacts where artifact_id = $1;`,
        [artifactId],
      );
      const artifact = latest.rows[0];
      if (artifact?.status === "ISSUED") return parseStoredDocument(artifact.signed_document);
      if (!artifact || artifact.status === "SUPERSEDED") return null;
      if (artifact.status === "PENDING" || artifact.lease_available) {
        try {
          const claimed = await this.issueArtifact(artifactId);
          if (claimed) return claimed;
        } catch (error) {
          if (!(error instanceof LicenseArtifactPendingError)) throw error;
        }
      } else if (artifact.status !== "PROCESSING") {
        return null;
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    return null;
  }
}

function buildPayload(row: LicenseArtifactContext): LicensePayload {
  return {
    license_version: 1,
    license_revision: Number(row.license_revision),
    license_id: row.license_id,
    serial: row.serial,
    product: row.product,
    deployment: row.deployment,
    plan: row.plan,
    status: "ACTIVE",
    customer: {
      id: row.customer_id,
      name: row.customer_name,
      email: row.customer_email || undefined,
      country: row.customer_country || undefined,
    },
    license_type: row.license_type,
    installation_id: row.installation_id,
    entitlements: {
      max_installations: row.max_installations,
      max_tenants: row.max_tenants,
      resale_allowed: row.resale_allowed,
      white_label: row.white_label,
      features: row.features,
    },
    grace_period_days: row.grace_days,
    issued_at: row.issued_at ? new Date(row.issued_at).toISOString() : new Date().toISOString(),
    valid_from: new Date(row.valid_from).toISOString(),
    expires_at: new Date(row.expires_at).toISOString(),
    maintenance_until: row.maintenance_until
      ? new Date(row.maintenance_until).toISOString()
      : undefined,
  };
}

function parseStoredDocument(value: unknown): SignedLicenseDocument {
  const parsed = SignedLicenseDocumentSchema.safeParse(value);
  if (!parsed.success) throw new LicenseArtifactPendingError();
  return parsed.data as SignedLicenseDocument;
}
