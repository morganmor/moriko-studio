import { useCallback, useEffect, useState } from 'react';
import { ChevronDown, ChevronRight, Loader2 } from './icons';

import { fetchAgentTasks, stopAgentTask, type AgentTaskDto } from '../lib/api';
import { useStore } from '../store/useStore';
import { Popover } from './Popover';


export function ProcessPanel({
  open,
  onClose,
  anchorRef,
  sessionId,
}: {
  open: boolean;
  onClose: () => void;
  anchorRef: React.RefObject<HTMLButtonElement | null>;
  sessionId?: string;
}) {
  const [tasks, setTasks] = useState<AgentTaskDto[]>([]);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [stopping, setStopping] = useState<string | null>(null);
  const showNotice = useStore((state) => state.showNotice);

  const refresh = useCallback(async () => {
    try {
      setTasks(await fetchAgentTasks(sessionId));
    } catch {
    }
  }, [sessionId]);

  useEffect(() => {
    if (!open) return;
    setExpanded(null);
    void refresh();
    const timer = window.setInterval(() => void refresh(), 2000);
    return () => window.clearInterval(timer);
  }, [open, refresh]);

  const stop = async (task: AgentTaskDto) => {
    if (stopping) return;
    setStopping(task.id);
    try {
      await stopAgentTask(task.id, sessionId);
      await refresh();
    } catch (error) {
      showNotice('tasks.stopFailed', undefined, {
        detail: error instanceof Error ? error.message : undefined,
      });
    } finally {
      setStopping(null);
    }
  };

  const runningCount = tasks.filter((task) => task.running).length;

  return (
    <Popover
      open={open}
      onClose={onClose}
      anchorRef={anchorRef}
      label="Processes"
      role="dialog"
      placement="bottom-end"
      width={430}
      className="wide"
    >
      <div className="pop-h">
        <span>Processes</span>
        <span style={{ fontSize: 10.5, fontWeight: 500, color: 'var(--faint)' }}>
          {sessionId ? 'this session' : 'all sessions'} · {runningCount} running
        </span>
      </div>
      {tasks.length === 0 ? (
        <p className="pop-empty">
          No processes — background tasks the agent starts (dev servers, long builds) appear here.
        </p>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8, padding: '2px 0 6px' }}>
          {tasks.map((task) => {
            const statusColor = task.running
              ? 'rgb(var(--c-accent))'
              : task.endedBy && !task.endedBy.includes('exit')
                ? 'rgb(var(--c-warn))'
                : (task.exitCode ?? 1) === 0
                  ? 'rgb(var(--c-ink) / 0.4)'
                  : 'rgb(var(--c-warn))';
            return (
              <div
                key={task.id}
                className="card"
                style={{ display: 'flex', flexDirection: 'column', gap: 5, borderRadius: 'var(--r-md)', padding: '8px 10px' }}
              >
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, minWidth: 0 }}>
                  <span
                    aria-hidden="true"
                    style={{ width: 8, height: 8, borderRadius: 999, flexShrink: 0, background: statusColor }}
                  />
                  <code style={{ flex: 1, minWidth: 0, fontFamily: 'var(--f-mono)', fontSize: 12, overflowWrap: 'anywhere', color: 'rgb(var(--c-ink))' }}>
                    {task.command}
                  </code>
                  {task.running ? (
                    <button
                      type="button"
                      className="btn danger xs"
                      onClick={() => void stop(task)}
                      disabled={stopping === task.id}
                    >
                      {stopping === task.id ? <Loader2 className="ic spin" aria-hidden="true" /> : 'Stop'}
                    </button>
                  ) : (
                    <span style={{ fontSize: 11, color: 'var(--faint)', flexShrink: 0 }}>
                      {task.endedBy ?? `exit ${task.exitCode ?? '?'}`}
                    </span>
                  )}
                </div>
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, fontSize: 11, color: 'var(--faint)' }}>
                  <span>{task.running ? 'running' : 'exited'} · pid {task.pid ?? 'n/a'} · {fmtElapsed(task.elapsedSec)}</span>
                  <span style={{ fontFamily: 'var(--f-mono)' }}>{task.cwd}</span>
                  {task.outputBytes > 0 ? <span>{task.outputBytes} B out</span> : null}
                </div>
                {task.tail ? (
                  <>
                    <button
                      type="button"
                      className="btn xs ghost"
                      style={{ alignSelf: 'flex-start', height: 22, padding: '0 6px', fontSize: 11 }}
                      onClick={() => setExpanded((current) => (current === task.id ? null : task.id))}
                      aria-expanded={expanded === task.id}
                    >
                      {expanded === task.id ? <ChevronDown className="ic" aria-hidden="true" /> : <ChevronRight className="ic" aria-hidden="true" />}
                      Output
                    </button>
                    {expanded === task.id ? (
                      <pre
                        style={{
                          margin: 0,
                          maxHeight: 180,
                          overflow: 'auto',
                          whiteSpace: 'pre-wrap',
                          fontFamily: 'var(--f-mono)',
                          fontSize: 11,
                          lineHeight: 1.5,
                          color: 'rgb(var(--c-ink) / 0.85)',
                          background: 'rgb(var(--c-canvas))',
                          borderRadius: 'var(--r-sm)',
                          padding: '6px 8px',
                        }}
                      >
                        {task.tail}
                      </pre>
                    ) : null}
                  </>
                ) : null}
              </div>
            );
          })}
        </div>
      )}
    </Popover>
  );
}

function fmtElapsed(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  return `${minutes}m ${Math.round(seconds % 60)}s`;
}
