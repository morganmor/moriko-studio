import { useEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { Bell, Check, ChevronDown, PanelRightClose, X } from './icons';

import { type MessageTone } from '../lib/messageCatalog';
import { Component } from 'react';
import { RefreshCw } from './icons';
import { useStore } from '../store/useStore';

/** Utility for conditional class strings. Keeps JSX readable without a dep. */
export function cx(...values: Array<string | false | null | undefined>): string {
  return values.filter(Boolean).join(' ');
}

interface LazyViewBoundaryState {
  error: Error | null;
}

/**
 * Error boundary around LAZY views. Before this, a failed chunk fetch or a
 * render error in a lazy view rendered as SILENT BLANK (Suspense fallback
 * null swallows loading; a rejected import is an unhandled rejection with
 * `hmr.overlay: false`) — the user only saw an empty main card. Now a failed
 * view shows what went wrong plus a reload affordance.
 */
export class LazyViewBoundary extends Component<{ label: string; children: ReactNode }, LazyViewBoundaryState> {
  state: LazyViewBoundaryState = { error: null };

  static getDerivedStateFromError(error: Error): LazyViewBoundaryState {
    return { error };
  }

  componentDidCatch(error: Error): void {
    console.error(`[LazyViewBoundary] ${this.props.label} failed:`, error);
  }

  render() {
    if (this.state.error) {
      return (
        <div className="mx-auto w-full max-w-xl px-6 py-16 text-center" role="alert">
          <p className="text-sm font-medium text-ink">{this.props.label} failed to load.</p>
          <p className="mt-2 break-words text-[12px] leading-relaxed text-faint">{this.state.error.message}</p>
          <button
            type="button"
            className="pill-button mx-auto mt-4 flex items-center gap-1.5 border border-hairline px-3 py-1.5 text-[12px] text-muted hover:text-ink"
            onClick={() => window.location.reload()}
          >
            <RefreshCw className="h-3.5 w-3.5" aria-hidden="true" />
            Reload
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}

/** Visible pending state for lazy views — never a silent blank again. */
export function LazyViewFallback({ label }: { label: string }) {
  return (
    <div className="flex items-center justify-center gap-2 py-16 text-[12.5px] text-faint" role="status">
      <span className="h-3 w-3 animate-pulse rounded-full bg-accent/60" aria-hidden="true" />
      Loading {label}…
    </div>
  );
}

/**
 * SINGLE-SLOT right-dock switcher (replaces the segmented 4-tab switch): one
 * button showing the ACTIVE sidebar's name — it carries the panel-title role,
 * so panels no longer render a duplicate <h2> — and clicking it opens a menu
 * of every sidebar (Config / Tree / Addons / Diff). Portaled to <body>: the
 * panels are overflow-hidden, an in-place dropdown would be clipped.
 * Themed components only (no native menus, no title attributes).
 */
type RightDockMode = 'config' | 'tree' | 'addons' | 'diff';

export function RightDockSlot({
  mode,
  onChange,
}: {
  mode: RightDockMode;
  onChange: (mode: RightDockMode) => void;
}) {
  const items: Array<{ key: RightDockMode; label: string }> = [
    { key: 'config', label: 'Configuration' },
    { key: 'tree', label: 'Project tree' },
    { key: 'addons', label: 'Addons' },
    { key: 'diff', label: 'Diff' },
  ];
  const activeLabel = items.find((item) => item.key === mode)?.label ?? 'Sidebar';
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<{ top?: number; bottom?: number; left: number } | null>(null);
  const anchorRef = useRef<HTMLButtonElement | null>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);

  // Close on outside pointerdown / Escape while the menu is open.
  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target as Node | null;
      if (target && (anchorRef.current?.contains(target) || menuRef.current?.contains(target))) return;
      setOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false);
    };
    document.addEventListener('pointerdown', onPointerDown, true);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown, true);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [open]);

  const toggle = () => {
    if (!open) {
      const box = anchorRef.current?.getBoundingClientRect();
      if (box) {
        // Flip upward when the viewport cannot fit the menu below the slot.
        const flip = box.bottom + 170 > window.innerHeight;
        setPos(
          flip
            ? { bottom: window.innerHeight - box.top + 6, left: box.left }
            : { top: box.bottom + 6, left: box.left },
        );
      }
    }
    setOpen((value) => !value);
  };

  return (
    <div className="relative shrink-0">
      <button
        ref={anchorRef}
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={toggle}
        className="flex items-center gap-1.5 rounded-control border border-hairline bg-surface px-2 py-1 text-[13px] font-semibold text-ink transition-colors hover:border-accent/40"
      >
        {activeLabel}
        <ChevronDown
          className={cx('h-3 w-3 shrink-0 text-faint transition-transform', open && 'rotate-180')}
          aria-hidden="true"
        />
      </button>
      {open && pos
        ? createPortal(
            <div
              ref={menuRef}
              role="menu"
              aria-label="Right sidebar"
              style={{ position: 'fixed', top: pos.top, bottom: pos.bottom, left: pos.left }}
              className="z-50 min-w-[170px] overflow-y-auto rounded-control border border-hairline bg-elevated py-1 shadow-popover"
            >
              {items.map((item) => (
                <button
                  key={item.key}
                  type="button"
                  role="menuitemradio"
                  aria-checked={item.key === mode}
                  onClick={() => {
                    onChange(item.key);
                    setOpen(false);
                  }}
                  className={cx(
                    'flex w-full items-center gap-2 px-2.5 py-1.5 text-left text-[12px] transition-colors',
                    item.key === mode ? 'text-ink' : 'text-muted hover:bg-accent/10 hover:text-ink',
                  )}
                >
                  <Check
                    className={cx('h-3 w-3 shrink-0', item.key === mode ? 'text-accent' : 'invisible')}
                    aria-hidden="true"
                  />
                  {item.label}
                </button>
              ))}
            </div>,
            document.body,
          )
        : null}
    </div>
  );
}

