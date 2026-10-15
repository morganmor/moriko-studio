/**
 * RSA/T board — satu modul untuk SEMUA view sidebar (addon.json contributes.views).
 * Port 1:1 dari design/rsat-panel-pixel.html (markup baris 405–443).
 * State backend: initRsat() memuat rpc('state'), useAddonBus('rsat.changed')
 * menyegarkan saat agent lain mengubah board (R4 — realtime antar sesi).
 */
import { useEffect, useRef, useState } from 'react';
import Canvas from './canvas.tsx';
import Dock from './dock.tsx';
import Drawer from './drawer.tsx';
import { ToastHost } from './toast.tsx';
import Hud from './hud.tsx';
import Topbar from './topbar.tsx';
import LangGate from './langgate.tsx';
import { RSAT_CSS } from './shared.tsx';
import { initRsat, refreshRsat, setLang, useRsat } from './store.tsx';
import { useAddonBus } from '@moriko/host';

/** View ids yang dideklarasikan addon.json (contributes.views). */
const VIEW_IDS = ['overview', 'board', 'tree', 'interlinked', 'activity', 'files', 'settings', 'create'];

export default function Board({ viewName }: { viewName?: string }) {
  const initial = viewName && VIEW_IDS.includes(viewName) ? viewName : 'overview';
  const [view, setView] = useState(initial);
  const [dockOpen, setDockOpen] = useState(false);
  const [sel, setSel] = useState<string | null>(null);
  const board = useRsat();
  const dockRef = useRef<HTMLElement | null>(null);

  // Klik di LUAR area dock (dan di luar tombol toggle-nya) menutup dock.
  useEffect(() => {
    if (!dockOpen) return;
    const onDocDown = (e: PointerEvent) => {
      const el = e.target as HTMLElement | null;
      if (!el) return;
      if (dockRef.current?.contains(el)) return;
      if (el.closest?.('button[aria-label="Toggle dock"]')) return;
      setDockOpen(false);
    };
    document.addEventListener('pointerdown', onDocDown);
    return () => document.removeEventListener('pointerdown', onDocDown);
  }, [dockOpen]);

  // Muat state awal + ikuti event board dari SEMUA sesi (SSE).
  useEffect(() => { void initRsat(); }, []);
  const frame = useAddonBus('rsat.changed');
  useEffect(() => { if (frame) void refreshRsat(); }, [frame]);

  // Navigasi dari sidebar (Base camp / Quest board / …) mengubah viewName.
  useEffect(() => {
    if (viewName && VIEW_IDS.includes(viewName)) setView(viewName);
  }, [viewName]);

  // Papan masih dimuat — hindari kedip LangGate saat state belum kembali.
  if (!board.ready) {
    return (
      <div className="rsat">
        <style dangerouslySetInnerHTML={{ __html: RSAT_CSS }} />
        <div className="gate"><span className="muted">Loading the board…</span></div>
        <ToastHost />
      </div>
    );
  }

  // LangGate (RSAT.txt butir 0): papan tertutup sampai user memilih bahasa.
  if (!board.language) {
    return (
      <div className="rsat">
        <style dangerouslySetInnerHTML={{ __html: RSAT_CSS }} />
        <LangGate onPick={setLang} />
        <ToastHost />
      </div>
    );
  }

  return (
    <div className={`rsat il-q-${board.ilQuality || 'high'}`}>
      <style dangerouslySetInnerHTML={{ __html: RSAT_CSS }} />
      <div className="app">
        <main className="work" aria-label="Canvas (main area)">
          <Topbar view={view} dockOpen={dockOpen} onToggleDock={() => setDockOpen((o) => !o)} />
          <Canvas view={view} onOpen={setSel} />
          <Hud view={view} onView={setView} />
        </main>
        <Dock open={dockOpen} dockRef={dockRef} />
      </div>
      <Drawer sel={sel} onClose={() => setSel(null)} onOpen={setSel} />
      <ToastHost />
    </div>
  );
}
