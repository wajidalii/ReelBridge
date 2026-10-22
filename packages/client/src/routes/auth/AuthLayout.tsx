import { cardClasses } from '../../components/ui.js';

export function AuthLayout({
  title,
  subtitle,
  children,
}: {
  title: string;
  subtitle?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="mx-auto max-w-md">
      <h1 className="text-2xl font-bold tracking-tight text-slate-900">{title}</h1>
      {subtitle && <p className="mt-2 text-sm text-slate-600">{subtitle}</p>}
      <div className={`mt-6 ${cardClasses}`}>{children}</div>
    </div>
  );
}