/**
 * Height-animated disclosure (grid-rows 0fr→1fr) — the shared easing used by
 * the activity pill, the thread panels and the sidebar groups. Content stays
 * mounted ~330ms after close so the collapse eases down instead of snapping
 * shut, then unmounts.
 */
export function CollapseSection({
  open,
  className,
  contentClassName,
  children,
}: {
  open: boolean;
  className?: string;
  contentClassName?: string;
  children: ReactNode;
}) {
  const [contentMounted, setContentMounted] = useState(open);
  useEffect(() => {
    if (open) {
      setContentMounted(true);
      return;
    }
    const timer = window.setTimeout(() => setContentMounted(false), 330);
    return () => window.clearTimeout(timer);
  }, [open]);

  return (
    <div
      className={cx('grid transition-[grid-template-rows] duration-300 ease-in-out', className)}
      style={{ gridTemplateRows: open ? '1fr' : '0fr' }}
      aria-hidden={!open}
    >
      <div className={cx('min-h-0 overflow-hidden', contentClassName)}>
        {contentMounted ? children : null}
      </div>
    </div>
  );
}

/**
 * The GENERIC close button for any right-dock panel. It binds itself to the
 * dock state (toggleSettings) instead of taking callbacks, so EVERY docked
 * panel — Configuration, Tree, and any panel added later — only has to render
 * <RightDockCloseButton /> in its header and the hide affordance is there.
 */
export function RightDockCloseButton({ label = 'Close right sidebar' }: { label?: string }) {
  const toggleSettings = useStore((state) => state.toggleSettings);
  return (
    <button
      type="button"
      className="icon-button bg-elevated text-ink"
      onClick={toggleSettings}
      aria-label={label}
    >
      <PanelRightClose className="h-4 w-4" aria-hidden="true" />
    </button>
  );
}




/**
 * Themed hover tooltip. Replaces the native `title` attribute, whose OS
 * bubble renders as a plain white box that fights the Moriko surface.
 * PORTAL + FIXED positioning: the bubble mounts on document.body measured
 * from the trigger's viewport rect, so an ancestor with overflow-hidden
 * (docks, scroll panes, the composer) can never clip it.
 */
