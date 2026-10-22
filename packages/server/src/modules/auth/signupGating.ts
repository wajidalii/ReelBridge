/**
 * Early-access gating (issue #40). Until Meta App Review / the YouTube
 * compliance audit clear, only trusted testers should be able to sign up.
 * Config, not code: flip SIGNUP_MODE to `open` to remove the gate with no
 * deploy. In `invite` mode a signup must either carry a valid invite code
 * (SIGNUP_INVITE_CODES, comma-separated) or use an email under an allowlisted
 * domain (SIGNUP_ALLOWED_EMAIL_DOMAINS, comma-separated).
 */
export type SignupMode = 'open' | 'invite';

export function signupMode(): SignupMode {
  return process.env.SIGNUP_MODE === 'invite' ? 'invite' : 'open';
}

function csv(name: string): string[] {
  return (process.env[name] ?? '')
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean);
}

export function isSignupAllowed(email: string, inviteCode: string | undefined): boolean {
  if (signupMode() === 'open') return true;
  const domain = email.split('@')[1]?.toLowerCase();
  if (domain && csv('SIGNUP_ALLOWED_EMAIL_DOMAINS').some((d) => d.toLowerCase() === domain)) {
    return true;
  }
  if (inviteCode && csv('SIGNUP_INVITE_CODES').includes(inviteCode.trim())) {
    return true;
  }
  return false;
}
