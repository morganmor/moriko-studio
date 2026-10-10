import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode, type RefObject } from 'react';
import { createPortal } from 'react-dom';
import { Check, ChevronDown, PanelRightClose, SlidersHorizontal, X } from './icons';

import { type MessageTone } from '../lib/messageCatalog';
import { Component } from 'react';
import { RefreshCw } from './icons';
import { useStore } from '../store/useStore';
import { Popover } from './Popover';

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
        <div style={{ margin: '0 auto', width: '100%', maxWidth: '576px', padding: '64px 24px', textAlign: 'center' }} role="alert">
          <p style={{ fontSize: 14, fontWeight: 500, color: 'rgb(var(--c-ink))' }}>{this.props.label} failed to load.</p>
          <p style={{ marginTop: 8, overflowWrap: 'break-word', fontSize: 12, lineHeight: 1.625, color: 'var(--faint)' }}>{this.state.error.message}</p>
          <button type="button" className="btn xs" style={{ margin: '16px auto 0' }} onClick={() => window.location.reload()}>
            <RefreshCw className="ic" aria-hidden="true" />
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
    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8, padding: '64px 0', fontSize: 12.5, color: 'var(--faint)' }} role="status">
      <span className="spin" aria-hidden="true" />
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
        const flip = box.bottom + 170 > window.innerHeight;
        // Clamp horizontally: a 170px-wide menu must stay on screen on phones.
        const left = Math.max(8, Math.min(box.left, window.innerWidth - 186));
        setPos(
          flip
            ? { bottom: window.innerHeight - box.top + 6, left }
            : { top: box.bottom + 6, left },
        );
      }
    }
    setOpen((value) => !value);
  };

  return (
    <div style={{ position: 'relative', flexShrink: 0 }}>
      <button
        ref={anchorRef}
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={toggle}
        className="rd-slot dswitch"
      >
        <span className="icw" aria-hidden="true">
          <SlidersHorizontal className="ic" />
        </span>
        <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{activeLabel}</span>
        <ChevronDown
          className="chev"
          style={{ color: 'var(--faint)', transform: open ? 'rotate(180deg)' : undefined }}
          aria-hidden="true"
        />
      </button>
      {open && pos
        ? createPortal(
            <div
              ref={menuRef}
              role="menu"
              aria-label="Right sidebar"
              style={{ position: 'fixed', top: pos.top, bottom: pos.bottom, left: pos.left, minWidth: 170 }}
              className="pop open"
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
                  className="mi"
                  style={{ minHeight: 32, fontSize: 12.5 }}
                >
                  <Check className="ic mck" aria-hidden="true" />
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
    <div className={cx('col', !open && 'shut', className)} aria-hidden={!open}>
      <div className={cx('col-in', contentClassName)}>
        {contentMounted ? children : null}
      </div>
    </div>
  );
}

/**
 * Segmented control (right-dock design): a row of radio buttons with a
 * sliding indicator pill that springs between options. Indicator geometry is
 * measured from the checked button (offsetLeft/offsetWidth) and re-measured
 * on value change + window resize; the first paint renders without the pill
 * so it never sits at 0,0 mid-flight.
 */
export function Segmented({
  value,
  options,
  onChange,
  ariaLabel,
  small,
  className,
  style,
}: {
  value: string;
  options: Array<{ value: string; label: string; tip?: string }>;
  onChange: (value: string) => void;
  ariaLabel: string;
  /** Design's `.seg.sm` — 26px rows, 12px type. */
  small?: boolean;
  className?: string;
  style?: React.CSSProperties;
}) {
  const segRef = useRef<HTMLDivElement>(null);
  const [indicator, setIndicator] = useState<{ x: number; w: number } | null>(null);

  const measure = useCallback(() => {
    const seg = segRef.current;
    if (!seg) return;
    const checked = seg.querySelector<HTMLButtonElement>(`button[data-v="${CSS.escape(value)}"]`);
    if (!checked || !checked.offsetWidth) return;
    // A Tip (.seg-opt) wrapper is position:relative, so the button's offsetLeft
    // is relative to THAT span — accumulate offsets up to the .seg root or the
    // pill would pin to the first option forever (Operator/Admin looked dead).
    let x = checked.offsetLeft;
    let node = checked.offsetParent as HTMLElement | null;
    while (node && node !== seg) {
      x += node.offsetLeft;
      node = node.offsetParent as HTMLElement | null;
    }
    setIndicator({ x, w: checked.offsetWidth });
  }, [value]);

  useLayoutEffect(measure, [measure]);
  useEffect(() => {
    window.addEventListener('resize', measure);
    return () => window.removeEventListener('resize', measure);
  }, [measure]);

  return (
    <div
      ref={segRef}
      role="radiogroup"
      aria-label={ariaLabel}
      className={cx('seg', small && 'sm', className)}
      style={{ ...style, ['--x' as string]: `${indicator?.x ?? 0}px`, ['--w' as string]: `${indicator?.w ?? 0}px` }}
    >
      {indicator ? <span className="ind" aria-hidden="true" /> : null}
      {options.map((option) => {
        const button = (
          <button
            key={option.value}
            type="button"
            role="radio"
            data-v={option.value}
            aria-checked={option.value === value}
            onClick={() => onChange(option.value)}
          >
            {option.label}
          </button>
        );
        return option.tip ? (
          <Tip key={option.value} label={option.tip} className="seg-opt">
            {button}
          </Tip>
        ) : (
          button
        );
      })}
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
      className="ib"
      onClick={toggleSettings}
      aria-label={label}
    >
      <PanelRightClose className="ic" aria-hidden="true" />
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
  const isInnermost = (target: EventTarget | null): boolean =>
    target instanceof Element && target.closest('[data-tip-anchor]') === anchorRef.current;
  return (
    <span
      ref={anchorRef}
      className={className}
      style={{ position: 'relative', display: 'inline-flex' }}
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
                maxWidth: 340,
              }}
              className="tip show"
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
  /** Extra width class for the panel (design: .mpanel / .mpanel.sm). */
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
  size = '',
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

  return createPortal(
    <div
      className="modal open modal-shell"
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
        className={cx('mpanel modal-panel', size)}
      >
        <header className="mh">
          <div style={{ minWidth: 0, flex: 1 }}>
            <h3 style={{ margin: 0, fontSize: 16, fontWeight: 600, color: 'rgb(var(--c-ink))' }}>{title}</h3>
            {description ? (
              <p style={{ margin: '4px 0 0', fontSize: 12.5, color: 'var(--muted)' }}>{description}</p>
            ) : null}
          </div>
          <div style={{ display: 'flex', flexShrink: 0, alignItems: 'center', gap: 8 }}>
            {headerExtra}
            <button type="button" className="ib" onClick={onClose} aria-label="Close dialog">
              <X className="ic" aria-hidden="true" />
            </button>
          </div>
        </header>

        {}
        <div className="mb" style={{ display: 'flex', minHeight: 0, flex: 1, flexDirection: 'column' }}>{children}</div>

        {footer ? (
          <footer
            style={{
              display: 'flex',
              flexShrink: 0,
              alignItems: 'center',
              justifyContent: 'flex-end',
              gap: 8,
              borderTop: '1px solid var(--line)',
              padding: '14px 18px',
            }}
          >
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
      style={{
        position: 'relative',
        display: 'inline-flex',
        alignItems: 'center',
        gap: 8,
        cursor: disabled ? 'not-allowed' : 'pointer',
        opacity: disabled ? 0.5 : 1,
      }}
    >
      <input
        type="checkbox"
        className="sr-only"
        checked={checked}
        disabled={disabled}
        onChange={(event) => onChange(event.target.checked)}
        aria-label={hideLabel ? label : undefined}
      />
      <span
        aria-hidden="true"
        className="sw"
        aria-checked={checked}
      />
      {hideLabel ? null : <span style={{ fontSize: 14, color: 'rgb(var(--c-ink))' }}>{label}</span>}
    </label>
  );
}



/** Tone → color classes. EVERY card is OPAQUE: a solid surface background,
 *  a real border and a popover shadow — the old translucent pops (bg-warn/10,
 *  bg-danger/10) let the streaming thread bleed through the text. */
const NOTICE_TONE: Record<MessageTone, { border: string; text: string; dot: string }> = {
  info: { border: 'var(--line)', text: 'rgb(var(--c-ink))', dot: 'rgb(var(--c-ink) / 0.4)' },
  success: { border: 'rgb(var(--c-ok) / 0.6)', text: 'rgb(var(--c-ink))', dot: 'rgb(var(--c-ok))' },
  warn: { border: 'rgb(var(--c-warn) / 0.7)', text: 'rgb(var(--c-ink))', dot: 'rgb(var(--c-warn))' },
  danger: { border: 'rgb(var(--c-danger) / 0.7)', text: 'rgb(var(--c-ink))', dot: 'rgb(var(--c-danger))' },
  error: { border: 'rgb(var(--c-danger) / 0.7)', text: 'rgb(var(--c-danger))', dot: 'rgb(var(--c-danger))' },
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
      className="toast"
      style={{
        maxWidth: 'min(460px, calc(100vw - 2rem))',
        minWidth: 200,
        borderColor: tone.border,
        animation: 'tIn .35s var(--spring)',
      }}
    >
      {/* flex:1 + minWidth:0 → inner mengisi lebar kartu (min-width:200), sehingga
          tombol X terdorong ke pojok kanan, bukan nempel setelah teks. */}
      <div style={{ display: 'flex', alignItems: 'flex-start', gap: 10, flex: 1, minWidth: 0 }}>
        <span
          aria-hidden="true"
          style={{ marginTop: 7, width: 6, height: 6, flexShrink: 0, borderRadius: '50%', background: tone.dot }}
        />
        <div style={{ minWidth: 0, flex: 1 }}>
          <p style={{ margin: 0, fontSize: 12.5, lineHeight: 1.625, overflowWrap: 'break-word', color: tone.text }}>
            {entry.text}
          </p>
          {entry.detail ? (
            <p style={{ margin: '4px 0 0', fontSize: 11, lineHeight: 1.375, overflowWrap: 'break-word', color: 'var(--faint)' }}>
              {entry.detail}
            </p>
          ) : null}
        </div>
        <button
          type="button"
          className="ib xs"
          style={{ marginTop: -1, flexShrink: 0 }}
          onClick={() => onDismiss(entry.key)}
          aria-label="Dismiss notice"
        >
          <X className="ic" style={{ width: 14, height: 14 }} aria-hidden="true" />
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
  /** When it fired — the notices popover's "Today · 14:30" stamp. */
  createdAt: number;
}

/** Design notices row stamp: "Today · 14:30" or "6 Oct · 14:30". */
function noticeStamp(at: number): string {
  const date = new Date(at);
  const now = new Date();
  const hm = `${date.getHours()}:${String(date.getMinutes()).padStart(2, '0')}`;
  if (date.toDateString() === now.toDateString()) return `Today · ${hm}`;
  return `${date.toLocaleDateString([], { day: 'numeric', month: 'short' })} · ${hm}`;
}

/**
 * The Notice Center: transient cards + the design's Notices popover
 * (pop-notices). BOTH anchor on the bell (anchorRef from TopBar): the stack
 * hangs right under it and the popover opens bottom-end of it, so the position
 * can never drift from the trigger again. Popover content follows the design:
 * "Notices" header with a Clear action over a scrollable .nt list — colored
 * dot, bold message, "Today · 14:30" stamp.
 */
export function NoticeCenter({
  entries,
  history,
  expanded,
  anchorRef,
  onToggleExpanded,
  onDismiss,
  onClearHistory,
}: {
  entries: NoticeEntryView[];
  history: NoticeEntryView[];
  expanded: boolean;
  /** The bell button — the transient stack and the popover anchor on it. */
  anchorRef: RefObject<HTMLElement | null>;
  onToggleExpanded: () => void;
  onDismiss: (key: string) => void;
  onClearHistory: () => void;
}) {
  /** Transient cards hug the bell: right-aligned, directly beneath it. */
  const [stackPos, setStackPos] = useState({ right: 12, top: 62 });
  useEffect(() => {
    const update = () => {
      const rect = anchorRef.current?.getBoundingClientRect();
      if (!rect) return;
      setStackPos({
        right: Math.max(8, Math.round(window.innerWidth - rect.right)),
        top: Math.round(rect.bottom) + 6,
      });
    };
    update();
    window.addEventListener('resize', update);
    return () => window.removeEventListener('resize', update);
  }, [anchorRef, entries.length]);

  const stack =
    entries.length > 0 ? (
      <div
        className="notice-stack"
        style={{
          position: 'fixed',
          zIndex: 90,
          display: 'flex',
          width: 'fit-content',
          maxWidth: 'min(460px, calc(100vw - 1.5rem))',
          flexDirection: 'column',
          alignItems: 'flex-end',
          gap: 8,
          pointerEvents: 'none',
          right: stackPos.right,
          top: stackPos.top,
        }}
      >
        {entries.map((entry) => (
          <NoticeCard key={entry.key} entry={entry} onDismiss={onDismiss} />
        ))}
      </div>
    ) : null;

  return (
    <>
      {stack && typeof document !== 'undefined' ? createPortal(stack, document.body) : null}
      <Popover
        open={expanded}
        onClose={onToggleExpanded}
        anchorRef={anchorRef}
        label="Notices"
        role="dialog"
        placement="bottom-end"
        width={340}
        className="wide"
      >
        <div className="pop-h">
          <span>Notices</span>
          <button type="button" className="btn xs ghost" onClick={onClearHistory}>
            Clear
          </button>
        </div>
        {history.length === 0 ? (
          <p className="pop-empty">No notices yet.</p>
        ) : (
          <div className="nt-list">
            {history.map((entry) => (
              <div key={entry.key} className="nt">
                <span className="nd" style={{ background: NOTICE_TONE[entry.tone].dot }} aria-hidden="true" />
                <div className="min0">
                  <b>{entry.text}</b>
                  <span>{noticeStamp(entry.createdAt)}</span>
                  {entry.detail ? <span>{entry.detail}</span> : null}
                </div>
              </div>
            ))}
          </div>
        )}
      </Popover>
    </>
  );
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
      {hint ? <p style={{ margin: '6px 0 0', fontSize: 12, color: 'var(--faint)' }}>{hint}</p> : null}
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
    <div className="empty">
      <div className="eic">{icon}</div>
      <b>{title}</b>
      <p>{description}</p>
      {action ? <div>{action}</div> : null}
    </div>
  );
}
