import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { LicenseAdminClient } from "@/app/admin/license/_client";
import type { LicenseAdminSummary } from "@/lib/licensing/admin-view";

const license: LicenseAdminSummary = {
  status: "ACTIVE",
  usable: true,
  restricted_mode_active: false,
  serial_masked: "CLX-••••-••••-WXYZ",
  plan: "pro",
  expires_at: "2026-12-05T00:00:00Z",
  days_remaining: 30,
  grace_until: "2026-12-12T00:00:00Z",
  grace_period_days: 7,
  installation_id_masked: "inst_aaaa…eeee",
  last_validated_at: "2026-11-05T12:00:00Z",
  license_server_status: "ACTIVE",
  clone_status: null,
  last_successful_online_validation: "2026-11-05T12:00:00Z",
  next_online_validation_at: "2026-11-06T12:00:00Z",
  offline_validation_tolerance_days: 7,
  enforcement_mode: "enforce",
  clock_rollback_suspected: false,
  clock_baseline_available: true,
  error_code: null,
};

describe("license installation admin screen", () => {
  it("shows commercial status and masked metadata with validation/update actions", () => {
    render(<LicenseAdminClient initialLicense={license} />);

    expect(screen.getByRole("heading", { name: "Licença da instalação" })).toBeInTheDocument();
    expect(screen.getByText("Status: Ativa")).toBeInTheDocument();
    expect(screen.getByText("A licença vence em 30 dias.")).toBeInTheDocument();
    expect(screen.getByText("Profissional")).toBeInTheDocument();
    expect(screen.getByText("CLX-••••-••••-WXYZ")).toBeInTheDocument();
    expect(screen.getByText("inst_aaaa…eeee")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Validar agora" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "Atualizar licença" })).toBeEnabled();
    expect(screen.getByLabelText("Selecionar arquivo de licença assinado")).toBeInTheDocument();
    expect(screen.queryByText("CLX-2026-ABCD-WXYZ")).not.toBeInTheDocument();
  });
});
