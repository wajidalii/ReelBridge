import { useState } from 'react';
import { Link, NavLink, useLocation, useNavigate } from 'react-router-dom';
import { resendVerification, useLogout, useMe } from '../api/auth.js';
import { errorMessage, secondaryButtonClasses } from './ui.js';

const AUTH_PATHS = ['/login', '/signup', '/forgot-password', '/reset-password', '/verify-email'];

const navLinkClasses = ({ isActive }: { isActive: boolean }) =>
  `text-sm font-medium ${isActive ? 'text-slate-900' : 'text-slate-600 hover:text-slate-900'}`;

function VerifyEmailBanner() {
  const [dismissed, setDismissed] = useState(false);
  const [state, setState] = useState<{
    kind: 'idle' | 'sending' | 'sent' | 'error';
    message?: string;
  }>({ kind: 'idle' });
  if (dismissed) return null;

  async function resend() {
    setState({ kind: 'sending' });
    try {
      const result = await resendVerification();
      setState({
        kind: 'sent',
        message: result.alreadyVerified
          ? 'Your email is already verified — reload to clear this notice.'
          : 'Verification email sent. Check your inbox.',
      });
    } catch (error) {
      setState({ kind: 'error', message: errorMessage(error, 'Could not resend the email.') });
    }
  }

  return (
    <div className="border-b border-amber-200 bg-amber-50">
      <div className="mx-auto flex max-w-4xl flex-wrap items-center gap-3 px-6 py-2 text-sm text-amber-900">
        <span className="font-medium">Verify your email</span>
        <span className="text-amber-800">
          We sent a confirmation link to your address. Didn&apos;t get it?
        </span>
        <button
          type="button"
          className={secondaryButtonClasses}
          onClick={() => void resend()}
          disabled={state.kind === 'sending'}
        >
          {state.kind === 'sending' ? 'Sending…' : 'Resend'}
        </button>
        <span role="status" aria-live="polite" className="text-xs">
          {state.kind === 'sent' || state.kind === 'error' ? state.message : ''}
        </span>
        <button
          type="button"
          className="ml-auto text-xs font-medium text-amber-900 underline"
          onClick={() => setDismissed(true)}
        >
          Dismiss
        </button>
      </div>
    </div>
  );
}

export function AppShell({ children }: { children: React.ReactNode }) {
  const location = useLocation();
  const navigate = useNavigate();
  const { data: user } = useMe();
  const logout = useLogout();
  const isAuthPage = AUTH_PATHS.some((path) => location.pathname.startsWith(path));

  return (
    <div className="min-h-screen bg-slate-50">
      <header className="border-b border-slate-200 bg-white">
        <div className="mx-auto flex max-w-4xl flex-wrap items-center justify-between gap-4 px-6 py-4">
          <Link to="/" className="text-lg font-semibold tracking-tight text-slate-900">
            Reel<span className="text-brand-600">Bridge</span>
          </Link>
          {!isAuthPage && user && (
            <nav aria-label="Main" className="flex flex-wrap items-center gap-4">
              <NavLink to="/" end className={navLinkClasses}>
                Home
              </NavLink>
              <NavLink to="/posts" className={navLinkClasses}>
                Dashboard
              </NavLink>
              <NavLink to="/batches" className={navLinkClasses}>
                Batches
              </NavLink>
              <NavLink to="/upload" className={navLinkClasses}>
                New batch
              </NavLink>
              <NavLink to="/settings" className={navLinkClasses}>
                Settings
              </NavLink>
              <span className="hidden text-xs text-slate-500 sm:inline" title={user.email}>
                {user.email}
              </span>
              <button
                type="button"
                className={secondaryButtonClasses}
                disabled={logout.isPending}
                onClick={() =>
                  logout.mutate(undefined, {
                    onSettled: () => navigate('/login', { replace: true }),
                  })
                }
              >
                Log out
              </button>
            </nav>
          )}
        </div>
      </header>
      {!isAuthPage && user && !user.emailVerified && <VerifyEmailBanner />}
      <main className="mx-auto max-w-4xl px-6 py-10">{children}</main>
    </div>
  );
}
