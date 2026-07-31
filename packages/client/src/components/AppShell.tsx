import { Link } from 'react-router-dom';

export function AppShell({ children }: { children: React.ReactNode }) {
  return (
    <div className="min-h-screen bg-slate-50">
      <header className="border-b border-slate-200 bg-white">
        <div className="mx-auto flex max-w-4xl items-center justify-between px-6 py-4">
          <Link to="/" className="text-lg font-semibold tracking-tight text-slate-900">
            Reel<span className="text-brand-600">Bridge</span>
          </Link>
          <Link to="/upload" className="text-sm font-medium text-slate-600 hover:text-slate-900">
            New batch
          </Link>
        </div>
      </header>
      <main className="mx-auto max-w-4xl px-6 py-10">{children}</main>
    </div>
  );
}
