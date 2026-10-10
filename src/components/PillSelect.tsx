import { useRef, useState } from 'react';
import { Check, ChevronDown } from './icons';
import { cx } from './ui';
import { Popover } from './Popover';

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
}: {
  label: string;
  value: string;
  options: { value: string; label: string }[];
  onChange: (value: string) => void;
  /** Tailwind width/positioning classes for the opened menu (w-NN → px). */
  menuClassName?: string;
  /**
   * Deprecated: the Popover primitive now picks the side automatically (flip
   * above/below like the design), so an explicit direction is unnecessary.
   */
  direction?: 'up' | 'down';
}) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const current = options.find((option) => option.value === value);
  /** Tailwind w-NN = NN × 4px; the old default was w-44 (176px). */
  const menuWidth = Number(/^w-(\d+)$/.exec(menuClassName)?.[1] ?? 44) * 4;

  return (
    <div className="relative" ref={rootRef}>
      <button
        ref={buttonRef}
        type="button"
        aria-label={label}
        aria-haspopup="listbox"
        aria-expanded={open}
        onClick={() => setOpen((wasOpen) => !wasOpen)}
        className={cx('pill', open && 'on')}
        style={{ height: 28, fontSize: 12 }}
      >
        {current?.label ?? label}
        <ChevronDown className="chev" style={{ width: 12, height: 12, opacity: 0.7 }} aria-hidden="true" />
      </button>

      <Popover
        open={open}
        onClose={() => setOpen(false)}
        anchorRef={buttonRef}
        label={label}
        role="listbox"
        width={menuWidth}
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
                className={cx('mi', option.value === value && 'on')}
                style={{ width: '100%', justifyContent: 'space-between', fontSize: 12, color: option.value === value ? 'rgb(var(--c-accent))' : undefined }}
              >
                {option.label}
                {option.value === value ? (
                  <Check className="ic mck" style={{ width: 14, height: 14 }} aria-hidden="true" />
                ) : null}
              </button>
            ))}
      </Popover>
    </div>
  );
}