export function Tip({
  label,
  children,
  side = 'top',
  align = 'center',
  className,
}: {
  label: string | undefined;
  children: ReactNode;
  side?: 'top' | 'bottom';
  align?: 'start' | 'center' | 'end';
  /** Extra classes for the wrapper (flex sizing in toolbars, width fills). */
  className?: string;
}) {
  const anchorRef = useRef<HTMLSpanElement>(null);
  const [hover, setHover] = useState(false);
  const [rect, setRect] = useState<{ top: number; bottom: number; left: number; right: number } | null>(null);

  // Measure on hover; a scroll/resize under the cursor re-measures, a close
  // clears the position so the fade-out doesn't visibly jump.
  useEffect(() => {
    if (!hover) {
      setRect(null);
      return;
    }
    const measure = (): void => {
      const box = anchorRef.current?.getBoundingClientRect();
      if (box) setRect({ top: box.top, bottom: box.bottom, left: box.left, right: box.right });
    };
    measure();
    window.addEventListener('scroll', measure, true);
    window.addEventListener('resize', measure);
    return () => {
      window.removeEventListener('scroll', measure, true);
      window.removeEventListener('resize', measure);
    };
  }, [hover]);

  if (!label) return <>{children}</>;
  const left =
    align === 'start' ? rect?.left : align === 'end' ? rect?.right : rect ? (rect.left + rect.right) / 2 : undefined;
  const top = side === 'bottom' ? rect?.bottom : rect?.top;
  const alignShift =
    align === 'center' ? 'translateX(-50%)' : align === 'end' ? 'translateX(-100%)' : 'translateX(0)';
  const sideShift = side === 'bottom' ? 'translateY(8px)' : 'translateY(calc(-100% - 8px))';
  // INNERMOST-WINS: nested Tips (the tokens Tip wraps the cache Tip) must
  // never open two portal bubbles at once. pointerover BUBBLES, so every
  // ancestor Tip is asked whether it is still the closest anchor to the
  // pointer — the outer bubble closes itself the moment a nested one opens.
  const isInnermost = (target: EventTarget | null): boolean =>
    target instanceof Element && target.closest('[data-tip-anchor]') === anchorRef.current;
  return (
    <span
      ref={anchorRef}
      className={cx('relative inline-flex group/tip', className)}
      data-tip-anchor=""
      onPointerOver={(event) => setHover(isInnermost(event.target))}
      onPointerLeave={() => setHover(false)}
      onFocusCapture={(event) => setHover(isInnermost(event.target))}
      onBlurCapture={() => setHover(false)}
    >
      {children}
      {hover && left !== undefined && top !== undefined
        ? createPortal(
            <span
              role="tooltip"
              style={{
                position: 'fixed',
                top,
                left,
                transform: `${alignShift} ${sideShift}`,
                opacity: hover ? 1 : 0,
              }}
              className="pointer-events-none z-[80] w-max max-w-[340px] rounded-control border border-hairline bg-elevated px-3 py-2 text-[12.5px] leading-snug text-ink shadow-popover transition-opacity duration-150"
            >
              {label}
            </span>,
            document.body,
          )
        : null}
    </span>
  );
}


interface ModalProps {
  open: boolean;
  onClose: () => void;
  title: string;
  description?: string;
  children: ReactNode;
  footer?: ReactNode;
  /** Tailwind max-width class for the panel. */
  size?: string;
  /** Extra header controls rendered LEFT of the close ✕ (e.g. reload). */
  headerExtra?: ReactNode;
}

/**
 * Accessible dialog: focus is moved in on open, Escape closes, and the page
 * behind is scroll-locked so the backdrop never scrolls out from under you.
 */
