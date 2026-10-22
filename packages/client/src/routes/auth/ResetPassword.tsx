import { useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { resetPassword } from '../../api/auth.js';
import { errorMessage, inputClasses, primaryButtonClasses } from '../../components/ui.js';
import { AuthLayout } from './AuthLayout.js';

export function ResetPassword() {
  const [searchParams] = useSearchParams();
  const token = searchParams.get('token') ?? '';
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [state, setState] = useState<{
    kind: 'idle' | 'saving' | 'done' | 'error';
    message?: string;
  }>({ kind: 'idle' });
  const mismatch = confirm.length > 0 && confirm !== password;

  async function handleSubmit(event: React.FormEvent) {
    event.preventDefault();
    if (mismatch || password.length < 8) return;
    setState({ kind: 'saving' });
    try {
      await resetPassword(token, password);
      setState({ kind: 'done' });
    } catch (error) {
      setState({ kind: 'error', message: errorMessage(error, 'Reset failed.') });
    }
  }

  if (!token) {
    return (
      <AuthLayout title="Reset your password">
        <p role="alert" className="text-sm font-medium text-red-600">
          This reset link is missing its token. Request a new one from the{' '}
          <Link to="/forgot-password" className="underline">
            forgot password
          </Link>{' '}
          page.
        </p>
      </AuthLayout>
    );
  }

  if (state.kind === 'done') {
    return (
      <AuthLayout title="Password updated">
        <p role="status" className="text-sm text-slate-700">
          Your password has been changed and all other sessions were signed out.{' '}
          <Link to="/login" className="font-medium text-brand-600 hover:underline">
            Log in with your new password
          </Link>
          .
        </p>
      </AuthLayout>
    );
  }

  return (
    <AuthLayout title="Choose a new password">
      <form onSubmit={handleSubmit} className="space-y-4" noValidate>
        <div>
          <label htmlFor="reset-password" className="block text-sm font-medium text-slate-700">
            New password
          </label>
          <input
            id="reset-password"
            type="password"
            autoComplete="new-password"
            required
            minLength={8}
            maxLength={64}
            className={`mt-1 ${inputClasses}`}
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            aria-describedby="reset-password-hint"
          />
          <p id="reset-password-hint" className="mt-1 text-xs text-slate-500">
            8–64 characters.
          </p>
        </div>
        <div>
          <label htmlFor="reset-confirm" className="block text-sm font-medium text-slate-700">
            Confirm new password
          </label>
          <input
            id="reset-confirm"
            type="password"
            autoComplete="new-password"
            required
            className={`mt-1 ${inputClasses}`}
            value={confirm}
            onChange={(event) => setConfirm(event.target.value)}
            aria-invalid={mismatch || undefined}
            aria-describedby={mismatch ? 'reset-confirm-error' : undefined}
          />
          {mismatch && (
            <p id="reset-confirm-error" className="mt-1 text-xs font-medium text-red-600">
              Passwords don&apos;t match.
            </p>
          )}
        </div>
        {state.kind === 'error' && (
          <p role="alert" className="text-sm font-medium text-red-600">
            {state.message}
          </p>
        )}
        <button
          type="submit"
          className={primaryButtonClasses}
          disabled={state.kind === 'saving' || mismatch || password.length < 8}
        >
          {state.kind === 'saving' ? 'Saving…' : 'Set new password'}
        </button>
      </form>
    </AuthLayout>
  );
}
