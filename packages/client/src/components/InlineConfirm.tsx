import { useState } from 'react';
import { dangerButtonClasses, secondaryButtonClasses } from './ui.js';

interface InlineConfirmProps {
  label: string;
  confirmLabel: string;
  description?: string;
  pending?: boolean;
  onConfirm: () => void;
}

/**
 * Two-step destructive action without window.confirm (which blocks the
 * event loop and is invisible to assistive tech in some setups): first click
 * reveals a confirm/cancel pair, second click fires.
 */
export function InlineConfirm({
  label,
  confirmLabel,
  description,
  pending,
  onConfirm,
}: InlineConfirmProps) {
  const [open, setOpen] = useState(false);

  if (!open) {
    return (
      <button type="button" className={secondaryButtonClasses} onClick={() => setOpen(true)}>
        {label}
      </button>
    );
  }
  return (
    <span className="inline-flex flex-wrap items-center gap-2" role="group" aria-label={label}>
      {description && <span className="text-xs text-slate-600">{description}</span>}
      <button
        type="button"
        className={dangerButtonClasses}
        disabled={pending}
        onClick={() => {
          onConfirm();
          setOpen(false);
        }}
      >
        {pending ? 'Working…' : confirmLabel}
      </button>
      <button type="button" className={secondaryButtonClasses} onClick={() => setOpen(false)}>
        Cancel
      </button>
    </span>
  );
}
