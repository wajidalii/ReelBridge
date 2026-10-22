/** Shared class strings so every page's controls look the same. */
export const inputClasses =
  'block w-full rounded-lg border border-slate-300 px-3 py-2 text-sm text-slate-900 shadow-sm ' +
  'placeholder:text-slate-400 focus:border-brand-500 focus:outline-none focus:ring-2 focus:ring-brand-500/30';

export const selectClasses =
  'block rounded-lg border border-slate-300 px-3 py-1.5 text-sm text-slate-900 shadow-sm ' +
  'focus:border-brand-500 focus:outline-none focus:ring-2 focus:ring-brand-500/30';

export const primaryButtonClasses =
  'inline-flex items-center rounded-lg bg-brand-600 px-4 py-2 text-sm font-semibold text-white ' +
  'shadow-sm transition hover:bg-brand-700 disabled:cursor-not-allowed disabled:opacity-50';

export const secondaryButtonClasses =
  'inline-flex items-center rounded-lg border border-slate-300 bg-white px-3 py-1.5 text-sm ' +
  'font-medium text-slate-700 shadow-sm transition hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-50';

export const dangerButtonClasses =
  'inline-flex items-center rounded-lg bg-red-600 px-3 py-1.5 text-sm font-semibold text-white ' +
  'shadow-sm transition hover:bg-red-700 disabled:cursor-not-allowed disabled:opacity-50';

export const cardClasses = 'rounded-xl border border-slate-200 bg-white p-6 shadow-sm';

export const PLATFORM_LABELS: Record<string, string> = {
  facebook_page: 'Facebook',
  instagram_business: 'Instagram',
  youtube_channel: 'YouTube',
};

export function relativeTime(iso: string | null | undefined): string {
  if (!iso) return 'Never';
  const diffMs = Date.now() - new Date(iso).getTime();
  const minutes = Math.round(diffMs / 60_000);
  if (Math.abs(minutes) < 1) return 'just now';
  if (Math.abs(minutes) < 60) return `${minutes} minute${minutes === 1 ? '' : 's'} ago`;
  const hours = Math.round(minutes / 60);
  if (Math.abs(hours) < 24) return `${hours} hour${hours === 1 ? '' : 's'} ago`;
  const days = Math.round(hours / 24);
  return `${days} day${days === 1 ? '' : 's'} ago`;
}

export function errorMessage(error: unknown, fallback: string): string {
  return error instanceof Error ? error.message : fallback;
}
