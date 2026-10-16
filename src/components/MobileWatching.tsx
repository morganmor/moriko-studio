/**
 * MobileWatching — bottom-left button (right of day/night) that downloads
 * cloudflared (skipped when present) and opens a Quick Tunnel to the running
 * web dev port. The popover shows a QR + link so another device can join.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { Check, Copy, Loader2 } from './icons';
import { DIcon } from './designIcons';
import { Tip, cx } from './ui';
import { Popover } from './Popover';
import {
  fetchInstallProgress,
  fetchWatchStatus,
  installWatch,
  startWatch,
  stopWatch,
  watchQrUrl,
  type WatchInstallProgress,
  type WatchStatus,
} from '../lib/watchApi';

const POLL_MS = 2000;

export function MobileWatching() {
  const [open, setOpen] = useState(false);
  const [status, setStatus] = useState<WatchStatus | null>(null);
  const [target, setTarget] = useState('');
  const [port, setPort] = useState('');
  const [busy, setBusy] = useState<'install' | 'start' | 'stop' | null>(null);
  const [progress, setProgress] = useState<WatchInstallProgress | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const buttonRef = useRef<HTMLButtonElement>(null);

  const refresh = useCallback(async () => {
    try {
      const next = await fetchWatchStatus();
      setStatus(next);
      setTarget((prev) => prev || next.hostTarget);
      setPort((prev) => prev || String(next.tunnel.port ?? next.ports[0]?.port ?? 5588));
    } catch {
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const running = Boolean(status?.tunnel.running);
  useEffect(() => {
    if (!open && !running) return;
    const timer = window.setInterval(() => void refresh(), POLL_MS);
    return () => window.clearInterval(timer);
  }, [open, running]);

  const selectedTarget = status?.targets.find((t) => t.id === target) ?? null;
  const portValue = Number(port);
  const portValid = Number.isInteger(portValue) && portValue > 0 && portValue <= 65535;

  const handleDownload = async () => {
    setBusy('install');
    setError(null);
    setProgress(null);
    const timer = window.setInterval(() => {
      void fetchInstallProgress()
        .then(setProgress)
        .catch(() => undefined);
    }, 700);
    try {
      await installWatch(target);
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      window.clearInterval(timer);
      setProgress(null);
      setBusy(null);
    }
  };

  const handleStart = async () => {
    if (!portValid) {
      setError('Enter a valid port (1–65535).');
      return;
    }
    setBusy('start');
    setError(null);
    try {
      if (!status?.installed) {
        await installWatch();
      }
      const { url } = await startWatch(portValue);
      await refresh();
      if (url) setCopied(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  };

  const handleStop = async () => {
    setBusy('stop');
    setError(null);
    try {
      await stopWatch();
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  };

  const tunnelUrl = status?.tunnel.url ?? null;

  return (
    <>
      <Tip label={open ? undefined : 'Mobile Watching'} align="start">
        <div style={{ position: 'relative' }} data-mw-anchor>
        <button
          ref={buttonRef}
          type="button"
          onClick={() => setOpen((value) => !value)}
          aria-label="Mobile Watching"
          aria-expanded={open}
          className={cx('ib', running && 'on')}
        >
          <DIcon name="phone" className="ic" aria-hidden="true" />
          {running ? (
            <span style={{ position: 'absolute', right: 2, top: 2, width: 8, height: 8, borderRadius: '50%', background: 'rgb(var(--c-ok))' }} aria-hidden="true" />
          ) : null}
        </button>
        </div>
      </Tip>

      <Popover
        open={open}
        onClose={() => setOpen(false)}
        anchorRef={buttonRef}
        label="Mobile watching"
        role="dialog"
        width={300}
      >
        <div className="pop-h">
          <span>Mobile watching</span>
          <span className={cx('stat', running && 'ok')}>{running ? 'Live' : 'Off'}</span>
        </div>

        {tunnelUrl ? (
          <div>
            <div className="qr" style={{ background: '#fff' }}>
              <img
                src={watchQrUrl(tunnelUrl)}
                alt="QR code for the mobile watching link"
                style={{ width: 160, height: 160 }}
              />
            </div>
            <p className="hint2 center">Scan with your phone on the same network to watch this session live.</p>
            <p
              style={{
                margin: '6px 0 0',
                overflowWrap: 'break-word',
                borderRadius: 'var(--r-md)',
                border: '1px solid var(--line)',
                background: 'rgb(var(--c-canvas))',
                padding: '6px 8px',
                fontSize: 11.5,
                textAlign: 'center',
                color: 'var(--muted)',
              }}
            >
              {tunnelUrl}
            </p>
            <div className="mob-acts">
              <button
                type="button"
                className="btn sm ghost"
                onClick={() => {
                  void navigator.clipboard
                    ?.writeText(tunnelUrl)
                    .then(() => {
                      setCopied(true);
                      window.setTimeout(() => setCopied(false), 1500);
                    });
                }}
              >
                {copied ? (
                  <Check className="ic" style={{ color: 'rgb(var(--c-ok))' }} aria-hidden="true" />
                ) : (
                  <Copy className="ic" aria-hidden="true" />
                )}
                {copied ? 'Copied' : 'Copy link'}
              </button>
              <a href={tunnelUrl} target="_blank" rel="noreferrer" className="btn sm ghost">
                Open
              </a>
              <button
                type="button"
                className="btn sm ghost danger"
                onClick={handleStop}
                disabled={busy !== null}
              >
                {busy === 'stop' ? <Loader2 className="ic spin" aria-hidden="true" /> : null}
                Stop
              </button>
            </div>
            <p className="hint2 center" style={{ color: 'rgb(var(--c-warn))' }}>
              Public quick-tunnel URL — anyone with the link can open it until you stop the tunnel.
            </p>
            <p className="hint2 center" style={{ margin: '4px 0 0' }}>
              Port {status?.tunnel.port ?? '—'}
              {status?.version ? ` · ${status.version}` : ''}
            </p>
          </div>
            ) : (
              <div style={{ marginTop: 12 }}>
                <label className="field-label" htmlFor="mw-target">
                  cloudflared platform
                </label>
                <select
                  id="mw-target"
                  className="field"
                  style={{ fontSize: 12.5 }}
                  value={target}
                  onChange={(event) => setTarget(event.target.value)}
                  disabled={busy !== null}
                >
                  {(status?.targets ?? []).map((item) => (
                    <option key={item.id} value={item.id}>
                      {item.label}
                      {item.installed ? ' · downloaded' : ''}
                      {item.runsHere ? ' · this device' : ''}
                    </option>
                  ))}
                </select>
                {selectedTarget && !selectedTarget.runsHere ? (
                  <p style={{ margin: '4px 0 0', fontSize: 11, lineHeight: 1.375, color: 'rgb(var(--c-warn))' }}>
                    Download only — this binary can&apos;t run on this machine. Pick{' '}
                    {status?.targets.find((t) => t.runsHere)?.label ?? 'this device'} to start a tunnel here.
                  </p>
                ) : null}

                <label className="field-label" style={{ marginTop: 10 }} htmlFor="mw-port">
                  Web dev port
                </label>
                <input
                  id="mw-port"
                  className="field"
                  style={{ fontSize: 12.5 }}
                  list="mw-port-list"
                  inputMode="numeric"
                  value={port}
                  onChange={(event) => setPort(event.target.value.replace(/[^\d]/g, ''))}
                  disabled={busy !== null}
                />
                <datalist id="mw-port-list">
                  {(status?.ports ?? []).map((item) => (
                    <option key={item.port} value={item.port}>
                      {item.label ?? ''}
                    </option>
                  ))}
                </datalist>
                {status?.ports.find((p) => p.port === portValue)?.label ? (
                  <p style={{ margin: '4px 0 0', fontSize: 11, color: 'var(--faint)' }}>
                    {status.ports.find((p) => p.port === portValue)?.label}
                  </p>
                ) : null}

                {busy === 'install' || progress?.phase === 'downloading' ? (
                  <div style={{ marginTop: 10 }}>
                    <div style={{ height: 6, overflow: 'hidden', borderRadius: 999, background: 'rgb(var(--c-canvas))' }}>
                      <div
                        style={{
                          height: '100%',
                          borderRadius: 999,
                          background: 'rgb(var(--c-accent))',
                          transition: 'width .2s',
                          width: progress?.total
                            ? `${Math.min(100, Math.round((progress.received / progress.total) * 100))}%`
                            : '15%',
                        }}
                      />
                    </div>
                    <p style={{ margin: '4px 0 0', fontSize: 11, color: 'var(--faint)' }}>
                      Downloading cloudflared…
                      {progress?.total
                        ? ` ${Math.round(progress.received / 1024 / 1024)} / ${Math.round(progress.total / 1024 / 1024)} MB`
                        : ''}
                    </p>
                  </div>
                ) : null}

                {error ? (
                  <p style={{ margin: '8px 0 0', borderRadius: 'var(--r-md)', border: '1px solid rgb(var(--c-danger) / 0.4)', background: 'rgb(var(--c-danger) / 0.1)', padding: '6px 8px', fontSize: 11.5, lineHeight: 1.375, color: 'rgb(var(--c-danger))' }}>
                    {error}
                  </p>
                ) : null}

                <div style={{ marginTop: 10, display: 'flex', alignItems: 'center', gap: 6 }}>
                  {selectedTarget && !selectedTarget.installed ? (
                    <button
                      type="button"
                      className="btn sm"
                      style={{ flex: 1, justifyContent: 'center', fontSize: 12 }}
                      onClick={handleDownload}
                      disabled={busy !== null}
                    >
                      {busy === 'install' ? (
                        <Loader2 className="ic spin" aria-hidden="true" />
                      ) : null}
                      Download
                    </button>
                  ) : null}
                  <button
                    type="button"
                    className="btn primary sm"
                    style={{ flex: 1, justifyContent: 'center', fontSize: 12 }}
                    onClick={handleStart}
                    disabled={busy !== null || !portValid}
                  >
                    {busy === 'start' ? (
                      <Loader2 className="ic spin" aria-hidden="true" />
                    ) : null}
                    Start watching
                  </button>
                </div>
                <p style={{ margin: '8px 0 0', fontSize: 11, lineHeight: 1.375, color: 'var(--faint)' }}>
                  Scan the QR or open the link on another device to follow this web app.{' '}
                  {status?.installed ? '' : 'cloudflared is downloaded automatically on first start.'}
                </p>
              </div>
        )}
      </Popover>
    </>
  );
}
