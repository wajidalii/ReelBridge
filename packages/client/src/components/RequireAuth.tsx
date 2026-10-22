import { Navigate, Outlet, useLocation } from 'react-router-dom';
import { useMe } from '../api/auth.js';

export function RequireAuth() {
  const { data: user, isLoading } = useMe();
  const location = useLocation();

  if (isLoading) {
    return (
      <p role="status" aria-live="polite" className="text-sm text-slate-500">
        Loading your account…
      </p>
    );
  }
  if (!user) {
    return <Navigate to="/login" replace state={{ from: location.pathname + location.search }} />;
  }
  return <Outlet />;
}
