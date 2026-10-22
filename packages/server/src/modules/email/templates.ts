import { getEmailProvider } from './provider.js';

function clientOrigin(): string {
  return (process.env.CLIENT_ORIGIN ?? 'http://localhost:5173').split(',')[0]!.replace(/\/+$/, '');
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

export async function sendVerificationEmail(to: string, rawToken: string): Promise<void> {
  const url = `${clientOrigin()}/verify-email?token=${encodeURIComponent(rawToken)}`;
  await getEmailProvider().send({
    to,
    subject: 'Verify your ReelBridge email',
    text: `Welcome to ReelBridge.\n\nConfirm your email address by opening this link:\n${url}\n\nThe link expires in 24 hours. If you didn't create an account, you can ignore this email.`,
    html: `<p>Welcome to ReelBridge.</p><p>Confirm your email address by opening this link:</p><p><a href="${escapeHtml(url)}">${escapeHtml(url)}</a></p><p>The link expires in 24 hours. If you didn't create an account, you can ignore this email.</p>`,
  });
}

export async function sendPasswordResetEmail(to: string, rawToken: string): Promise<void> {
  const url = `${clientOrigin()}/reset-password?token=${encodeURIComponent(rawToken)}`;
  await getEmailProvider().send({
    to,
    subject: 'Reset your ReelBridge password',
    text: `Someone requested a password reset for this ReelBridge account.\n\nSet a new password here:\n${url}\n\nThe link expires in 1 hour and can only be used once. If you didn't request this, you can ignore this email — your password won't change.`,
    html: `<p>Someone requested a password reset for this ReelBridge account.</p><p>Set a new password here:</p><p><a href="${escapeHtml(url)}">${escapeHtml(url)}</a></p><p>The link expires in 1 hour and can only be used once. If you didn't request this, you can ignore this email — your password won't change.</p>`,
  });
}