export function Modal({
  open,
  onClose,
  title,
  description,
  children,
  footer,
  size = 'max-w-2xl',
  headerExtra,
}: ModalProps) {
  const panelRef = useRef<HTMLDivElement>(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  useEffect(() => {
    if (!open) return;

    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onCloseRef.current();
    };
    document.addEventListener('keydown', onKeyDown);

    const focusTimer = window.setTimeout(() => {
      const focusable = panelRef.current?.querySelector<HTMLElement>(
        'input, textarea, select, button:not([data-skip-autofocus])',
      );
      focusable?.focus();
    }, 40);

    return () => {
      document.body.style.overflow = previousOverflow;
      document.removeEventListener('keydown', onKeyDown);
      window.clearTimeout(focusTimer);
    };
  }, [open]);

  if (!open) return null;

  // PORTAL to document.body — a Modal rendered inside an ancestor with a CSS
  // transform (dock wrapper, drawer, #root's zoom scale) becomes trapped by
  // that ancestor's containing block: `fixed inset-0` covers the ANCESTOR's
  // box, not the viewport, and the "Select a model" picker shrinks into the
  // dock corner. Body-level portals escape every transform.
  return createPortal(
    <div
      className="fixed inset-0 z-50 flex items-center justify-center overflow-hidden bg-black/60 p-4 backdrop-blur-sm"
      role="presentation"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        className={cx(
          'animate-scale-in flex max-h-[calc(100vh-2rem)] w-full flex-col rounded-card border border-hairline bg-surface shadow-popover',
          size,
        )}
      >
        <header className="flex shrink-0 items-start justify-between gap-4 border-b border-hairline px-5 py-4">
          <div>
            <h2 className="text-base font-semibold text-ink">{title}</h2>
            {description ? <p className="mt-1 text-sm text-muted">{description}</p> : null}
          </div>
          <div className="flex shrink-0 items-center gap-2">
            {headerExtra}
            <button type="button" className="icon-button" onClick={onClose} aria-label="Close dialog">
              <X className="h-4 w-4" aria-hidden="true" />
            </button>
          </div>
        </header>

        {}
        <div className="flex min-h-0 flex-1 flex-col overflow-y-auto px-5 py-4">{children}</div>

        {footer ? (
          <footer className="flex shrink-0 items-center justify-end gap-2 border-t border-hairline px-5 py-4">
            {footer}
          </footer>
        ) : null}
      </div>
    </div>,
    document.body,
  );
}


interface ToggleProps {
  checked: boolean;
  onChange: (next: boolean) => void;
  label: string;
  /** Renders the label visually hidden; the control keeps its accessible name. */
  hideLabel?: boolean;
  disabled?: boolean;
}

/**
 * Switch control. Built on a real checkbox so it is keyboard-operable and
 * announced correctly, with the visual layer drawn on top.
 */
export function Toggle({ checked, onChange, label, hideLabel, disabled }: ToggleProps) {
  return (
    <label
      className={cx(
        'relative inline-flex items-center gap-2',
        disabled ? 'cursor-not-allowed opacity-50' : 'cursor-pointer',
      )}
    >
      <input
        type="checkbox"
        className="peer sr-only"
        checked={checked}
        disabled={disabled}
        onChange={(event) => onChange(event.target.checked)}
        aria-label={hideLabel ? label : undefined}
      />
      <span
        aria-hidden="true"
        className={cx(
          'relative h-5 w-9 shrink-0 rounded-full transition-colors duration-200',
          'after:absolute after:left-0.5 after:top-0.5 after:h-4 after:w-4 after:rounded-full',
          'after:bg-white after:shadow-sm after:transition-transform after:duration-200',
          'peer-focus-visible:outline peer-focus-visible:outline-2 peer-focus-visible:outline-offset-2',
          'peer-focus-visible:outline-accent',
          checked ? 'bg-accent after:translate-x-4' : 'bg-hairline',
        )}
      />
      {hideLabel ? null : <span className="text-sm text-ink">{label}</span>}
    </label>
  );
}



/** Tone → color classes. EVERY card is OPAQUE: a solid surface background,
 *  a real border and a popover shadow — the old translucent pops (bg-warn/10,
 *  bg-danger/10) let the streaming thread bleed through the text. */
