/**
 * Shared shape for the optional vendor support context attached to an auth user.
 * Keep this contract free of persistence code so customer auth can build without
 * importing vendor support tables or RPCs.
 */
export interface SupportContext {
  id: string;
  organization_id: string;
  actor_user_id: string;
  auth_session_id: string;
  previous_organization_id: string | null;
  expires_at: string;
  name: string;
  locale: string | null;
  access_mode: "full" | "support_readonly";
  status: "active" | "expired" | "revoked";
}
