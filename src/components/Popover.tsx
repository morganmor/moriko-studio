import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode, type RefObject } from 'react';
import { createPortal } from 'react-dom';
import { useIsPhone } from '../hooks/useIsPhone';
import { Sheet } from './Sheet';

export type PopoverPlacement = 'bottom-start' | 'bottom-end' | 'right-start';

interface PopoverProps {
  open: boolean;
  onClose: () => void;
  /** Phone sheet only: header Back handler. When set, Back calls this instead
   *  of onClose — lets nested panels step back (e.g. Model list → quick picker). */
  onBack?: () => void;
  anchorRef: RefObject<HTMLElement | null>;
  label: string;
  role?: 'menu' | 'dialog' | 'listbox';
  placement?: PopoverPlacement;
  width?: number;
  className?: string;
  style?: CSSProperties;
  children: ReactNode;
}

const GAP = 6;
const EDGE = 8;
const MAX_HEIGHT = 480;
const EXIT_MS = 160;

/**
 * Design `.pop` popover (moriko-design-1-popovers-menus.html): portaled to <body>
 * so no overflow/transform ancestor can clip it, positioned fixed from the anchor,
 * flipped and clamped to the viewport, scrollable when space is short, and a
 * bottom sheet on phones. Closes on outside pointer, Escape; arrow keys move focus.
 */
export function Popover({
  open,
  onClose,
  onBack,
  anchorRef,
  label,
  role = 'menu',
  placement = 'bottom-start',
  width,
  className,
  style,
  children,
}: PopoverProps) {
  const isPhone = useIsPhone();
  const ref = useRef<HTMLDivElement>(null);
  const [mounted, setMounted] = useState(open);
  const [shown, setShown] = useState(false);

  useEffect(() => {
    if (open) {
      setMounted(true);
      const frame = requestAnimationFrame(() => setShown(true));
      return () => cancelAnimationFrame(frame);
    }
    setShown(false);
    const timer = window.setTimeout(() => setMounted(false), EXIT_MS);
    return () => window.clearTimeout(timer);
  }, [open]);

  const show = open || mounted;

  useLayoutEffect(() => {
    if (!show) return;
    const place = () => {
      const el = ref.current;
      const anchor = anchorRef.current;
      if (!el || !anchor) return;
      if (isPhone) {
        el.style.left = '';
        el.style.top = '';
        return;
      }
      el.style.maxHeight = 'none';
      const box = anchor.getBoundingClientRect();
      const w = el.offsetWidth;
      const h = el.offsetHeight;
      let x: number;
      let y: number;
      let up = false;
      let maxH: number;
      if (placement === 'right-start') {
        maxH = Math.min(MAX_HEIGHT, window.innerHeight - EDGE * 2);
        const hh = Math.min(h, maxH);
        x = box.right + GAP;
        if (x + w > window.innerWidth - EDGE) x = box.left - GAP - w;
        y = Math.max(EDGE, Math.min(box.top, window.innerHeight - hh - EDGE));
      } else {
        const below = window.innerHeight - box.bottom - GAP - EDGE;
        const above = box.top - GAP - EDGE;
        up = h > below && above > below;
        maxH = Math.max(120, Math.min(MAX_HEIGHT, up ? above : below));
        const hh = Math.min(h, maxH);
        y = up ? box.top - GAP - hh : box.bottom + GAP;
        y = Math.max(EDGE, Math.min(y, window.innerHeight - hh - EDGE));
        x = placement === 'bottom-end' ? box.right - w : box.left;
      }
      x = Math.max(EDGE, Math.min(x, window.innerWidth - w - EDGE));
      el.style.maxHeight = `${maxH}px`;
      el.style.left = `${x}px`;
      el.style.top = `${y}px`;
      el.style.transformOrigin = `${up ? 'bottom' : 'top'} ${placement === 'bottom-end' ? 'right' : 'left'}`;
      el.style.setProperty('--oy', up ? '-4px' : '4px');
    };
    place();
    const onScroll = (event: Event) => {
      if (event.target instanceof Node && ref.current?.contains(event.target)) return;
      place();
    };
    window.addEventListener('resize', place);
    window.addEventListener('scroll', onScroll, true);
    return () => {
      window.removeEventListener('resize', place);
      window.removeEventListener('scroll', onScroll, true);
    };
  }, [show, isPhone, placement, width, anchorRef]);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target as Node | null;
      if (!target) return;
      if (ref.current?.contains(target) || anchorRef.current?.contains(target)) return;
      if (target instanceof Element && target.closest('[data-sheet]')) return;
      onClose();
    };
    const onKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.key === 'Escape') {
        onClose();
        anchorRef.current?.focus();
        return;
      }
      if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
      const origin = event.target;
      if (origin instanceof Element && origin.closest('.seg')) return;
      const items = ref.current
        ? Array.from(ref.current.querySelectorAll<HTMLElement>('.mi, .mo, .es, .sw, .pi')).filter(
            (item) => !(item as HTMLButtonElement).disabled && item.offsetParent !== null,
          )
        : [];
      if (items.length === 0) return;
      event.preventDefault();
      const index = items.indexOf(document.activeElement as HTMLElement);
      const next =
        event.key === 'Home'
          ? 0
          : event.key === 'End'
            ? items.length - 1
            : event.key === 'ArrowDown'
              ? (index + 1) % items.length
              : index <= 0
                ? items.length - 1
                : index - 1;
      items[next].focus();
    };
    document.addEventListener('pointerdown', onPointerDown, true);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown, true);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [open, onClose, anchorRef]);

  useEffect(() => {
    if (!open || isPhone) return;
    const timer = window.setTimeout(() => {
      const el = ref.current;
      const target =
        el?.querySelector<HTMLInputElement>('input[type=search]') ??
        el?.querySelector<HTMLElement>('input:not([type])');
      target?.focus({ preventScroll: true });
    }, 30);
    return () => window.clearTimeout(timer);
  }, [open, isPhone]);

  if (!show) return null;
  if (isPhone) {
    return (
      <Sheet open={open} onClose={onClose} onBack={onBack} label={label}>
        {children}
      </Sheet>
    );
  }

  return createPortal(
    <div
      ref={ref}
      role={role}
      aria-label={label}
      data-popover
      className={`pop${shown ? ' open' : ''}${className ? ` ${className}` : ''}`}
      style={{
        zIndex: 70,
        ...(isPhone ? { maxHeight: '72dvh' } : { width }),
        ...style,
      }}
    >
      {children}
    </div>,
    document.body,
  );
}