const NOTICE_TONE: Record<MessageTone, { card: string; text: string; dot: string }> = {
  info: { card: 'border-hairline bg-elevated', text: 'text-ink', dot: 'bg-ink/40' },
  success: { card: 'border-success/60 bg-elevated', text: 'text-ink', dot: 'bg-success' },
  warn: { card: 'border-warn/70 bg-elevated', text: 'text-ink', dot: 'bg-warn' },
  danger: { card: 'border-danger/70 bg-elevated', text: 'text-ink', dot: 'bg-danger' },
  error: { card: 'border-danger/70 bg-elevated', text: 'text-danger', dot: 'bg-danger' },
};

/** One catalog-born notice card. The lifetime timer is per-card so a stacked
 *  queue behaves like the old single Toast; dismissal is manual and instant.
 *  WIDTH IS DYNAMIC: `w-fit` hugs the message length (a short "Model set to
 *  X." renders as a compact chip, never a stretched 380px bar) and grows only
 *  up to the cap, where long text wraps instead. */
function NoticeCard({ entry, onDismiss }: { entry: NoticeEntryView; onDismiss: (key: string) => void }) {
  useEffect(() => {
    const timer = window.setTimeout(() => onDismiss(entry.key), entry.ttl);
    return () => window.clearTimeout(timer);
  }, [entry.key, entry.ttl, onDismiss]);

  const tone = NOTICE_TONE[entry.tone];

  return (
    <div
      role="status"
      aria-live="polite"
      className={cx(
        'animate-fade-up pointer-events-auto w-fit min-w-[200px] max-w-[min(460px,calc(100vw-2rem))] rounded-card border px-3.5 py-2.5 shadow-popover',
        tone.card,
      )}
    >
      <div className="flex items-start gap-2">
        <span aria-hidden="true" className={cx('mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full', tone.dot)} />
        <div className="min-w-0 flex-1">
          <p className={cx('text-[12.5px] leading-relaxed break-words', tone.text)}>{entry.text}</p>
          {entry.detail ? (
            <p className="mt-1 text-[11px] leading-snug text-faint break-words">{entry.detail}</p>
          ) : null}
        </div>
        <button
          type="button"
          className="icon-button -m-1 shrink-0"
          onClick={() => onDismiss(entry.key)}
          aria-label="Dismiss notice"
        >
          <X className="h-3.5 w-3.5" aria-hidden="true" />
        </button>
      </div>
    </div>
  );
}

export interface NoticeEntryView {
  key: string;
  id: string;
  text: string;
  detail?: string;
  tone: MessageTone;
  ttl: number;
}

/**
 * The Notice Center: harness + UI messages surface here, stacked UNDER THE
 * SESSION TITLE — measured from the session-title BAR (the #moriko-session-bar
 * header inside the main card), not from the viewport's left edge. The fixed
 * left-3 placement covered the sidebar instead of the title bar, so the
 * anchor is now the bar's bounding rect. Still portaled to document.body
 * (fixed positioning must escape transformed ancestors) and z-60 (above the
 * z-50 modals). A history trail keeps every notice of this session.
 */
