// ===========================================================================
// The MFA policy (M4.5 Wave 1, T-B5): which roles may NEVER act without a second factor.
// One definition, read by the auth plugin, the token service and the MFA service — and
// mirrored by the database's `session_mfa_guard`, which refuses a session for these roles
// that was not opened with a proven second factor.
// ===========================================================================

import type { UserRole } from "../generated/platform/enums";

export const MFA_REQUIRED_ROLES: readonly UserRole[] = ["SUPER_ADMIN", "PROGRAM_OFFICER"];

export function mfaRequiredFor(role: UserRole): boolean {
  return MFA_REQUIRED_ROLES.includes(role);
}
