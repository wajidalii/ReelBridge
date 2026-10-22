import { useState } from 'react';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import { useLogin } from '../../api/auth.js';
import { errorMessage, inputClasses, primaryButtonClasses } from '../../components/ui.js';
import { AuthLayout } from './AuthLayout.js';

export function Login() {
  const navigate = useNavigate();
  const location = useLocation();
  const from = (location.state as { from?: string } | null)?.from ?? '/';
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const login = useLogin();

  function handleSubmit(event: React.FormEvent) {
    event.preventDefault();
    login.mutate({ email, password }, { onSuccess: () => navigate(from, { replace: true }) });
  }

  return (
    <AuthLayout title="Log in" subtitle="Welcome back.">
      <form onSubmit={handleSubmit} className="space-y-4" noValidate>
        <div>
          <label htmlFor="login-email" className="block text-sm font-medium text-slate-700">
            Email
          </label>
          <input
            id="login-email"
            type="email"
            autoComplete="email"
            required
            className={`mt-1 ${inputClasses}`}
            value={email}
            onChange={(event) => setEmail(event.target.value)}
            aria-describedby={login.isError ? 'login-error' : undefined}
          />
        </div>
        <div>
          <label htmlFor="login-password" className="block text-sm font-medium text-slate-700">
            Password
          </label>
          <input
            id="login-password"
            type="password"
            autoComplete="current-password"
            required
            className={`mt-1 ${inputClasses}`}
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            aria-describedby={login.isError ? 'login-error' : undefined}
          />
        </div>
        {login.isError && (
          <p id="login-error" role="alert" className="text-sm font-medium text-red-600">
            {errorMessage(login.error, 'Login failed.')}
          </p>
        )}
        <button type="submit" className={primaryButtonClasses} disabled={login.isPending}>
          {login.isPending ? 'Logging in…' : 'Log in'}
        </button>
      </form>
      <div className="mt-4 flex flex-wrap gap-4 text-sm">
        <Link to="/forgot-password" className="font-medium text-brand-600 hover:underline">
          Forgot your password?
        </Link>
        <Link to="/signup" className="font-medium text-brand-600 hover:underline">
          Create an account
        </Link>
      </div>
    </AuthLayout>
  );
}
