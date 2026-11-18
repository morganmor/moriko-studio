import { StrictMode, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';

import './styles/browser-view.css';

type PanelMode = 'agent' | 'takeover';

interface PanelTab {
  id: string;
  url: string;
  title: string;
  active: boolean;
  loading?: boolean;
}

interface PendingDialogState {
  id: string;
  dialogType: string;
  message: string;
  defaultValue: string;
}

interface PendingFileChooserState {
  id: string;
  multiple: boolean;
}

interface DownloadItem {
  id: string;
  filename: string;
  size?: number;
  downloadUrl?: string;
  error?: string;
  status: 'done' | 'failed';
}

interface ToastMessage {
  id: number;
  text: string;
  kind: 'info' | 'error';
}

interface PanelState {
  mode: PanelMode;
  handoverMessage: string;
  activeUrl: string;
  cursor: { x: number; y: number; visible: boolean };
  userCursor: { x: number; y: number; visible: boolean };
  tabs: PanelTab[];
  loading: boolean;
  connected: boolean;
}

function getSessionParam(): string {
  return new URLSearchParams(window.location.search).get('session') ?? '';
}

function buildWsUrl(): string {
  const session = getSessionParam();
  const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  const query = session ? `?session=${encodeURIComponent(session)}` : '';
  return `${proto}//${window.location.host}/api/browser/ws${query}`;
}

function uint8ToBase64(bytes: Uint8Array): string {
  const CHUNK = 0x8000;
  let binary = '';
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}

function formatBytes(bytes?: number): string {
  if (typeof bytes !== 'number' || !Number.isFinite(bytes)) return '';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function mapMouseButton(btn: number): 'left' | 'middle' | 'right' {
  if (btn === 1) return 'middle';
  if (btn === 2) return 'right';
  return 'left';
}

const MIN_DESKTOP_VIEWPORT_WIDTH = 1280;
const MIN_VIEWPORT_WIDTH = 320;
const MAX_VIEWPORT_WIDTH = 3840;
const MIN_VIEWPORT_HEIGHT = 240;
const MAX_VIEWPORT_HEIGHT = 2160;

/**
 * Computes a desktop-proportioned Playwright viewport (`>= 1280px` wide unless
 * constrained by the vertical 2160px cap) matching `.bp-stage`'s exact aspect
 * ratio so smaller popup windows downscale a full desktop layout cleanly
 * without UI collisions, black bars, or stretched elements.
 */
function computeAspectMatchedViewport(stageWidth: number, stageHeight: number): { width: number; height: number } {
  const safeW = Math.max(1, stageWidth);
  const safeH = Math.max(1, stageHeight);
  const aspect = safeW / safeH;

  let width = Math.max(MIN_DESKTOP_VIEWPORT_WIDTH, safeW);
  let height = width / aspect;

  if (width > MAX_VIEWPORT_WIDTH || height > MAX_VIEWPORT_HEIGHT) {
    const scale = Math.min(MAX_VIEWPORT_WIDTH / width, MAX_VIEWPORT_HEIGHT / height);
    width *= scale;
    height *= scale;
  }

  const alignedW = Math.min(MAX_VIEWPORT_WIDTH, Math.max(MIN_VIEWPORT_WIDTH, Math.round(width / 2) * 2));
  const alignedH = Math.min(MAX_VIEWPORT_HEIGHT, Math.max(MIN_VIEWPORT_HEIGHT, Math.round(alignedW / aspect / 2) * 2));
  return { width: alignedW, height: alignedH };
}

function BrowserView() {
  const rootRef = useRef<HTMLDivElement | null>(null);
  const stageRef = useRef<HTMLElement | null>(null);
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const cursorRef = useRef<HTMLDivElement | null>(null);
  const userCursorRef = useRef<HTMLDivElement | null>(null);
  const rippleLayerRef = useRef<HTMLDivElement | null>(null);
  const omniboxRef = useRef<HTMLInputElement | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  const viewportRef = useRef({ width: 1280, height: 720 });
  const lastSentResizeRef = useRef<{ width: number; height: number } | null>(null);
  const modeRef = useRef<PanelMode>('agent');
  const ripplesRef = useRef(0);
  const omniboxFocusedRef = useRef(false);
  const activeMouseBtnRef = useRef<'left' | 'middle' | 'right' | null>(null);

  const sendRef = useRef<((msg: Record<string, unknown>) => void) | null>(null);
  const pcRef = useRef<RTCPeerConnection | null>(null);
  const iceQueueRef = useRef<RTCIceCandidateInit[]>([]);
  const cursorPosRef = useRef({ x: 0, y: 0, visible: false });
  const userCursorPosRef = useRef({ x: 0, y: 0, visible: false });
  const statsBaselineRef = useRef<{ bytes: number; ts: number } | null>(null);

  const pendingMoveRef = useRef<{ kind: 'mouseMove' | 'userCursorMove'; x: number; y: number } | null>(null);
  const moveRafRef = useRef<number | null>(null);
  const pendingScrollRef = useRef<{ deltaX: number; deltaY: number } | null>(null);
  const scrollRafRef = useRef<number | null>(null);

  const drawStartRef = useRef<{ x: number; y: number } | null>(null);
  const drawGhostRef = useRef<HTMLDivElement | null>(null);

  const [state, setState] = useState<PanelState>({
    mode: 'agent',
    handoverMessage: '',
    activeUrl: '',
    cursor: { x: 0, y: 0, visible: false },
    userCursor: { x: 0, y: 0, visible: false },
    tabs: [],
    loading: false,
    connected: false,
  });
  const [omniboxText, setOmniboxText] = useState('');
  const [drawMode, setDrawMode] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [video, setVideo] = useState<{ status: 'connecting' | 'live' | 'error'; msg: string; stats: string }>({
    status: 'connecting',
    msg: 'Connecting…',
    stats: '',
  });
  const [pendingDialog, setPendingDialog] = useState<PendingDialogState | null>(null);
  const [promptInput, setPromptInput] = useState('');
  const [pendingFileChooser, setPendingFileChooser] = useState<PendingFileChooserState | null>(null);
  const [downloads, setDownloads] = useState<DownloadItem[]>([]);
  const [toast, setToast] = useState<ToastMessage | null>(null);

  const showToast = useCallback((text: string, kind: 'info' | 'error' = 'info') => {
    const id = Date.now() + Math.random();
    setToast({ id, text, kind });
    window.setTimeout(() => {
      setToast((cur) => (cur?.id === id ? null : cur));
    }, 4200);
  }, []);

  const syncOmniboxFromUrl = useCallback((url: string) => {
    if (!omniboxFocusedRef.current) {
      setOmniboxText(url);
    }
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
    window.setTimeout(() => rect.remove(), 4500);
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
    window.setTimeout(() => {
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
    window.setTimeout(() => svg.remove(), 650);
  }, []);

  const toViewport = useCallback((clientX: number, clientY: number): { x: number; y: number } => {
    const targetEl = videoRef.current ?? stageRef.current;
    if (!targetEl) return { x: 0, y: 0 };
    const rect = targetEl.getBoundingClientRect();
    if (!(rect.width > 0) || !(rect.height > 0)) return { x: 0, y: 0 };
    const x = ((clientX - rect.left) / rect.width) * viewportRef.current.width;
    const y = ((clientY - rect.top) / rect.height) * viewportRef.current.height;
    return {
      x: Math.min(Math.max(x, 0), viewportRef.current.width),
      y: Math.min(Math.max(y, 0), viewportRef.current.height),
    };
  }, []);

  const syncCursorPositions = useCallback(() => {
    const vp = viewportRef.current;
    if (!(vp.width > 0) || !(vp.height > 0)) return;
    const cEl = cursorRef.current;
    if (cEl) {
      const c = cursorPosRef.current;
      cEl.style.left = `${(c.x / vp.width) * 100}%`;
      cEl.style.top = `${(c.y / vp.height) * 100}%`;
      cEl.style.opacity = c.visible && modeRef.current === 'agent' ? '1' : '0';
    }
    const uEl = userCursorRef.current;
    if (uEl) {
      const u = userCursorPosRef.current;
      uEl.style.left = `${(u.x / vp.width) * 100}%`;
      uEl.style.top = `${(u.y / vp.height) * 100}%`;
      uEl.style.opacity = u.visible && modeRef.current === 'agent' ? '1' : '0';
    }
  }, []);

  // Measure only the outer .bp-stage wrapper so <video> intrinsic size cannot feedback-lock layout.
  const pushStageViewport = useCallback((force = false) => {
    const stage = stageRef.current;
    if (!stage) return;
    const stageWidth = stage.clientWidth;
    const stageHeight = stage.clientHeight;
    if (!(stageWidth > 0) || !(stageHeight > 0)) return;
    const { width, height } = computeAspectMatchedViewport(stageWidth, stageHeight);
    const prev = lastSentResizeRef.current;
    if (!force && prev && prev.width === width && prev.height === height) return;
    lastSentResizeRef.current = { width, height };
    viewportRef.current = { width, height };
    syncCursorPositions();
    sendRef.current?.({ type: 'resize', width, height });
  }, [syncCursorPositions]);

  // Main WebSocket + WebRTC lifecycle
  useEffect(() => {
    let ws: WebSocket | null = null;
    let closed = false;
    let attempt = 0;
    let reconnectTimer: ReturnType<typeof setTimeout> | undefined;

    const connect = () => {
      if (closed) return;
      ws = new WebSocket(buildWsUrl());

      ws.onopen = () => {
        attempt = 0;
        lastSentResizeRef.current = null;
        setState((s) => ({ ...s, connected: true }));
        ws?.send(JSON.stringify({ type: 'ping' }));
        pushStageViewport(true);
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
            setVideo({
              status: 'error',
              msg: String(msg.reason ?? '') === 'web-access-off' ? 'Web access was turned off.' : 'The browser was closed.',
              stats: '',
            });
            window.setTimeout(() => window.close(), 400);
            break;
          }
          case 'hello': {
            const mode = (msg.mode as PanelMode) ?? 'agent';
            modeRef.current = mode;
            const helloCursor = msg.cursor as { x: number; y: number; visible: boolean } | undefined;
            if (helloCursor) cursorPosRef.current = helloCursor;

            const vp = msg.viewport as { width: number; height: number } | undefined;
            const st = stageRef.current;
            if ((!st || !(st.clientWidth > 0) || !(st.clientHeight > 0)) && vp && vp.width > 0 && vp.height > 0) {
              viewportRef.current = { width: vp.width, height: vp.height };
              syncCursorPositions();
            }
            // Reconcile server viewport immediately with current .bp-stage geometry
            pushStageViewport(true);

            const tabs = (msg.tabs as PanelTab[]) ?? [];
            const activeTab = tabs.find((t) => t.active) ?? tabs[0];
            const activeUrl = activeTab?.url ?? '';
            syncOmniboxFromUrl(activeUrl);

            const pDialog = msg.pendingDialog as PendingDialogState | null | undefined;
            if (pDialog) {
              setPendingDialog(pDialog);
              setPromptInput(pDialog.defaultValue ?? '');
            } else {
              setPendingDialog(null);
            }

            const pChooser = msg.pendingFileChooser as PendingFileChooserState | null | undefined;
            setPendingFileChooser(pChooser ?? null);

            setState((s) => ({
              ...s,
              mode,
              handoverMessage: String(msg.handoverMessage ?? ''),
              activeUrl,
              cursor: helloCursor ?? s.cursor,
              tabs,
              loading: Boolean(activeTab?.loading),
            }));
            break;
          }
          case 'statusChange': {
            const mode = (msg.mode as PanelMode) ?? 'agent';
            modeRef.current = mode;
            const handoverMessage = typeof msg.message === 'string' ? msg.message : '';
            setState((s) => ({
              ...s,
              mode,
              handoverMessage,
              activeUrl: typeof msg.url === 'string' ? msg.url : s.activeUrl,
            }));
            if (typeof msg.url === 'string') syncOmniboxFromUrl(msg.url);
            break;
          }
          case 'tabList': {
            const tabs = (msg.tabs as PanelTab[]) ?? [];
            const activeTab = tabs.find((t) => t.active) ?? tabs[0];
            const activeUrl = activeTab?.url ?? '';
            syncOmniboxFromUrl(activeUrl);
            setState((s) => ({
              ...s,
              tabs,
              activeUrl: activeUrl || s.activeUrl,
              loading: Boolean(activeTab?.loading),
            }));
            break;
          }
          case 'nav-state': {
            const loading = msg.loading === true;
            const url = typeof msg.url === 'string' ? msg.url : '';
            if (url) syncOmniboxFromUrl(url);
            setState((s) => ({
              ...s,
              loading,
              activeUrl: url || s.activeUrl,
            }));
            break;
          }
          case 'viewport': {
            const width = Number(msg.width);
            const height = Number(msg.height);
            if (Number.isFinite(width) && Number.isFinite(height) && width > 0 && height > 0) {
              viewportRef.current = { width, height };
              syncCursorPositions();
            }
            break;
          }
          case 'cursorUpdate': {
            const cursor = msg.cursor as { x: number; y: number; visible: boolean } | undefined;
            if (!cursor) break;
            cursorPosRef.current = cursor;
            syncCursorPositions();
            break;
          }
          case 'userCursor': {
            const pos = { x: Number(msg.x) || 0, y: Number(msg.y) || 0, visible: msg.visible !== false };
            userCursorPosRef.current = pos;
            syncCursorPositions();
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
          case 'clipboard-copy': {
            const text = typeof msg.text === 'string' ? msg.text : '';
            if (text) {
              void navigator.clipboard?.writeText(text).then(
                () => showToast('Copied page selection to clipboard.'),
                () => showToast('Could not write to clipboard.', 'error'),
              );
            }
            break;
          }
          case 'dialog-open': {
            const dlg: PendingDialogState = {
              id: String(msg.id ?? ''),
              dialogType: String(msg.dialogType ?? 'alert'),
              message: String(msg.message ?? ''),
              defaultValue: String(msg.defaultValue ?? ''),
            };
            setPendingDialog(dlg);
            setPromptInput(dlg.defaultValue);
            break;
          }
          case 'dialog-closed': {
            const id = String(msg.id ?? '');
            setPendingDialog((cur) => (!id || cur?.id === id ? null : cur));
            break;
          }
          case 'file-chooser': {
            const chooser: PendingFileChooserState = {
              id: String(msg.id ?? ''),
              multiple: msg.multiple === true,
            };
            setPendingFileChooser(chooser);
            // Trigger native picker automatically when possible; floating bar remains as fallback
            window.setTimeout(() => {
              try {
                fileInputRef.current?.click();
              } catch {
              }
            }, 0);
            break;
          }
          case 'file-chooser-closed': {
            const id = String(msg.id ?? '');
            setPendingFileChooser((cur) => (!id || cur?.id === id ? null : cur));
            break;
          }
          case 'download-complete': {
            const item: DownloadItem = {
              id: String(msg.id ?? ''),
              filename: String(msg.filename ?? 'download.bin'),
              size: typeof msg.size === 'number' ? msg.size : undefined,
              downloadUrl: typeof msg.downloadUrl === 'string' ? msg.downloadUrl : undefined,
              status: 'done',
            };
            setDownloads((prev) => [item, ...prev.filter((d) => d.id !== item.id)].slice(0, 6));
            showToast(`Downloaded ${item.filename}`);
            break;
          }
          case 'download-failed': {
            const item: DownloadItem = {
              id: String(msg.id ?? ''),
              filename: String(msg.filename ?? 'download'),
              error: String(msg.error ?? 'Download failed'),
              status: 'failed',
            };
            setDownloads((prev) => [item, ...prev.filter((d) => d.id !== item.id)].slice(0, 6));
            showToast(`Download failed: ${item.filename}`, 'error');
            break;
          }
          case 'error': {
            const text = String(msg.message ?? 'Browser panel error');
            showToast(text, 'error');
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
                statsBaselineRef.current = null;
                iceQueueRef.current = [];
                setVideo((v) => ({ ...v, status: 'connecting', msg: '' }));
                const pc = new RTCPeerConnection({ iceServers: [] });
                pcRef.current = pc;
                pc.ontrack = (e) => {
                  const vid = videoRef.current;
                  if (vid) {
                    vid.srcObject = e.streams[0] ?? new MediaStream([e.track]);
                    void vid.play().catch(() => undefined);
                  }
                  setVideo((v) => ({ ...v, status: 'live', msg: '' }));
                };
                pc.onicecandidate = (e) => {
                  if (e.candidate && ws?.readyState === WebSocket.OPEN) {
                    ws.send(JSON.stringify({ type: 'rtc-ice', candidate: e.candidate.toJSON() }));
                  }
                };
                await pc.setRemoteDescription({ type: 'offer', sdp });
                for (const c of iceQueueRef.current.splice(0)) {
                  void pc.addIceCandidate(c).catch(() => undefined);
                }
                const answer = await pc.createAnswer();
                await pc.setLocalDescription(answer);
                if (ws?.readyState === WebSocket.OPEN) {
                  ws.send(JSON.stringify({ type: 'rtc-answer', sdp: pc.localDescription?.sdp ?? '' }));
                }
              } catch {
                if (ws?.readyState === WebSocket.OPEN) {
                  ws.send(JSON.stringify({ type: 'rtc-restart' }));
                }
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
              setVideo((v) => (v.status === 'connecting' ? { ...v, status: 'live', msg: '' } : v));
            } else if (st === 'acquiring') {
              setVideo((v) => ({ ...v, status: 'connecting', msg: 'Capturing tab…' }));
            } else if (st === 'acquire-failed') {
              setVideo((v) => ({ ...v, status: 'connecting', msg: String(msg.error ?? 'Retrying capture…') }));
            } else if (st === 'superseded') {
              setVideo({ status: 'error', msg: 'Video stream moved to another panel window.', stats: '' });
            } else if (st === 'capture-ended') {
              setVideo((v) => ({ ...v, status: 'connecting', msg: 'Reconnecting stream…' }));
              ws?.send(JSON.stringify({ type: 'rtc-restart' }));
            } else if (st === 'failed' || st === 'disconnected' || st === 'closed') {
              setVideo({ status: 'error', msg: `WebRTC ${st}.`, stats: '' });
              ws?.send(JSON.stringify({ type: 'rtc-restart' }));
            }
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
        reconnectTimer = window.setTimeout(connect, delay);
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
      sendRef.current = null;
      if (pcRef.current) {
        pcRef.current.close();
        pcRef.current = null;
      }
      ws?.close();
    };
  }, [pushStageViewport, showToast, spawnAnnotationRect, spawnDragTrail, spawnRipple, syncCursorPositions, syncOmniboxFromUrl]);

  // Observe .bp-stage directly with debounce (~50ms) so Playwright viewport matches aspect ratio
  useEffect(() => {
    const stage = stageRef.current;
    if (!stage) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const ro = new ResizeObserver(() => {
      if (timer) clearTimeout(timer);
      timer = window.setTimeout(() => {
        pushStageViewport(false);
      }, 50);
    });
    ro.observe(stage);
    pushStageViewport(false);
    return () => {
      if (timer) clearTimeout(timer);
      ro.disconnect();
    };
  }, [pushStageViewport]);

  // Poll client-side RTCPeerConnection stats every 1.5s instead of running getStats() inside target page DOM
  useEffect(() => {
    const timer = window.setInterval(() => {
      const pc = pcRef.current;
      if (!pc || pc.connectionState !== 'connected') return;
      void pc.getStats().then((report) => {
        let fps = 0;
        let width = videoRef.current?.videoWidth ?? 0;
        let height = videoRef.current?.videoHeight ?? 0;
        let kbps = 0;

        for (const stat of report.values()) {
          if (stat.type === 'inbound-rtp' && (stat as RTCInboundRtpStreamStats).kind === 'video') {
            const inbound = stat as RTCInboundRtpStreamStats & {
              frameWidth?: number;
              frameHeight?: number;
              framesPerSecond?: number;
              bytesReceived?: number;
            };
            if (typeof inbound.framesPerSecond === 'number') fps = Math.round(inbound.framesPerSecond);
            if (typeof inbound.frameWidth === 'number' && inbound.frameWidth > 0) width = inbound.frameWidth;
            if (typeof inbound.frameHeight === 'number' && inbound.frameHeight > 0) height = inbound.frameHeight;
            if (typeof inbound.bytesReceived === 'number') {
              const now = performance.now();
              const prev = statsBaselineRef.current;
              if (prev && now > prev.ts && inbound.bytesReceived >= prev.bytes) {
                kbps = Math.round(((inbound.bytesReceived - prev.bytes) * 8) / (now - prev.ts));
              }
              statsBaselineRef.current = { bytes: inbound.bytesReceived, ts: now };
            }
          }
        }

        const parts = [
          width > 0 && height > 0 ? `${width}×${height}` : '',
          fps > 0 ? `${fps} fps` : '',
          kbps > 0 ? `${kbps >= 1000 ? `${(kbps / 1000).toFixed(1)} Mbps` : `${kbps} kbps`}` : '',
        ].filter(Boolean);
        if (parts.length > 0) {
          setVideo((v) => (v.stats === parts.join(' · ') ? v : { ...v, stats: parts.join(' · ') }));
        }
      }).catch(() => undefined);
    }, 1500);
    return () => clearInterval(timer);
  }, []);

  // Non-passive wheel listener on .bp-stage coalesced by rAF so scroll never triggers browser passive warning
  useEffect(() => {
    const stage = stageRef.current;
    if (!stage) return;
    const onWheel = (event: WheelEvent) => {
      if (modeRef.current !== 'takeover') return;
      event.preventDefault();
      if (pendingScrollRef.current) {
        pendingScrollRef.current.deltaX += event.deltaX;
        pendingScrollRef.current.deltaY += event.deltaY;
      } else {
        pendingScrollRef.current = { deltaX: event.deltaX, deltaY: event.deltaY };
      }
      if (scrollRafRef.current === null) {
        scrollRafRef.current = window.requestAnimationFrame(() => {
          scrollRafRef.current = null;
          const delta = pendingScrollRef.current;
          pendingScrollRef.current = null;
          if (delta) {
            sendRef.current?.({ type: 'scroll', deltaX: delta.deltaX, deltaY: delta.deltaY });
          }
        });
      }
    };
    stage.addEventListener('wheel', onWheel, { passive: false });
    return () => {
      stage.removeEventListener('wheel', onWheel);
      if (scrollRafRef.current !== null) {
        cancelAnimationFrame(scrollRafRef.current);
        scrollRafRef.current = null;
      }
    };
  }, []);

  // Release held mouse buttons cleanly if cursor leaves window before mouseup
  useEffect(() => {
    const onWindowMouseUp = (event: MouseEvent) => {
      if (!activeMouseBtnRef.current) return;
      const btn = activeMouseBtnRef.current;
      activeMouseBtnRef.current = null;
      if (modeRef.current !== 'takeover') return;
      const { x, y } = toViewport(event.clientX, event.clientY);
      sendRef.current?.({ type: 'mouseUp', x, y, button: btn });
    };
    window.addEventListener('mouseup', onWindowMouseUp);
    return () => window.removeEventListener('mouseup', onWindowMouseUp);
  }, [toViewport]);

  const queuePointerMove = useCallback((kind: 'mouseMove' | 'userCursorMove', x: number, y: number) => {
    pendingMoveRef.current = { kind, x, y };
    if (moveRafRef.current === null) {
      moveRafRef.current = window.requestAnimationFrame(() => {
        moveRafRef.current = null;
        const next = pendingMoveRef.current;
        pendingMoveRef.current = null;
        if (next) sendRef.current?.({ type: next.kind, x: next.x, y: next.y });
      });
    }
  }, []);

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

  const handleVideoMouseMove = (event: React.MouseEvent) => {
    if (drawMode) {
      handleDrawMove(event);
      return;
    }
    const { x, y } = toViewport(event.clientX, event.clientY);
    queuePointerMove(modeRef.current === 'takeover' ? 'mouseMove' : 'userCursorMove', x, y);
  };

  const handleVideoMouseDown = (event: React.MouseEvent) => {
    rootRef.current?.focus();
    if (drawMode) {
      handleDrawDown(event);
      return;
    }
    if (modeRef.current !== 'takeover') return;
    event.preventDefault();
    const button = mapMouseButton(event.button);
    activeMouseBtnRef.current = button;
    const { x, y } = toViewport(event.clientX, event.clientY);
    sendRef.current?.({ type: 'mouseDown', x, y, button });
  };

  const handleVideoMouseUp = (event: React.MouseEvent) => {
    if (drawMode) {
      handleDrawUp(event);
      return;
    }
    if (modeRef.current !== 'takeover') return;
    const button = activeMouseBtnRef.current ?? mapMouseButton(event.button);
    activeMouseBtnRef.current = null;
    const { x, y } = toViewport(event.clientX, event.clientY);
    sendRef.current?.({ type: 'mouseUp', x, y, button });
  };

  const handleKeyDown = (event: React.KeyboardEvent) => {
    const target = event.target as HTMLElement;
    if (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA') return;
    if (pendingDialog) return;
    if (modeRef.current !== 'takeover') return;

    const mod = event.ctrlKey || event.metaKey;
    if (mod && !event.altKey && event.key.toLowerCase() === 'v') {
      // Allow browser's native onPaste handler on .bp-root to deliver clipboard text cleanly
      return;
    }
    if (mod && !event.altKey && event.key.toLowerCase() === 'c') {
      sendRef.current?.({ type: 'clipboard-copy-req' });
      sendRef.current?.({
        type: 'keyboardPress',
        key: 'c',
        ctrlKey: event.ctrlKey,
        altKey: event.altKey,
        shiftKey: event.shiftKey,
        metaKey: event.metaKey,
      });
      event.preventDefault();
      return;
    }

    if (!event.ctrlKey && !event.altKey && !event.metaKey && event.key.length === 1) {
      event.preventDefault();
      sendRef.current?.({ type: 'keyboardType', text: event.key });
      return;
    }

    event.preventDefault();
    sendRef.current?.({
      type: 'keyboardPress',
      key: event.key === ' ' ? 'Space' : event.key,
      ctrlKey: event.ctrlKey,
      altKey: event.altKey,
      shiftKey: event.shiftKey,
      metaKey: event.metaKey,
    });
  };

  const handlePaste = (event: React.ClipboardEvent) => {
    const target = event.target as HTMLElement;
    if (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA') return;
    if (modeRef.current !== 'takeover') return;
    const text = event.clipboardData?.getData('text/plain') ?? '';
    if (!text) return;
    event.preventDefault();
    sendRef.current?.({ type: 'paste', text });
  };

  const handleOmniboxSubmit = (event: React.FormEvent) => {
    event.preventDefault();
    const raw = omniboxText.trim();
    if (!raw) return;
    sendRef.current?.({ type: 'goto', url: raw });
    omniboxRef.current?.blur();
    rootRef.current?.focus();
  };

  const handleDialogRespond = (accept: boolean) => {
    if (!pendingDialog) return;
    sendRef.current?.({
      type: 'dialog-response',
      id: pendingDialog.id,
      accept,
      promptText: pendingDialog.dialogType === 'prompt' ? promptInput : undefined,
    });
    setPendingDialog(null);
  };

  const handleFileInputChange = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const chooser = pendingFileChooser;
    const fileList = event.target.files;
    event.target.value = '';
    if (!chooser) return;
    if (!fileList || fileList.length === 0) {
      sendRef.current?.({ type: 'file-chooser-cancel', id: chooser.id });
      setPendingFileChooser(null);
      return;
    }
    try {
      const selected = Array.from(fileList).slice(0, 10);
      const totalBytes = selected.reduce((sum, f) => sum + f.size, 0);
      if (totalBytes > 22 * 1024 * 1024) {
        showToast('Selected files exceed 22 MB transfer limit.', 'error');
        return;
      }
      const encoded = await Promise.all(
        selected.map(async (file) => ({
          name: file.name,
          mimeType: file.type || 'application/octet-stream',
          bufferBase64: uint8ToBase64(new Uint8Array(await file.arrayBuffer())),
        })),
      );
      sendRef.current?.({ type: 'file-chooser-upload', id: chooser.id, files: encoded });
      setPendingFileChooser(null);
    } catch {
      showToast('Failed to read selected file(s).', 'error');
    }
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

  const isHttps = /^https:\/\//i.test(state.activeUrl);

  return (
    <div
      ref={rootRef}
      className="bp-root"
      tabIndex={-1}
      onKeyDown={handleKeyDown}
      onPaste={handlePaste}
    >
      {/* Multi-tab strip */}
      <div className="bp-tabstrip">
        <div className="bp-tabs" role="tablist" aria-label="Browser tabs">
          {state.tabs.map((tab) => {
            const label = tab.title?.trim() || tab.url?.replace(/^https?:\/\//i, '').split('/')[0] || 'New Tab';
            return (
              <div
                key={tab.id}
                role="tab"
                aria-selected={tab.active}
                className={`bp-tab${tab.active ? ' active' : ''}`}
                onClick={() => sendRef.current?.({ type: 'switch-tab', tabId: tab.id })}
              >
                {tab.loading ? (
                  <span className="bp-tab-spin" aria-hidden="true" />
                ) : (
                  <span className="bp-tab-indicator" aria-hidden="true" />
                )}
                <span className="bp-tab-title">{label}</span>
                <button
                  type="button"
                  className="bp-tab-close"
                  aria-label={`Close ${label}`}
                  onClick={(e) => {
                    e.stopPropagation();
                    sendRef.current?.({ type: 'close-tab', tabId: tab.id });
                  }}
                >
                  ×
                </button>
              </div>
            );
          })}
          <button
            type="button"
            className="bp-tab-add"
            aria-label="New tab"
            onClick={() => sendRef.current?.({ type: 'new-tab' })}
          >
            +
          </button>
        </div>

        <div className="bp-tabstrip-meta">
          {video.stats ? <span className="bp-stats">{video.stats}</span> : null}
          <span
            className={`bp-conn ${state.connected ? 'bp-conn-ok' : 'bp-conn-down'}`}
            aria-label={state.connected ? 'Connected' : 'Reconnecting'}
          />
        </div>
      </div>

      {/* Navigation toolbar + synchronized omnibox */}
      <header className="bp-toolbar">
        <div className="bp-nav-btns">
          <button
            type="button"
            className="bp-icon-btn"
            aria-label="Back"
            onClick={() => sendRef.current?.({ type: 'back' })}
          >
            ←
          </button>
          <button
            type="button"
            className="bp-icon-btn"
            aria-label="Forward"
            onClick={() => sendRef.current?.({ type: 'forward' })}
          >
            →
          </button>
          <button
            type="button"
            className="bp-icon-btn"
            aria-label={state.loading ? 'Stop loading' : 'Reload'}
            onClick={() => sendRef.current?.({ type: state.loading ? 'stop' : 'reload' })}
          >
            {state.loading ? '✕' : '↻'}
          </button>
        </div>

        <form className="bp-omnibox" onSubmit={handleOmniboxSubmit}>
          <span className={`bp-omnibox-scheme${isHttps ? ' secure' : ''}`}>
            {isHttps ? 'HTTPS' : 'URL'}
          </span>
          <input
            ref={omniboxRef}
            type="text"
            value={omniboxText}
            aria-label="Address bar"
            placeholder={state.connected ? 'Enter URL and press Enter' : 'Reconnecting…'}
            onFocus={(e) => {
              omniboxFocusedRef.current = true;
              e.currentTarget.select();
            }}
            onBlur={() => {
              omniboxFocusedRef.current = false;
              setOmniboxText(state.activeUrl);
            }}
            onChange={(e) => setOmniboxText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Escape') {
                setOmniboxText(state.activeUrl);
                e.currentTarget.blur();
                rootRef.current?.focus();
              }
            }}
          />
        </form>

        <span className={`bp-mode bp-mode-${state.mode}`}>
          <span className="bp-mode-dot" />
          {state.mode === 'agent' ? 'Agent' : 'Takeover'}
        </span>

        <button
          type="button"
          className={`bp-takeover-btn${state.mode === 'takeover' ? ' active' : ''}`}
          onClick={() => {
            if (state.mode === 'takeover') {
              sendRef.current?.({ type: 'release' });
            } else {
              setDrawMode(false);
              sendRef.current?.({ type: 'takeover' });
            }
          }}
        >
          {state.mode === 'takeover' ? 'Hand Back to Agent' : 'Take Control'}
        </button>

        <div className="bp-menu-wrap">
          <button
            type="button"
            className="bp-kebab"
            aria-label="Panel options"
            onClick={() => setMenuOpen((open) => !open)}
          >
            ⋮
          </button>
          {menuOpen ? (
            <>
              <div className="bp-backdrop" onClick={() => setMenuOpen(false)} />
              <div className="bp-menu" role="menu">
                {video.stats ? <div className="bp-menu-info">{video.stats}</div> : null}
                <button
                  type="button"
                  className="bp-menu-item"
                  role="menuitem"
                  onClick={() => {
                    setMenuOpen(false);
                    if (state.activeUrl) {
                      void navigator.clipboard?.writeText(state.activeUrl).then(
                        () => showToast('URL copied.'),
                        () => showToast('Could not copy URL.', 'error'),
                      );
                    }
                  }}
                >
                  Copy URL
                </button>
                <button
                  type="button"
                  className={`bp-menu-item${drawMode ? ' bp-menu-active' : ''}`}
                  role="menuitem"
                  onClick={() => {
                    setDrawMode((d) => !d);
                    setMenuOpen(false);
                  }}
                >
                  {drawMode ? 'Stop annotating' : 'Annotate for agent'}
                </button>
                <button
                  type="button"
                  className="bp-menu-item"
                  role="menuitem"
                  onClick={() => {
                    setMenuOpen(false);
                    setVideo((v) => ({ ...v, status: 'connecting', msg: 'Restarting stream…' }));
                    sendRef.current?.({ type: 'rtc-restart' });
                  }}
                >
                  Restart video stream
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

        <div className={`bp-progress${state.loading ? ' active' : ''}`} aria-hidden="true" />
      </header>

      {/* Agent handover prompt banner */}
      {state.mode === 'takeover' && state.handoverMessage ? (
        <div className="bp-handover-banner">
          <div className="bp-handover-msg">{state.handoverMessage}</div>
          <button
            type="button"
            className="bp-handover-done"
            onClick={() => sendRef.current?.({ type: 'release' })}
          >
            Done — Hand Back
          </button>
        </div>
      ) : null}

      {/* File chooser upload fallback bar */}
      {pendingFileChooser ? (
        <div className="bp-file-bar">
          <span>The page opened a file upload chooser ({pendingFileChooser.multiple ? 'multiple files' : 'single file'}).</span>
          <div className="bp-file-bar-actions">
            <button
              type="button"
              className="bp-btn bp-btn-primary"
              onClick={() => fileInputRef.current?.click()}
            >
              Choose File
            </button>
            <button
              type="button"
              className="bp-btn"
              onClick={() => {
                sendRef.current?.({ type: 'file-chooser-cancel', id: pendingFileChooser.id });
                setPendingFileChooser(null);
              }}
            >
              Cancel
            </button>
          </div>
        </div>
      ) : null}

      <input
        ref={fileInputRef}
        type="file"
        hidden
        multiple={pendingFileChooser?.multiple === true}
        onChange={(e) => {
          void handleFileInputChange(e);
        }}
      />

      {/* 1:1 viewport-synchronized video stage */}
      <main ref={stageRef} className="bp-stage">
        <div className={`bp-frame${state.mode === 'takeover' ? ' takeover' : ''}`}>
          <video
            ref={videoRef}
            autoPlay
            muted
            playsInline
            onMouseMove={handleVideoMouseMove}
            onMouseDown={handleVideoMouseDown}
            onMouseUp={handleVideoMouseUp}
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
                      setVideo((v) => ({ ...v, status: 'connecting', msg: 'Retrying…' }));
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
        </div>
      </main>

      {/* Download shelf */}
      {downloads.length > 0 ? (
        <div className="bp-downloads">
          {downloads.map((d) => (
            <div key={d.id} className={`bp-download-chip${d.status === 'failed' ? ' failed' : ''}`}>
              {d.status === 'done' && d.downloadUrl ? (
                <a href={d.downloadUrl} download={d.filename}>
                  ↓ {d.filename}
                </a>
              ) : (
                <span>✕ {d.filename}</span>
              )}
              {d.size !== undefined ? <span>{formatBytes(d.size)}</span> : null}
              <button
                type="button"
                className="bp-download-dismiss"
                aria-label={`Dismiss ${d.filename}`}
                onClick={() => setDownloads((prev) => prev.filter((item) => item.id !== d.id))}
              >
                ×
              </button>
            </div>
          ))}
        </div>
      ) : null}

      {/* Native alert / confirm / prompt modal */}
      {pendingDialog ? (
        <div className="bp-modal-backdrop" role="dialog" aria-modal="true">
          <div className="bp-modal">
            <div className="bp-modal-title">
              Page {pendingDialog.dialogType}
            </div>
            <div className="bp-modal-msg">{pendingDialog.message || '(Empty message)'}</div>
            {pendingDialog.dialogType === 'prompt' ? (
              <input
                type="text"
                className="bp-modal-input"
                autoFocus
                value={promptInput}
                onChange={(e) => setPromptInput(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') handleDialogRespond(true);
                  if (e.key === 'Escape') handleDialogRespond(false);
                }}
              />
            ) : null}
            <div className="bp-modal-actions">
              {pendingDialog.dialogType !== 'alert' ? (
                <button
                  type="button"
                  className="bp-btn"
                  onClick={() => handleDialogRespond(false)}
                >
                  Cancel
                </button>
              ) : null}
              <button
                type="button"
                className="bp-btn bp-btn-primary"
                onClick={() => handleDialogRespond(true)}
              >
                OK
              </button>
            </div>
          </div>
        </div>
      ) : null}

      {/* Toast message */}
      {toast ? (
        <div className={`bp-toast${toast.kind === 'error' ? ' error' : ''}`}>
          {toast.text}
        </div>
      ) : null}
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
