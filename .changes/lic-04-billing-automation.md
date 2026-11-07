---
impacto: capacidade_nova
secao: adicionado
titulo: Automatize o ciclo de cobrança do Control Plane do fornecedor
---

**LIC-04 — Billing Vendor.**

- Added Control Plane migration `0005_billing_automation.sql` for subscriptions, invoices, payments, event audit, internal notifications, webhook receipts, settings and reconciliation findings.
- Added MANUAL billing with idempotent subscription/invoice creation, explicit payment confirmation, transactional license renewal and reissue audit, nonpayment grace/policy, cancellation, refund recording, internal due alerts, scheduled invoice creation and reconciliation.
- Added guarded Vendor billing APIs and `/admin/billing` dashboard, invoice list/detail, manual billing flow and settings. Customer and license pages show Vendor-only billing summaries.
- Added migration `0006_signed_license_artifact_versions.sql`: renewals enqueue one durable, idempotent artifact revision per active installation in the payment transaction. The private Vendor issuer signs immediately after confirmation and persists the signed document, payload/artifact hashes, revision and signing event atomically. Failures remain retryable; the next LIC-01 online validation returns the stored signed revision, which LIC-01 verifies and installs with its atomic replace.
- Added a Vendor-only scheduler process (`pnpm control-plane:billing-scheduler`) with a 15-minute default interval, one-cycle-at-a-time execution and a PostgreSQL session advisory lock. The scheduler runs maintenance, reconciliation and pending artifact issuance. Configure this long-running command only in the private Control Plane deployment.
- Billing provider availability is explicitly `MANUAL` only. Stripe and Mercado Pago stay fail-closed even if secrets or provider metadata are present. The normalized webhook framework is retained but disabled until LIC-05 supplies and validates native provider adapters.
- Added no-charge renewal auditing and disallowed it when a billing subscription remains active.
- Added scheduler repeat/lock tests and disposable PostgreSQL end-to-end coverage for MANUAL payment, renewal, signed revision delivery, LIC-01 verification/atomic file install, retry idempotency, nonpayment policies and recovery after suspension. No migration was applied to self-hosted `deskcomm-crm`.
- Visual QA status and final gates are recorded in `docs/specs/licenciamento-cobranca-vendor.md` after the isolated Vendor QA run.
