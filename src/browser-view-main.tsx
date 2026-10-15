/**
 * Browser View panel — the user's live window into the built-in browser.
 *
 * MOUNTED ONLY IN browser-view.html (a separate tab/window the SPA opens) —
 * never inside the chat SPA. The panel is deliberately standalone: no store,
 * no api client, no app CSS dependencies; only React + the WebSocket.
 *
 *   ┌──────────────────────────────────────────────────────┐
 *   │ ● Agent   https://example.com                     ⋯  │  ← slim bar
 *   ├──────────────────────────────────────────────────────┤
 *   │                                                      │
 *   │       <video> WebRTC (tab capture, GPU-encoded)      │  ← live stream
 *   │       harness cursor = blue ring overlay             │
 *   │                                                      │
 *   └──────────────────────────────────────────────────────┘
 *
 * Agent mode:      frames + cursorUpdate/cursorClick render; input ignored.
 * Takeover mode:   the user's mouse/keyboard forward over the WS; the harness
 *                  cursor hides; the OS cursor takes over.
 *
 * VIDEO TRANSPORT: WebRTC P2P — the harness browser's active tab captures
 * itself and streams directly to this panel (Node relays SDP/ICE only).
 * NO CDP screencast exists; there is no fallback path by design.
 *
 * Reconnect: exponential backoff (1s → 2s → 4s → 8s → 16s, capped), so a
 * harness server reload (self-edit resilience) survives the panel too.
 */
