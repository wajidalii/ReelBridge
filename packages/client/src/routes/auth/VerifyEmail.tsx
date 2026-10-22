import { useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { ME_QUERY_KEY, verifyEmail } from '../../api/auth.js';
import { errorMessage } from '../../components/ui.js';
import { AuthLayout } from './AuthLayout.js';

export function VerifyEmail() {
  const [searchParams] = useSearchParams();
  const token = searchParams.get('token');
  const queryClient = useQueryClient();
  const [state, setState] = useState<{ kind: 'verifying' | 'done' | 'error'; message?: string }>({
    kind: 'verifying',
  });

  useEffect(() => {
    let cancelled = false;
    if (!token) {
      setState({ kind: 'error', message: 'This verification link is missing its token.' });
      return;
    }
    verifyEmail(token)
      .then(() => {
        if (cancelled) return;
        setState({ kind: 'done' });
        void queryClient.invalidateQueries({ queryKey: ME_QUERY_KEY });
      })
      .catch((error: unknown) => {
        if (cancelled) return;
        setState({ kind: 'error', message: errorMessage(error, 'Verification failed.') });
      });
    return () => {
      cancelled = true;
    };
  }, [token, queryClient]);

  return (
    <AuthLayout title="Email verification">
      {state.kind === 'verifying' && (
        <p role="status" aria-live="polite" className="text-sm text-slate-600">
          Verifying your email…
        </p>
      )}
      {state.kind === 'done' && (
        <p role="status" aria-live="polite" className="text-sm font-medium text-emerald-700">
          Your email is verified.{' '}
          <Link to="/" className="font-medium text-brand-600 hover:underline">
            Continue to ReelBridge
          </Link>
          .
        </p>
      )}
      {state.kind === 'error' && (
        <p role="alert" className="text-sm font-medium text-red-600">
          {state.message} You can request a new link from the banner once you&apos;re{' '}
          <Link to="/login" className="underline">
            logged in
          </Link>
          .
        </p>
      )}
    </AuthLayout>
  );
}
