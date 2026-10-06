import { useEffect, useRef, useState } from 'react';
import { Check, ChevronDown } from './icons';

/**
 * A compact pill dropdown that matches the app's dark UI.
 *
 * Native `<select>` popups are drawn by the operating system and cannot be
 * themed, so small option lists (like Image Studio's size overrides) use this
 * instead. The menu opens upward — these controls live in the docked composer
 * — and closes on pick, outside click, or Escape.
 */
export function PillSelect({
  label,
  value,
  options,
  onChange,
  menuClassName = 'w-44',
  direction = 'up',
}: {
  label: string;
  value: string;
  options: { value: string; label: string }[];
  onChange: (value: string) => void;
  /** Tailwind width/positioning classes for the opened menu. */
  menuClassName?: string;
  /**
   * Which way the menu opens. Controls docked at the bottom of the screen
   * (the composer) open upward; controls in a header row must open downward
   * or the menu floats over the top bar.
   */
  direction?: 'up' | 'down';
}) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const current = options.find((option) => option.value === value);

  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open]);

  return (
    <div className="relative" ref={rootRef}>
      <button
        type="button"
        aria-label={label}
        aria-haspopup="listbox"
        aria-expanded={open}
        onClick={() => setOpen((wasOpen) => !wasOpen)}
        className={`pill-button flex items-center gap-1 border border-hairline py-1.5 text-[12px] ${
          open ? 'bg-elevated text-ink' : 'text-muted hover:text-ink'
        }`}
      >
        {current?.label ?? label}
        <ChevronDown className="h-3 w-3 opacity-70" aria-hidden="true" />
      </button>

      {open ? (
        <>
          {}
          <div
            className="fixed inset-0 z-10"
            onClick={() => setOpen(false)}
            aria-hidden="true"
          />
          <div
            role="listbox"
            aria-label={label}
            className={`animate-scale-in absolute left-0 z-20 max-h-64 overflow-y-auto rounded-card border border-hairline bg-elevated p-1.5 shadow-popover ${
              direction === 'up' ? 'bottom-full mb-2' : 'top-full mt-2'
            } ${menuClassName}`}
          >
            {options.map((option) => (
              <button
                key={option.value}
                type="button"
                role="option"
                aria-selected={option.value === value}
                onClick={() => {
                  onChange(option.value);
                  setOpen(false);
                }}
                className={`flex w-full items-center justify-between gap-2 rounded-control px-2.5 py-1.5 text-left text-[12px] transition-colors hover:bg-surface ${
                  option.value === value ? 'text-accent' : 'text-muted hover:text-ink'
                }`}
              >
                {option.label}
                {option.value === value ? (
                  <Check className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
                ) : null}
              </button>
            ))}
          </div>
        </>
      ) : null}
    </div>
  );
}