import { StrictMode, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';

import './styles/browser-view.css';

/** Default CSS-pixel coordinate space — replaced at runtime by the server's
 *  `viewport` message (dynamic viewport sync). */
const VIEWPORT = { width: 1920, height: 1080 };
/** Live viewport ref — imperative cursor/overlay math reads this. */
const viewportRef = { current: { ...VIEWPORT } };

/** Size .bp-frame to the stage while preserving the viewport aspect ratio —
 *  the video then fills the frame EXACTLY (no stretch, no letterbox), so the
 *  browser renders 1:1 and cursor mapping (rect → viewport) stays correct.
 *  PURELY LOCAL — this never sends anything to the server: the panel is a
 *  passive viewer and must never drive the browser viewport (a feedback loop
 *  here oscillated the canvas dozens of times per second; see ADR-0001). */
function fitFrame(): void {
  const stage = document.querySelector('.bp-stage');
  const frame = document.querySelector<HTMLElement>('.bp-frame');
  if (!stage || !frame) return;
  const vp = viewportRef.current;
  if (!(vp.width > 0) || !(vp.height > 0)) return;
  const scale = Math.min(stage.clientWidth / vp.width, stage.clientHeight / vp.height);
  frame.style.width = `${Math.max(1, Math.floor(vp.width * scale))}px`;
  frame.style.height = `${Math.max(1, Math.floor(vp.height * scale))}px`;
}

type PanelMode = 'agent' | 'takeover';

interface PanelTab {
  id: string;
  url: string;
  title: string;
  active: boolean;
}

interface PanelState {
  mode: PanelMode;
  url: string;
  title: string;
  cursor: { x: number; y: number; visible: boolean };
  userCursor: { x: number; y: number; visible: boolean };
  tabs: PanelTab[];
  connected: boolean;
}

function wsUrl(): string {
  const params = new URLSearchParams(window.location.search);
  const session = params.get('session') ?? '';
  const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  const query = session ? `?session=${encodeURIComponent(session)}` : '';
  return `${proto}//${window.location.host}/api/browser/ws${query}`;
}

function BrowserView() {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const cursorRef = useRef<HTMLDivElement | null>(null);
  const rippleLayerRef = useRef<HTMLDivElement | null>(null);
  const ripplesRef = useRef<number>(0);
  const modeRef = useRef<PanelMode>('agent');
  const [state, setState] = useState<PanelState>({
    mode: 'agent',
    url: '',
    title: '',
    cursor: { x: 0, y: 0, visible: false },
    userCursor: { x: 0, y: 0, visible: false },
    tabs: [],
    connected: false,
  });
  const [drawMode, setDrawMode] = useState(false);

  const sendRef = useRef<((msg: Record<string, unknown>) => void) | null>(null);
  const pcRef = useRef<RTCPeerConnection | null>(null);
  const iceQueueRef = useRef<RTCIceCandidateInit[]>([]);
  const cursorPosRef = useRef({ x: 0, y: 0, visible: false });
  const userCursorPosRef = useRef({ x: 0, y: 0, visible: false });
  const userCursorRef = useRef<HTMLDivElement | null>(null);
  /** WebRTC video transport status shown as overlay + menu info. */
  const [video, setVideo] = useState<{ status: 'connecting' | 'live' | 'error'; msg: string; stats: string }>({
    status: 'connecting',
    msg: '',
    stats: '',
  });

  useEffect(() => {
    let ws: WebSocket | null = null;
    let closed = false;
    let attempt = 0;
    let reconnectTimer: ReturnType<typeof setTimeout> | undefined;

    let resizeTimer: ReturnType<typeof setTimeout> | undefined;
    const onWindowResize = () => {
      if (resizeTimer) clearTimeout(resizeTimer);
      resizeTimer = setTimeout(() => {
        fitFrame();
      }, 150);
    };
    window.addEventListener('resize', onWindowResize);

    const connect = () => {
      if (closed) return;
      ws = new WebSocket(wsUrl());

      ws.onopen = () => {
        attempt = 0;
        setState((s) => ({ ...s, connected: true }));
        ws?.send(JSON.stringify({ type: 'ping' }));
        ws?.send(JSON.stringify({
          type: 'screen-info',
          width: screen.availWidth,
          height: screen.availHeight,
          dpr: window.devicePixelRatio || 1,
        }));
        fitFrame();
      };

      ws.onmessage = (event) => {
        let msg: Record<string, unknown>;
        try {
          msg = JSON.parse(String(event.data)) as Record<string, unknown>;
        } catch {
          return;
        }
        switch (msg.type) {
          case 'shutdown': {
            closed = true;
            if (reconnectTimer) clearTimeout(reconnectTimer);
            if (pcRef.current) {
              pcRef.current.close();
              pcRef.current = null;
            }
            setVideo({ status: 'error', msg: String(msg.reason ?? '') === 'web-access-off' ? 'Web access was turned off.' : 'The browser was closed.', stats: '' });
            setTimeout(() => window.close(), 400);
            break;
          }
          case 'hello': {
            const mode = (msg.mode as PanelMode) ?? 'agent';
            modeRef.current = mode;
            const helloCursor = msg.cursor as { x: number; y: number; visible: boolean } | undefined;
            if (helloCursor) cursorPosRef.current = helloCursor;
            const vp = msg.viewport as { width: number; height: number } | undefined;
            if (vp && vp.width > 0 && vp.height > 0) {
              viewportRef.current = { width: vp.width, height: vp.height };
            }
            fitFrame();
            setState((s) => ({
              ...s,
              mode,
              url: String(msg.url ?? ''),
              title: String(msg.title ?? ''),
              cursor: (msg.cursor as PanelState['cursor']) ?? s.cursor,
              tabs: (msg.tabs as PanelTab[]) ?? [],
            }));
            break;
          }
          case 'statusChange': {
            const mode = (msg.mode as PanelMode) ?? 'agent';
            modeRef.current = mode;
            setState((s) => ({ ...s, mode, url: String(msg.url ?? s.url), title: String(msg.title ?? s.title) }));
            break;
          }
          case 'tabList': {
            setState((s) => ({ ...s, tabs: (msg.tabs as PanelTab[]) ?? [] }));
            break;
          }
          case 'viewport': {
            const vp = msg.viewport as { width: number; height: number } | undefined
              ?? (typeof msg.width === 'number' && typeof msg.height === 'number'
                ? { width: msg.width, height: msg.height }
                : undefined);
            if (vp && vp.width > 0 && vp.height > 0) viewportRef.current = { ...vp };
            fitFrame();
            break;
          }
          case 'cursorUpdate': {
            const cursor = msg.cursor as { x: number; y: number; visible: boolean } | undefined;
            if (!cursor) break;
            cursorPosRef.current = cursor;
            const el = cursorRef.current;
            if (el) {
              el.style.left = `${(cursor.x / viewportRef.current.width) * 100}%`;
              el.style.top = `${(cursor.y / viewportRef.current.height) * 100}%`;
              el.style.opacity = cursor.visible && modeRef.current === 'agent' ? '1' : '0';
            }
            break;
          }
          case 'userCursor': {
            const pos = { x: Number(msg.x) || 0, y: Number(msg.y) || 0, visible: msg.visible !== false };
            userCursorPosRef.current = pos;
            const el = userCursorRef.current;
            if (el) {
              el.style.left = `${(pos.x / viewportRef.current.width) * 100}%`;
              el.style.top = `${(pos.y / viewportRef.current.height) * 100}%`;
              el.style.opacity = pos.visible && modeRef.current === 'agent' ? '1' : '0';
            }
            break;
          }
          case 'annotation': {
            spawnAnnotationRect(Number(msg.x), Number(msg.y), Number(msg.w), Number(msg.h));
            break;
          }
          case 'cursorClick': {
            spawnRipple(Number(msg.x), Number(msg.y));
            break;
          }
          case 'cursorDrag': {
            spawnDragTrail(msg.points as Array<{ x: number; y: number }> | undefined);
            break;
          }
          case 'rtc-offer': {
            const sdp = String(msg.sdp ?? '');
            if (!sdp) break;
            void (async () => {
              try {
                if (pcRef.current) {
                  pcRef.current.close();
                  pcRef.current = null;
                }
                iceQueueRef.current = [];
                setVideo((v) => ({ ...v, status: 'connecting', msg: '' }));
                const pc = new RTCPeerConnection({ iceServers: [] });
                pcRef.current = pc;
                pc.ontrack = (event) => {
                  const vid = videoRef.current;
                  if (vid) vid.srcObject = event.streams[0];
                  setVideo((v) => ({ ...v, status: 'live', msg: '' }));
                };
                pc.onicecandidate = (event) => {
                  if (event.candidate) {
                    ws?.send(JSON.stringify({ type: 'rtc-ice', candidate: event.candidate.toJSON() }));
                  }
                };
                await pc.setRemoteDescription({ type: 'offer', sdp });
                for (const c of iceQueueRef.current.splice(0)) {
                  void pc.addIceCandidate(c).catch(() => undefined);
                }
                const answer = await pc.createAnswer();
                await pc.setLocalDescription(answer);
                ws?.send(JSON.stringify({ type: 'rtc-answer', sdp: pc.localDescription?.sdp ?? '' }));
              } catch {
                ws?.send(JSON.stringify({ type: 'rtc-restart' }));
              }
            })();
            break;
          }
          case 'rtc-ice': {
            const candidate = msg.candidate as RTCIceCandidateInit | undefined;
            if (!candidate) break;
            const pc = pcRef.current;
            if (!pc || !pc.remoteDescription) {
              iceQueueRef.current.push(candidate);
            } else {
              void pc.addIceCandidate(candidate).catch(() => undefined);
            }
            break;
          }
          case 'rtc-state': {
            const st = String(msg.state ?? '');
            if (st === 'connected') {
              setVideo((v) => (v.status === 'connecting' ? { ...v, status: 'live' } : v));
            } else if (st === 'acquiring') {
              setVideo((v) => ({ ...v, status: 'connecting', msg: 'navigating…' }));
            } else if (st === 'acquire-failed') {
              setVideo((v) => ({ ...v, status: 'connecting', msg: String(msg.error ?? '') }));
            } else if (st === 'superseded') {
              setVideo({ status: 'error', msg: 'Video stream moved to another panel window.', stats: '' });
            } else if (st === 'capture-ended') {
              setVideo((v) => ({ ...v, status: 'connecting' }));
              ws?.send(JSON.stringify({ type: 'rtc-restart' }));
            } else if (st === 'failed' || st === 'disconnected' || st === 'closed') {
              setVideo({ status: 'error', msg: `WebRTC ${st}.`, stats: '' });
              ws?.send(JSON.stringify({ type: 'rtc-restart' }));
            }
            break;
          }
          case 'rtc-stats': {
            const parts = [
              typeof msg.fps === 'number' && msg.fps > 0 ? `${msg.fps} fps` : '',
              typeof msg.kbps === 'number' && msg.kbps > 0 ? `${(msg.kbps / 1000).toFixed(1)} Mbps` : '',
              typeof msg.width === 'number' && typeof msg.height === 'number' && msg.width > 0 ? `${msg.width}×${msg.height}` : '',
            ].filter(Boolean);
            if (parts.length) setVideo((v) => ({ ...v, stats: parts.join(' · ') }));
            break;
          }
          case 'rtc-log':
            setVideo((v) => (v.status === 'error' ? v : { ...v, msg: String(msg.text ?? '') }));
            break;
          case 'rtc-error':
            setVideo({ status: 'error', msg: String(msg.error ?? 'Video capture failed.'), stats: '' });
            break;
          case 'pong':
          case 'scrolled':
            break;
          default:
            break;
        }
      };

      ws.onclose = () => {
        setState((s) => ({ ...s, connected: false }));
        if (closed) return;
        attempt += 1;
        const delay = Math.min(1000 * 2 ** Math.min(attempt - 1, 4), 16_000);
        reconnectTimer = setTimeout(connect, delay);
      };
      ws.onerror = () => {
        ws?.close();
      };
    };

    connect();
    sendRef.current = (msg: Record<string, unknown>) => {
      if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
    };

    return () => {
      closed = true;
      if (reconnectTimer) clearTimeout(reconnectTimer);
      window.removeEventListener('resize', onWindowResize);
      sendRef.current = null;
      if (pcRef.current) {
        pcRef.current.close();
        pcRef.current = null;
      }
      ws?.close();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps — wsUrl() is derived
  }, []);

  const spawnAnnotationRect = useCallback((x: number, y: number, w: number, h: number) => {
    const layer = rippleLayerRef.current;
    if (!layer || (w < 4 && h < 4)) return;
    const rect = document.createElement('div');
    rect.className = 'bp-annotation';
    rect.style.left = `${(x / viewportRef.current.width) * 100}%`;
    rect.style.top = `${(y / viewportRef.current.height) * 100}%`;
    rect.style.width = `${(w / viewportRef.current.width) * 100}%`;
    rect.style.height = `${(h / viewportRef.current.height) * 100}%`;
    layer.appendChild(rect);
    setTimeout(() => rect.remove(), 4500);
  }, []);

  const spawnRipple = useCallback((x: number, y: number) => {
    const layer = rippleLayerRef.current;
    if (!layer || ripplesRef.current > 4) return;
    ripplesRef.current += 1;
    const ripple = document.createElement('div');
    ripple.className = 'bp-ripple';
    ripple.style.left = `${(x / viewportRef.current.width) * 100}%`;
    ripple.style.top = `${(y / viewportRef.current.height) * 100}%`;
    layer.appendChild(ripple);
    setTimeout(() => {
      ripple.remove();
      ripplesRef.current = Math.max(0, ripplesRef.current - 1);
    }, 550);
  }, []);

  const spawnDragTrail = useCallback((points?: Array<{ x: number; y: number }>) => {
    const layer = rippleLayerRef.current;
    if (!layer || !points || points.length < 2) return;
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.classList.add('bp-drag-trail');
    svg.setAttribute('viewBox', `0 0 ${viewportRef.current.width} ${viewportRef.current.height}`);
    svg.setAttribute('preserveAspectRatio', 'none');
    const poly = document.createElementNS('http://www.w3.org/2000/svg', 'polyline');
    poly.setAttribute('points', points.map((p) => `${p.x},${p.y}`).join(' '));
    svg.appendChild(poly);
    layer.appendChild(svg);
    setTimeout(() => svg.remove(), 650);
  }, []);

  const toViewport = (clientX: number, clientY: number): { x: number; y: number } => {
    const video = videoRef.current;
    if (!video) return { x: 0, y: 0 };
    const rect = video.getBoundingClientRect();
    const x = ((clientX - rect.left) / rect.width) * viewportRef.current.width;
    const y = ((clientY - rect.top) / rect.height) * viewportRef.current.height;
    return {
      x: Math.min(Math.max(x, 0), viewportRef.current.width),
      y: Math.min(Math.max(y, 0), viewportRef.current.height),
    };
  };

  const drawStartRef = useRef<{ x: number; y: number } | null>(null);
  const drawGhostRef = useRef<HTMLDivElement | null>(null);

  const handleDrawDown = (event: React.MouseEvent) => {
    if (!drawMode) return;
    event.preventDefault();
    event.stopPropagation();
    const { x, y } = toViewport(event.clientX, event.clientY);
    drawStartRef.current = { x, y };
    const ghost = document.createElement('div');
    ghost.className = 'bp-annotation-ghost';
    ghost.style.left = `${(x / viewportRef.current.width) * 100}%`;
    ghost.style.top = `${(y / viewportRef.current.height) * 100}%`;
    ghost.style.width = '0px';
    ghost.style.height = '0px';
    drawGhostRef.current = ghost;
    rippleLayerRef.current?.appendChild(ghost);
  };

  const handleDrawMove = (event: React.MouseEvent) => {
    if (!drawMode || !drawStartRef.current) return;
    const { x, y } = toViewport(event.clientX, event.clientY);
    const start = drawStartRef.current;
    const ghost = drawGhostRef.current;
    if (!ghost) return;
    const x0 = Math.min(start.x, x);
    const y0 = Math.min(start.y, y);
    const w = Math.abs(x - start.x);
    const h = Math.abs(y - start.y);
    ghost.style.left = `${(x0 / viewportRef.current.width) * 100}%`;
    ghost.style.top = `${(y0 / viewportRef.current.height) * 100}%`;
    ghost.style.width = `${(w / viewportRef.current.width) * 100}%`;
    ghost.style.height = `${(h / viewportRef.current.height) * 100}%`;
  };

  const handleDrawUp = (event: React.MouseEvent) => {
    if (!drawMode || !drawStartRef.current) return;
    const { x, y } = toViewport(event.clientX, event.clientY);
    const start = drawStartRef.current;
    const ghost = drawGhostRef.current;
    drawStartRef.current = null;
    ghost?.remove();
    drawGhostRef.current = null;
    const w = Math.abs(x - start.x);
    const h = Math.abs(y - start.y);
    if (w < 8 && h < 8) return;
    const rect = { x: Math.min(start.x, x), y: Math.min(start.y, y), w, h };
    sendRef.current?.({ type: 'annotation', ...rect });
    spawnAnnotationRect(rect.x, rect.y, rect.w, rect.h);
  };

  const handleMouseMove = (event: React.MouseEvent) => {
    if (drawMode) {
      handleDrawMove(event);
      return;
    }
    if (modeRef.current !== 'takeover') {
      const { x, y } = toViewport(event.clientX, event.clientY);
      sendRef.current?.({ type: 'userCursorMove', x, y });
      return;
    }
    const { x, y } = toViewport(event.clientX, event.clientY);
    sendRef.current?.({ type: 'mouseMove', x, y });
  };

  const handleClick = (event: React.MouseEvent) => {
    if (drawMode) {
      handleDrawUp(event);
      return;
    }
    if (modeRef.current !== 'takeover') return;
    if (event.button === 2) {
      const { x, y } = toViewport(event.clientX, event.clientY);
      sendRef.current?.({ type: 'mouseClick', x, y, button: 'right' });
    }
  };

  const handleMouseDown = (event: React.MouseEvent) => {
    if (drawMode) { handleDrawDown(event); return; }
    if (modeRef.current !== 'takeover') return;
    if (event.button !== 0) return;
    const { x, y } = toViewport(event.clientX, event.clientY);
    sendRef.current?.({ type: 'mouseClick', x, y, button: 'left' });
  };

  const handleWheel = (event: React.WheelEvent) => {
    if (modeRef.current !== 'takeover') return;
    event.preventDefault();
    sendRef.current?.({ type: 'scroll', deltaX: event.deltaX, deltaY: event.deltaY });
  };

  const handleKeyDown = (event: React.KeyboardEvent) => {
    if (modeRef.current !== 'takeover') return;
    const target = event.target as HTMLElement;
    const typing = target.tagName === 'INPUT' || target.tagName === 'TEXTAREA';
    if (typing && event.key.length === 1) {
      event.preventDefault();
      sendRef.current?.({ type: 'keyboardType', text: event.key });
      return;
    }
    event.preventDefault();
    sendRef.current?.({ type: 'keyboardPress', key: event.key });
  };

  const focusPanel = () => {
    (videoRef.current?.parentElement as HTMLDivElement | null)?.focus?.();
  };

  const userCursorEl = useMemo(
    () => (
      <div
        ref={userCursorRef}
        className="bp-user-cursor"
        style={{
          left: `${(userCursorPosRef.current.x / viewportRef.current.width) * 100}%`,
          top: `${(userCursorPosRef.current.y / viewportRef.current.height) * 100}%`,
          opacity: userCursorPosRef.current.visible && state.mode === 'agent' ? 1 : 0,
        }}
        aria-hidden="true"
      />
    ),
    [state.mode],
  );

  const cursorEl = useMemo(
    () => (
      <div
        ref={cursorRef}
        className={`bp-cursor${state.mode === 'agent' ? ' bp-cursor-agent' : ' bp-cursor-hidden'}`}
        style={{
          left: `${(cursorPosRef.current.x / viewportRef.current.width) * 100}%`,
          top: `${(cursorPosRef.current.y / viewportRef.current.height) * 100}%`,
          opacity: cursorPosRef.current.visible && state.mode === 'agent' ? 1 : 0,
        }}
        aria-hidden="true"
      />
    ),
    [state.mode],
  );

  const activeTabUrl = state.tabs.find((t) => t.active)?.url ?? state.url;

  const [menuOpen, setMenuOpen] = useState(false);

  return (
    <div className="bp-root" tabIndex={-1} onKeyDown={handleKeyDown} onMouseDown={focusPanel}>
      {}
      <header className="bp-bar">
        <span className={`bp-mode bp-mode-${state.mode}`}>
          <span className="bp-mode-dot" />
          {state.mode === 'agent' ? 'Agent' : 'Takeover'}
        </span>
        <span className="bp-url" title={activeTabUrl}>
          {state.connected ? activeTabUrl || 'about:blank' : 'reconnecting…'}
        </span>
        <span
          className={`bp-conn ${state.connected ? 'bp-conn-ok' : 'bp-conn-down'}`}
          title={state.connected ? 'Connected' : 'Reconnecting…'}
        />
        <div className="bp-menu-wrap">
          <button
            type="button"
            className="bp-kebab"
            aria-label="Panel menu"
            onClick={() => setMenuOpen((open) => !open)}
          >
            ⋯
          </button>
          {menuOpen ? (
            <>
              <div className="bp-backdrop" onClick={() => setMenuOpen(false)} />
              <div className="bp-menu" role="menu">
                {video.stats ? <div className="bp-menu-info">{video.stats}</div> : null}
                <button
                  type="button"
                  className={`bp-menu-item${drawMode ? ' bp-menu-active' : ''}`}
                  role="menuitem"
                  onClick={() => {
                    setDrawMode((d) => !d);
                    setMenuOpen(false);
                  }}
                >
                  {drawMode ? 'Stop drawing' : 'Draw on page'}
                </button>
                <button
                  type="button"
                  className="bp-menu-item"
                  role="menuitem"
                  onClick={() => {
                    setMenuOpen(false);
                    sendRef.current?.({ type: state.mode === 'agent' ? 'takeover' : 'release' });
                  }}
                >
                  {state.mode === 'agent' ? 'Take control' : 'Release to agent'}
                </button>
                <button
                  type="button"
                  className="bp-menu-item bp-menu-danger"
                  role="menuitem"
                  onClick={() => {
                    setMenuOpen(false);
                    window.close();
                  }}
                >
                  Close panel
                </button>
              </div>
            </>
          ) : null}
        </div>
      </header>

      {}
      <main className="bp-stage" onWheel={handleWheel}>
        <div className="bp-frame">
          <video
            ref={videoRef}
            autoPlay
            muted
            playsInline
            className="bp-video"
            onMouseMove={handleMouseMove}
            onMouseDown={handleMouseDown}
            onClick={handleClick}
            onContextMenu={(e) => {
              if (modeRef.current === 'takeover') e.preventDefault();
            }}
          />
          {video.status !== 'live' ? (
            <div className="bp-video-note">
              {video.status === 'error' ? (
                <>
                  <span>{video.msg || 'Video stream error.'}</span>
                  <button
                    type="button"
                    onClick={() => {
                      setVideo((v) => ({ ...v, status: 'connecting', msg: '' }));
                      sendRef.current?.({ type: 'rtc-restart' });
                    }}
                  >
                    Retry
                  </button>
                </>
              ) : (
                <span>{video.msg || 'Loading…'}</span>
              )}
            </div>
          ) : null}
          {cursorEl}
          {userCursorEl}
          <div ref={rippleLayerRef} className="bp-ripples" />
          {state.mode === 'takeover' ? (
            <div className="bp-urlbar">
              <input
                type="text"
                placeholder="Search Google or type a URL"
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    const value = (e.target as HTMLInputElement).value.trim();
                    if (value) sendRef.current?.({ type: 'goto', url: value });
                  }
                  e.stopPropagation();
                }}
              />
            </div>
          ) : null}
        </div>
      </main>
    </div>
  );
}

const container = document.getElementById('root');
if (!container) throw new Error('Root element #root is missing from browser-view.html.');
createRoot(container).render(
  <StrictMode>
    <BrowserView />
  </StrictMode>,
);
