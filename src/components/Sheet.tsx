/**
 * Sheet — phone bottom sheet: drag handle, swipe-down to dismiss, backdrop tap
 * and Escape. Portaled to <body> so it escapes the composer's stacking context.
 */
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { ChevronLeft } from './icons';

export function Sheet({
  open,
  onClose,
  onBack,
  label,
  children,
}: {
  open: boolean;
  onClose: () => void;
  /** Optional: when wired, the header Back steps back one level instead of
   *  closing the sheet (quick picker: Model/Reasoning → back → the quick list). */
  onBack?: () => void;
  label: string;
  children: ReactNode;
}) {
  const [dragY, setDragY] = useState(0);
  const startY = useRef<number | null>(null);

  useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [open, onClose]);

  useEffect(() => {
    if (!open) setDragY(0);
  }, [open]);

  if (!open) return null;

  return createPortal(
    <div data-sheet style={{ position: 'fixed', inset: 0, zIndex: 60, display: 'flex', alignItems: 'flex-end', justifyContent: 'center' }}>
      <button
        type="button"
        aria-label="Close"
        onClick={onClose}
        style={{ position: 'absolute', inset: 0, background: 'rgb(var(--c-shadow) / 0.55)' }}
      />
      <div
        role="dialog"
        aria-modal="true"
        aria-label={label}
        className="sheet-panel"
        style={{ position: 'relative', display: 'flex', maxHeight: '78dvh', width: '100%', maxWidth: 448, flexDirection: 'column', borderRadius: 'var(--r-xl) var(--r-xl) 0 0', borderTop: '1px solid var(--line)', background: 'rgb(var(--c-elev))', boxShadow: 'var(--sh2)', ...(dragY ? { transform: `translateY(${dragY}px)` } : undefined) }}
      >
        {}
        <div
          style={{ display: 'flex', flexShrink: 0, touchAction: 'none', cursor: 'grab', alignItems: 'center', gap: 8, padding: '6px 8px' }}
          onPointerDown={(event) => {
            startY.current = event.clientY;
            (event.target as HTMLElement).setPointerCapture?.(event.pointerId);
          }}
          onPointerMove={(event) => {
            if (startY.current === null) return;
            setDragY(Math.max(0, event.clientY - startY.current));
          }}
          onPointerUp={() => {
            if (dragY > 70) onClose();
            else setDragY(0);
            startY.current = null;
          }}
        >
          <button
            type="button"
            aria-label="Back"
            onClick={onBack ?? onClose}
            className="ib"
            style={{ flexShrink: 0 }}
          >
            <ChevronLeft className="ic" aria-hidden="true" />
          </button>
          <span style={{ height: 4, flex: 1, borderRadius: 999, background: 'transparent' }} aria-hidden="true" />
        </div>
        <div className="inner-scroll" style={{ minHeight: 0, flex: 1, overflowY: 'auto', overflowX: 'hidden', scrollbarWidth: 'none', padding: '0 12px calc(12px + var(--safe-bottom, 0px))' }}>
          {children}
        </div>
      </div>
    </div>,
    document.body,
  );
}