export function NoticeCenter({
  entries,
  history,
  expanded,
  onToggleExpanded,
  onDismiss,
  onClearHistory,
}: {
  entries: NoticeEntryView[];
  history: NoticeEntryView[];
  expanded: boolean;
  onToggleExpanded: () => void;
  onDismiss: (key: string) => void;
  onClearHistory: () => void;
}) {
  // Anchor: the session-title bar. Falls back to the fixed 3.5rem offset when
  // the bar is not in the DOM yet (SSR/first paint).
  const [anchor, setAnchor] = useState({ left: 12, top: 62 });
  useEffect(() => {
    const update = () => {
      const bar = document.getElementById('moriko-session-bar');
      if (!bar) return;
      const rect = bar.getBoundingClientRect();
      setAnchor({ left: Math.max(12, Math.round(rect.left) + 12), top: Math.round(rect.bottom) + 6 });
    };
    update();
    window.addEventListener('resize', update);
    // Sidebar collapse / panel toggles shift the bar horizontally.
    const observer = new ResizeObserver(update);
    if (document.getElementById('moriko-session-bar')) {
      observer.observe(document.getElementById('moriko-session-bar') as Element);
    }
    return () => {
      window.removeEventListener('resize', update);
      observer.disconnect();
    };
  }, []);

  if (entries.length === 0 && history.length === 0) return null;

  // ONE portaled stack: history panel (when expanded) first, then the live
  // notices, then the history toggle — all under the session title.
  const stack = (
    <div
      className="pointer-events-none fixed z-[60] flex w-fit max-w-[min(460px,calc(100vw-1.5rem))] flex-col items-start gap-2"
      style={{ left: anchor.left, top: anchor.top }}
    >
      {expanded && history.length > 0 ? (
        <div className="pointer-events-auto flex max-h-[40vh] w-fit min-w-[280px] max-w-full flex-col overflow-hidden rounded-card border border-hairline bg-elevated shadow-popover">
          <div className="flex items-center justify-between border-b border-hairline px-3 py-2">
            <span className="text-[11px] font-medium text-muted">Notice history ({history.length})</span>
            <button
              type="button"
              className="text-[11px] text-faint transition-colors hover:text-ink"
              onClick={onClearHistory}
            >
              Clear
            </button>
          </div>
          <div className="max-h-[calc(40vh-2.5rem)] overflow-y-auto px-2 py-2">
            {history.map((entry) => (
              <div key={entry.key} className="flex items-start gap-2 rounded-control px-1.5 py-1.5">
                <span aria-hidden="true" className={cx('mt-1.5 h-1 w-1 shrink-0 rounded-full', NOTICE_TONE[entry.tone].dot)} />
                <p className={cx('min-w-0 flex-1 text-[11.5px] leading-snug', NOTICE_TONE[entry.tone].text)}>
                  {entry.text}
                  {entry.detail ? <span className="text-faint"> — {entry.detail}</span> : null}
                </p>
              </div>
            ))}
          </div>
        </div>
      ) : null}

      {entries.map((entry) => (
        <NoticeCard key={entry.key} entry={entry} onDismiss={onDismiss} />
      ))}

      {history.length > 0 ? (
        <button
          type="button"
          className="pointer-events-auto flex items-center gap-1.5 rounded-control border border-hairline bg-elevated px-2.5 py-1 text-[11px] text-muted shadow-popover transition-colors hover:text-ink"
          onClick={onToggleExpanded}
          aria-expanded={expanded}
        >
          <Bell className="h-3 w-3" aria-hidden="true" />
          {expanded ? 'Hide history' : `History (${history.length})`}
          <ChevronDown className={cx('h-3 w-3 transition-transform', expanded && 'rotate-180')} aria-hidden="true" />
        </button>
      ) : null}
    </div>
  );

  if (typeof document === 'undefined') return stack;
  return createPortal(stack, document.body);
}


export function Field({
  label,
  hint,
  htmlFor,
  children,
}: {
  label: string;
  hint?: string;
  htmlFor?: string;
  children: ReactNode;
}) {
  return (
    <div>
      <label className="field-label" htmlFor={htmlFor}>
        {label}
      </label>
      {children}
      {hint ? <p className="mt-1.5 text-xs text-faint">{hint}</p> : null}
    </div>
  );
}

export function EmptyState({
  icon,
  title,
  description,
  action,
}: {
  icon: ReactNode;
  title: string;
  description: string;
  action?: ReactNode;
}) {
  return (
    <div className="flex flex-col items-center justify-center px-6 py-16 text-center">
      <div className="mb-4 flex h-12 w-12 items-center justify-center rounded-full border border-hairline bg-surface text-muted">
        {icon}
      </div>
      <h3 className="text-sm font-semibold text-ink">{title}</h3>
      <p className="mt-1.5 max-w-sm text-sm text-muted">{description}</p>
      {action ? <div className="mt-5">{action}</div> : null}
    </div>
  );
}
