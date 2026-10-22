import { useState } from 'react';
import { Link } from 'react-router-dom';
import { forgotPassword } from '../../api/auth.js';
import { errorMessage, inputClasses, primaryButtonClasses } from '../../components/ui.js';
import { AuthLayout } from './AuthLayout.js';

export function ForgotPassword() {
  const [email, setEmail] = useState('');
  const [state, setState] = useState<{
    kind: 'idle' | 'sending' | 'sent' | 'error';
    message?: string;
  }>({ kind: 'idle' });

  async function handleSubmit(event: React.FormEvent) {
    event.preventDefault();
    setState({ kind: 'sending' });
    try {
      const result = await forgotPassword(email);
      setState({ kind: 'sent', message: result.message });
    } catch (error) {
      setState({ kind: 'error', message: errorMessage(error, 'Request failed.') });
    }
  }

  return (
    <AuthLayout
      title="Reset your password"
      subtitle="Enter your email and we'll send you a link to set a new password."
    >
      <form onSubmit={handleSubmit} className="space-y-4" noValidate>
        <div>
          <label htmlFor="forgot-email" className="block text-sm font-medium text-slate-700">
            Email
          </label>
          <input
            id="forgot-email"
            type="email"
            autoComplete="email"
            required
            className={`mt-1 ${inputClasses}`}
            value={email}
            onChange={(event) => setEmail(event.target.value)}
          />
        </div>
        <p
          role={state.kind === 'error' ? 'alert' : 'status'}
          aria-live="polite"
          className={`text-sm font-medium ${state.kind === 'error' ? 'text-red-600' : 'text-emerald-700'}`}
        >
          {state.kind === 'sent' || state.kind === 'error' ? state.message : ''}
        </p>
        <button type="submit" className={primaryButtonClasses} disabled={state.kind === 'sending'}>
          {state.kind === 'sending' ? 'Sending…' : 'Send reset link'}
        </button>
      </form>
      <p className="mt-4 text-sm">
        <Link to="/login" className="font-medium text-brand-600 hover:underline">
          Back to log in
        </Link>
      </p>
    </AuthLayout>
  );
}
