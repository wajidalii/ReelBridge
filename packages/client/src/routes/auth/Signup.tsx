import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useSignup, useSignupPolicy } from '../../api/auth.js';
import { errorMessage, inputClasses, primaryButtonClasses } from '../../components/ui.js';
import { AuthLayout } from './AuthLayout.js';

export function Signup() {
  const navigate = useNavigate();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [inviteCode, setInviteCode] = useState('');
  const { data: policy } = useSignupPolicy();
  const signup = useSignup();
  const inviteRequired = policy?.mode === 'invite';
  const passwordTooShort = password.length > 0 && password.length < 8;

  function handleSubmit(event: React.FormEvent) {
    event.preventDefault();
    if (passwordTooShort) return;
    signup.mutate(
      { email, password, ...(inviteRequired && inviteCode ? { invite_code: inviteCode } : {}) },
      { onSuccess: () => navigate('/', { replace: true }) },
    );
  }

  return (
    <AuthLayout
      title="Create your account"
      subtitle={
        inviteRequired
          ? 'ReelBridge is currently invite-only while we complete platform reviews.'
          : 'Bridge your Reels to every platform.'
      }
    >
      <form onSubmit={handleSubmit} className="space-y-4" noValidate>
        <div>
          <label htmlFor="signup-email" className="block text-sm font-medium text-slate-700">
            Email
          </label>
          <input
            id="signup-email"
            type="email"
            autoComplete="email"
            required
            className={`mt-1 ${inputClasses}`}
            value={email}
            onChange={(event) => setEmail(event.target.value)}
          />
        </div>
        <div>
          <label htmlFor="signup-password" className="block text-sm font-medium text-slate-700">
            Password
          </label>
          <input
            id="signup-password"
            type="password"
            autoComplete="new-password"
            required
            minLength={8}
            maxLength={64}
            className={`mt-1 ${inputClasses}`}
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            aria-describedby="signup-password-hint"
            aria-invalid={passwordTooShort || undefined}
          />
          <p id="signup-password-hint" className="mt-1 text-xs text-slate-500">
            8–64 characters.{passwordTooShort ? ' Your password is too short.' : ''}
          </p>
        </div>
        {inviteRequired && (
          <div>
            <label htmlFor="signup-invite" className="block text-sm font-medium text-slate-700">
              Invite code
            </label>
            <input
              id="signup-invite"
              type="text"
              autoComplete="off"
              className={`mt-1 ${inputClasses}`}
              value={inviteCode}
              onChange={(event) => setInviteCode(event.target.value)}
              aria-describedby="signup-invite-hint"
            />
            <p id="signup-invite-hint" className="mt-1 text-xs text-slate-500">
              Leave blank if your email domain has been pre-approved.
            </p>
          </div>
        )}
        {signup.isError && (
          <p role="alert" className="text-sm font-medium text-red-600">
            {errorMessage(signup.error, 'Signup failed.')}
          </p>
        )}
        <button type="submit" className={primaryButtonClasses} disabled={signup.isPending}>
          {signup.isPending ? 'Creating account…' : 'Create account'}
        </button>
      </form>
      <p className="mt-4 text-sm text-slate-600">
        Already have an account?{' '}
        <Link to="/login" className="font-medium text-brand-600 hover:underline">
          Log in
        </Link>
      </p>
    </AuthLayout>
  );
}
