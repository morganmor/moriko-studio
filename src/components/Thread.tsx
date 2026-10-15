import {
  memo,
  startTransition,
  useCallback,
  useDeferredValue,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import {
  AlertTriangle,
  Archive,
  Bell,
  BookOpen,
  Braces,
  Check,
  ChevronDown,
  Cpu,
  ChevronUp,
  CircleAlert,
  Clock3,
  Copy,
  CornerDownLeft,
  FileText,
  GitBranch,
  Info,
  Loader2,
  Lock,
  Paperclip,
  Pencil,
  PenLine,
  PlugZap,
  RotateCcw,
  Search,
  SquareTerminal,
  Target,
  Trash2,
  User,
  Waypoints,
  X,
  Square,
  Hand,
  ImageIcon,
  Images,
  ShieldAlert,
} from './icons';

import type { ConversationCompaction, Turn, TurnInjection, TurnSegment } from '../types';
import type { AgentPermissionRequest } from '../types';
import { attachmentRefUrl, openBrowserPanelOnce, renderableRefUrl } from '../lib/api';
import { useChatController } from '../hooks/useChatController';
import { useStore } from '../store/useStore';
import { brandCatSvgUrl, brandLoadingSvgUrl, brandReasoningLoopSvg } from '../lib/brandAssets';
import { diffStat, diffStatLabel } from '../lib/diffStat';
import { isGhostTurn } from '../lib/turns';
import { flushUiStateBeacon, storage } from '../lib/storage';

/** Rotating status words for the activity ticker — calm, two seconds each. */
const ACTIVITY_WORDS = ['Doing Work', 'Stand Still', 'Be Calm', 'Stay Focused', 'On Track', 'In Motion'] as const;
import { MESSAGE_CATALOG } from '../lib/messageCatalog';
import { Markdown } from './Markdown';
import { Modal, Tip, cx } from './ui';
import { SplitDiff } from './SplitDiff';
import { AddonWidgetHost } from './AddonWidgetHost';
import { VisualCard, VisualFullscreen, type VisualSpec } from './VisualCard';

/**
 * P4: the react-markdown + remark + KaTeX chain (~770 KB) lazy-loads INSIDE
 * Markdown.tsx with a plain-text fallback — the module boundary here is tiny
 * now, so a plain static import avoids a pointless second sequential chunk
 * hop before the first message can paint its markdown.
 */
function Md(props: { content: string; breakLines?: boolean; className?: string }) {
  return <Markdown {...props} />;
}

/**
 * OPTIMISTIC STEER BUBBLES: rendered from the store's `pendingSteers` while
 * the real echo (the `steer` event, same id) has not landed yet. The user sees
 * their note INSTANTLY — certainty that the input was accepted — and the
 * pending bubble is retired the moment the anchored segment takes its place.
 * DSH-style: attached images render inline, matching the delivered bubble.
 */
function PendingSteerBubble({ text, parts }: { text: string; parts?: import('../types').TurnSteerPart[] }) {
  const images = (parts ?? []).filter((part) => part.type === 'image_url');
  return (
    <div className="msg u" style={{ marginLeft: 'auto', maxWidth: '80%', gap: 4 }}>
      <div className="meta" style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
        <Loader2 className="ic spin" style={{ color: 'rgb(var(--c-accent))' }} aria-hidden="true" />
        <span>You · steering (queued — delivered between tool rounds)</span>
      </div>
      {images.length > 0 ? (
        <div className="ufiles">
          {images.map((image, index) => (
            <img
              key={index}
              src={image.type === 'image_url' ? renderableRefUrl(image.image_url.url) : ''}
              alt="Steered image"
              style={{ maxHeight: 160, maxWidth: '100%', borderRadius: 'var(--r-lg)', border: '1px solid var(--line)', objectFit: 'contain' }}
            />
          ))}
        </div>
      ) : null}
      {text.trim() ? (
        <div className="ub" style={{ width: '100%', borderRadius: 'var(--r-lg) var(--r-lg) 4px var(--r-lg)', borderColor: 'rgb(var(--c-accent) / 0.3)', background: 'color-mix(in srgb, var(--c-accent-soft) 60%, transparent)', opacity: 0.9 }}>
          <Md content={text} breakLines />
        </div>
      ) : null}
    </div>
  );
}

/**
 * Visible explanations for FORCED stop reasons — a harness wrap-up (context
 * budget / stall), a failed tool round, or a provider output cut.
 * A run that ended short must never look like it finished naturally (the old
 * silent cap stop).
 *
 * TEXT LIVES IN THE CATALOG (Fase A #4.2): these cards are harness messages,
 * so their copy is registered in messageCatalog (surface 'thread-card') and
 * only mapped to finish reasons here — one source of truth.
 */
const FINISH_NOTES: Record<string, string> = {
  context_budget: MESSAGE_CATALOG['finish.contextBudget'].text,
  stalled: MESSAGE_CATALOG['finish.stalled'].text,
  tool_errors: MESSAGE_CATALOG['finish.toolErrors'].text,
  length: MESSAGE_CATALOG['finish.length'].text,
  max_tokens: MESSAGE_CATALOG['finish.length'].text,
  MAX_TOKENS: MESSAGE_CATALOG['finish.length'].text,
  user_stop: MESSAGE_CATALOG['finish.userStop'].text,
};

interface ThreadProps {
  turns: Turn[];
  streaming: boolean;
  /** Present when older turns ride as a compaction summary. */
  compaction?: ConversationCompaction;
  /** LIVE composer height (+ gap) — reserved as bottom padding so trailing
   *  content can never be clipped behind the opaque composer block. */
  bottomPad?: number;
  onRegenerate: () => void;
  /** Replaces a turn's content in place (both user inputs and AI outputs). */
  onEditTurn: (turnId: string, content: string) => void;
  /** AI-Studio-style: cuts everything after this OUTPUT and re-runs from it. */
  onRegenerateFrom: (turnId: string) => void;
  /** Forks the conversation up to and including this turn into a new one. */
  onBranchTurn: (turnId: string) => void;
  /** Deletes this turn (a user turn takes its reply with it). */
  onDeleteTurn: (turnId: string) => void;
  /** Composer-band turn arrows call INTO the thread's pin/glide owner instead
   *  of scrolling the DOM behind its back. */
  onNavigationReady?: (navigation: ThreadNavigation | null) => void;
}

/** Imperative navigation the composer band's turn arrows drive. */
export interface ThreadNavigation {
  /** Earliest turn — expands the render window first so Turn 1 is mounted. */
  toFirstTurn: () => void;
  /** Newest content — re-pins and glides to the live edge. */
  toLatest: () => void;
  /** A specific checkpoint (1-based turn number). Expands the window first so
   *  a turn outside the render window can still be reached. */
  toTurn: (turnNumber: number) => void;
}

/**
 * Follows the newest content while streaming. Navigate-to-turn lives in the
 * composer band's arrows — the old "jump to latest" pill was removed.
 *
 * Pinned-ness is derived from USER SCROLL POSITION ONLY: content growth does
 * not fire scroll events, so a growing stream can never flip the flag the
 * way the old IntersectionObserver did (the end sentinel gets pushed out of
 * the viewport as text streams in above it, which made the view freeze
 * after a few seconds of generation). A scroll event only happens when the
 * user (or our own follow-scroll) actually moves — so:
 *  - user scrolls up            → unpinned (the pill appears);
 *  - user scrolls back to bottom → pinned again;
 *  - content grows              → pinned state unchanged, we keep following.
 */
export function useStickToBottom(dependency: unknown) {
  const endRef = useRef<HTMLDivElement>(null);
  /** Pin is a REF only: nothing renders from it since the Latest pill was
   *  removed, so a scroll gesture no longer forces a Thread re-render. */
  const pinnedRef = useRef(true);
  const scrollerRef = useRef<Element | null>(null);
  const lastTopRef = useRef(0);
  /** NAV PAUSE — a navigate-to-turn glide must freeze the follow while it
   *  runs, or the in-flight follow raf takes one more step and fights it. */
  const navPauseRef = useRef(false);

  /**
   * Resolves the scrolling container LAZILY: the sentinel's ancestor can be
   * replaced by React (layout branch switches, view transitions) after this
   * hook mounts. A stale/detached reference here froze `pinned` at `true` —
   * the follow-scroll then fired unconditionally on every streaming flush
   * and the user could not scroll anywhere during generation.
   */
  const resolveScroller = useCallback((): Element | null => {
    let scroller = scrollerRef.current;
    if (!scroller || !scroller.isConnected) {
      scroller = endRef.current?.closest('.chat-scroll') ?? null;
      scrollerRef.current = scroller instanceof Element ? scroller : null;
    }
    return scrollerRef.current;
  }, []);

  /**
   * PIN GLIDE — the follow is a retargeting eased step, never a one-frame
   * jump. A hard `scrollTop = scrollHeight` renders each content flush at the
   * STALE offset first and corrects it next frame (the stutter) and moves a
   * big delta in a single frame (the lurch). This glide re-reads the live
   * bottom every frame, so growth mid-glide is absorbed instead of queued.
   */
  const glideRafRef = useRef(0);
  const glideSettleRef = useRef(0);
  /** NAV loop handle — one glide at a time; two concurrent navigations fight
   *  every frame and neither ever settles. */
  const navRafRef = useRef(0);
  /** Kill any in-flight scroll loop (glide + nav) before starting another. */
  const stopLoops = useCallback(() => {
    if (glideRafRef.current) {
      cancelAnimationFrame(glideRafRef.current);
      glideRafRef.current = 0;
    }
    if (navRafRef.current) {
      cancelAnimationFrame(navRafRef.current);
      navRafRef.current = 0;
    }
    navPauseRef.current = false;
  }, []);
  const SNAP = 48;
  const EASE = 0.22;
  const MIN_STEP = 12;
  const MAX_STEP = 240;

  const ensureGlide = useCallback(() => {
    if (glideRafRef.current) return;
    glideSettleRef.current = 0;
    const step = () => {
      if (!pinnedRef.current) {
        glideRafRef.current = 0;
        return;
      }
      const element = resolveScroller();
      if (!element) {
        glideRafRef.current = 0;
        return;
      }
      const target = Math.max(0, element.scrollHeight - element.clientHeight);
      const delta = target - element.scrollTop;
      if (Math.abs(delta) <= SNAP) {
        element.scrollTop = target;
        glideSettleRef.current += 1;
        if (glideSettleRef.current >= 2) {
          glideRafRef.current = 0;
          return;
        }
      } else {
        glideSettleRef.current = 0;
        const before = element.scrollTop;
        element.scrollTop += Math.sign(delta) * Math.min(Math.max(Math.abs(delta) * EASE, MIN_STEP), MAX_STEP);
        if (element.scrollTop === before) {
          glideRafRef.current = 0;
          return;
        }
      }
      glideRafRef.current = requestAnimationFrame(step);
    };
    glideRafRef.current = requestAnimationFrame(step);
  }, [resolveScroller]);

  useEffect(() => () => {
    if (glideRafRef.current) cancelAnimationFrame(glideRafRef.current);
    if (navRafRef.current) cancelAnimationFrame(navRafRef.current);
  }, []);

  useEffect(() => {
    let raf = 0;
    const onScroll = (event: Event) => {
      const element = resolveScroller();
      if (!element || event.target !== element) return;
      if (raf) return;
      raf = requestAnimationFrame(() => {
        raf = 0;
        const top = element.scrollTop;
        const goingUp = top < lastTopRef.current - 1;
        lastTopRef.current = top;
        if (pinnedRef.current && !goingUp) return;
        const distance = element.scrollHeight - top - element.clientHeight;
        if (distance <= 80 && !goingUp) {
          pinnedRef.current = true;
        } else if (goingUp) {
          pinnedRef.current = false;
        }
      });
    };

    document.addEventListener('scroll', onScroll, { capture: true, passive: true });
    return () => {
      document.removeEventListener('scroll', onScroll, { capture: true });
      if (raf) cancelAnimationFrame(raf);
    };
  }, [resolveScroller]);

  useEffect(() => {
    /**
     * INPUT-INTENT UNPIN — the scroll listener above cannot see an upward
     * move while pinned: the follow-scroll jump and the user's wheel delta
     * land in the SAME frame, the browser coalesces them into one scroll
     * event whose final offset is the bottom, and `goingUp` never fires —
     * the view stayed locked to the live edge for the whole generation.
     * Wheel / touch / keys fire BEFORE the offset changes and are never
     * coalesced, so they unpin immediately and reliably.
     */
    const onIntent = (event: Event) => {
      const element = resolveScroller();
      if (!element) return;
      const target = event.target instanceof Element ? event.target : null;
      if (!target || !element.contains(target)) return;
      let upward = false;
      if (event instanceof WheelEvent) upward = event.deltaY < 0;
      else if (event instanceof TouchEvent) upward = true;
      else if (
        event instanceof KeyboardEvent &&
        ['ArrowUp', 'PageUp', 'Home'].includes(event.key)
      ) {
        upward = true;
      }
      if (!upward) return;
      pinnedRef.current = false;
    };
    document.addEventListener('wheel', onIntent, { capture: true, passive: true });
    document.addEventListener('touchmove', onIntent, { capture: true, passive: true });
    document.addEventListener('keydown', onIntent, { capture: true });
    return () => {
      document.removeEventListener('wheel', onIntent, { capture: true });
      document.removeEventListener('touchmove', onIntent, { capture: true });
      document.removeEventListener('keydown', onIntent, { capture: true });
    };
  }, [resolveScroller]);

  /**
   * FOLLOW — pre-paint snap for small growth (no stale-offset frame at all),
   * eased glide for big deltas (a tool block arriving, a burst of deferred
   * rows). Both retarget the live bottom every frame.
   */
  useLayoutEffect(() => {
    if (!pinnedRef.current) return;
    const element = resolveScroller();
    if (!element) return;
    const target = element.scrollHeight - element.clientHeight;
    const delta = target - element.scrollTop;
    if (Math.abs(delta) <= SNAP) {
      element.scrollTop = target;
      return;
    }
    element.scrollTop += Math.sign(delta) * Math.min(Math.max(Math.abs(delta) * EASE, MIN_STEP), MAX_STEP);
    ensureGlide();
  }, [dependency, ensureGlide, resolveScroller]);

  /** NAVIGATE-TO-TURN — glide to an offset with following paused, then
   *  release. Drives the composer band's turn arrows and the checkpoint rail.
   *  A function target is RE-READ EVERY FRAME: rows materialize from
   *  content-visibility as the glide descends, so an offset captured once goes
   *  stale and the view stopped a turn short ("checkpoint 6 lands on 5"). */
  const navigateTo = useCallback((top: number | (() => number)) => {
    const element = resolveScroller();
    if (!element) return;
    stopLoops();
    pinnedRef.current = false;
    navPauseRef.current = true;
    let settle = 0;
    const step = () => {
      const raw = typeof top === 'function' ? top() : top;
      const target = Math.min(Math.max(raw, 0), Math.max(0, element.scrollHeight - element.clientHeight));
      const delta = target - element.scrollTop;
      if (Math.abs(delta) <= SNAP) {
        element.scrollTop = target;
        settle += 1;
        if (settle >= 2) {
          navRafRef.current = 0;
          navPauseRef.current = false;
          return;
        }
      } else {
        settle = 0;
        const before = element.scrollTop;
        element.scrollTop += Math.sign(delta) * Math.min(Math.max(Math.abs(delta) * EASE, MIN_STEP), MAX_STEP);
        if (element.scrollTop === before) {
          navRafRef.current = 0;
          navPauseRef.current = false;
          return;
        }
      }
      navRafRef.current = requestAnimationFrame(step);
    };
    navRafRef.current = requestAnimationFrame(step);
  }, [resolveScroller, stopLoops]);

  /** UP ARROW — top of the thread. When older turns sit outside the render
   *  window their expansion shortens scrollHeight, so target 0 is re-read
   *  every frame anyway (delta clamps to the live top). */
  const jumpToTurnStart = useCallback(() => {
    navigateTo(0);
  }, [navigateTo]);

  /** DOWN ARROW — resume following the live edge. stopLoops() first: a stuck
   *  loop held glideRafRef and made this arrow a permanent no-op. */
  const jumpToTurnEnd = useCallback(() => {
    stopLoops();
    pinnedRef.current = true;
    ensureGlide();
  }, [ensureGlide, stopLoops]);

  /**
   * INSTANT re-anchor to the live edge — no pin change, no smooth animation.
   * Used when a run ENDS (including provider errors): the view snaps to the
   * newest content in one frame only if the user is already pinned; if they
   * are scrolled up reading, the caller checks pinnedRef first and nothing
   * moves. Calm by design — the old smooth jumpToLatest animated from a
   * layout that had just COLLAPSED (a big reasoning block folding at
   * live→false) and read as a violent fling.
   */
  const reanchorToEdge = useCallback(() => {
    const element = resolveScroller();
    if (element) element.scrollTop = element.scrollHeight;
    else endRef.current?.scrollIntoView({ block: 'end' });
  }, [resolveScroller]);

  /** G5 TELEPORT — single-frame jump, no glide. Scroll-anchor restore lands
   *  exactly where the user left before the refresh; pin state follows the
   *  landing spot so the streaming follow neither fights nor ignores it. */
  const teleportTo = useCallback((top: number) => {
    const element = resolveScroller();
    if (!element) return;
    stopLoops();
    const target = Math.min(Math.max(top, 0), Math.max(0, element.scrollHeight - element.clientHeight));
    element.scrollTop = target;
    pinnedRef.current = false;
  }, [resolveScroller, stopLoops]);

  return { endRef, navigateTo, jumpToTurnStart, jumpToTurnEnd, reanchorToEdge, teleportTo, pinnedRef };
}

/**
 * Compact fingerprint of everything that grows while streaming (content,
 * reasoning, per-segment states). Consumers of {@link useStickToBottom} feed
 * this as the follow-scroll dependency.
 */
export function threadStreamSignature(turns: Turn[]): string {
  return turns
    .map((turn) =>
      [
        turn.content.length,
        turn.reasoning?.length ?? 0,
        turn.segments?.map((segment) => (segment.type === 'tool' ? `t${segment.toolName}${segment.summary === undefined ? '!' : String((segment.summary ?? '').length)}${segment.progress ? '~' : ''}${segment.toolImages?.length ?? 0}` : String(segment.text.length))).join('+') ?? '',
      ].join(':'),
    )
    .join('|');
}

export const Thread = memo(function Thread({ turns, streaming, compaction, bottomPad = 144, onRegenerate, onEditTurn, onRegenerateFrom, onBranchTurn, onDeleteTurn, onNavigationReady }: ThreadProps) {
  const { continueChat, resumeCrashedRun } = useChatController();

  const [fullscreenVisual, setFullscreenVisual] = useState<VisualSpec | null>(null);

  const activeId = useStore((state) => state.activeId);
  const crashedRun = useStore((state) => (activeId ? state.crashedRuns[activeId] : undefined));
  const pendingSteers = useStore((state) => (activeId ? state.pendingSteers[activeId] : undefined));

  const [windowSize, setWindowSize] = useState(WINDOW_INITIAL);

  const clearOutput = useCallback((turnId: string) => {
    const state = useStore.getState();
    const conversation = state.activeConversation();
    if (!conversation) return;
    const turn = conversation.turns.find((entry) => entry.id === turnId);
    if (!turn) return;
    const keptReasoning = (turn.segments ?? []).filter((segment) => segment.type === 'reasoning');
    if (turn.reasoning || keptReasoning.length) {
      state.updateTurn(conversation.id, turnId, {
        content: '',
        segments: keptReasoning,
        error: undefined,
      });
    } else {
      state.deleteTurn(conversation.id, turnId);
    }
  }, []);

  /** 6D: an assistant edit must survive the segment-driven wire rebuild. */
  const editAssistantSegments = useCallback(
    (turnId: string, content: string, segments?: import('../types').TurnSegment[]) => {
      const state = useStore.getState();
      const conversation = state.activeConversation();
      if (!conversation) return;
      state.updateTurn(conversation.id, turnId, {
        content,
        segments: segments && segments.length ? segments : [{ type: 'text', text: content }],
        error: undefined,
      });
    },
    [],
  );

  const clearReasoning = useCallback((turnId: string) => {
    const state = useStore.getState();
    const conversation = state.activeConversation();
    if (!conversation) return;
    const turn = conversation.turns.find((entry) => entry.id === turnId);
    if (!turn) return;
    const kept = (turn.segments ?? []).filter((segment) => segment.type !== 'reasoning');
    if (!turn.content && !kept.length) {
      state.deleteTurn(conversation.id, turnId);
    } else {
      state.updateTurn(conversation.id, turnId, {
        reasoning: '',
        segments: kept,
      });
    }
  }, []);

  const threadContent = useMemo(() => ({ id: activeId, turns }), [activeId, turns]);
  const deferredContent = useDeferredValue(threadContent);
  const deferredTurns = deferredContent.id === activeId ? deferredContent.turns : turns;
  const streamSignature = threadStreamSignature(deferredTurns);
  const { endRef, navigateTo, jumpToTurnStart, jumpToTurnEnd, reanchorToEdge, teleportTo, pinnedRef } = useStickToBottom(streamSignature);

  /** Sliding render window: only the newest `windowSize` turns are mounted.
   *  Declared HERE (above the navigation callbacks) because goToTurn and the
   *  rail need it; a later declaration would be a use-before-init error. */
  const hiddenCount = Math.max(0, deferredTurns.length - windowSize);
  const visibleTurns = hiddenCount > 0 ? deferredTurns.slice(hiddenCount) : deferredTurns;

  /** UP ARROW — expand the render window so the EARLIEST turn is mounted,
   *  then glide to the top of the thread. */
  const previousFirstTurn = useCallback(() => {
    setWindowSize((size) => Math.max(size, deferredTurns.length));
    jumpToTurnStart();
  }, [deferredTurns.length, jumpToTurnStart]);

  /**
   * GO TO TURN — used by the checkpoint rail. A turn outside the render
   * window is not in the DOM at all, so expanding the window and scrolling in
   * the SAME pass would scroll against pre-expansion offsets (the mounted
   * turns above push everything down). The target is therefore parked in a
   * ref and resolved by an effect AFTER the expanded window commits.
   */
  const pendingTurnRef = useRef<number | null>(null);
  const goToTurn = useCallback(
    (turnNumber: number) => {
      const scroller = resolveThreadScroller(endRef.current);
      const row = scroller?.querySelector<HTMLElement>(`[data-turn="${turnNumber}"]`) ?? null;
      if (row && scroller) {
        navigateTo(() => row.getBoundingClientRect().top - scroller.getBoundingClientRect().top + scroller.scrollTop);
        return;
      }
      if (hiddenCount > 0) {
        pendingTurnRef.current = turnNumber;
        setWindowSize(deferredTurns.length);
      }
    },
    [deferredTurns.length, hiddenCount, navigateTo, endRef],
  );
  useEffect(() => {
    const pending = pendingTurnRef.current;
    if (pending === null) return;
    pendingTurnRef.current = null;
    const scroller = resolveThreadScroller(endRef.current);
    if (!scroller) return;
    const row = scroller.querySelector<HTMLElement>(`[data-turn="${pending}"]`);
    if (!row) return;
    navigateTo(() => row.getBoundingClientRect().top - scroller.getBoundingClientRect().top + scroller.scrollTop);
  }, [windowSize, navigateTo, endRef]);

  /** Hand the band's arrows + rail the hook's own glide + pin control. */
  useEffect(() => {
    onNavigationReady?.({ toFirstTurn: previousFirstTurn, toLatest: jumpToTurnEnd, toTurn: goToTurn });
    return () => onNavigationReady?.(null);
  }, [goToTurn, onNavigationReady, previousFirstTurn, jumpToTurnEnd]);

  /** G5 SCROLL ANCHOR — refs + decide. Saved on exit moments only (see the
   *  save effect); NOTHING reads layout during normal scrolling. */
  const anchorRef = useRef<{ turnId: string; offset: number } | null>(null);
  /** 'wait-reset' — the rendered window still belongs to the PREVIOUS
   *  conversation; teleporting against it would be undone by the pending
   *  shrink to WINDOW_INITIAL, so restore waits until that reset commits. */
  const anchorPhaseRef = useRef<'idle' | 'wait-reset' | 'active' | 'settling'>('idle');
  const lastAnchorIdRef = useRef<string | null>(null);
  /** G5 SETTLE — at teleport time rows above the anchor are still plain-text
   *  fallbacks / content-visibility ESTIMATES (markdown lazy-loads per row);
   *  they grow as they hydrate and silently push the anchor down — the "lands
   *  a few turns early" drift (36 instead of 43). A bounded loop re-places
   *  the anchor row every frame until the layout stops moving, so the final
   *  spot is pixel-identical to the save moment. Any user gesture hands the
   *  view back immediately. */
  const settleRafRef = useRef(0);
  const settleStableRef = useRef(0);
  const settleDeadlineRef = useRef(0);
  const SETTLE_MAX_MS = 8_000;
  const stopSettling = useCallback(() => {
    if (settleRafRef.current) cancelAnimationFrame(settleRafRef.current);
    settleRafRef.current = 0;
    if (anchorPhaseRef.current === 'settling') anchorPhaseRef.current = 'idle';
  }, []);
  const startSettling = useCallback(() => {
    if (settleRafRef.current) cancelAnimationFrame(settleRafRef.current);
    const tick = () => {
      const anchor = anchorRef.current;
      const scroller = resolveThreadScroller(endRef.current);
      if (
        anchorPhaseRef.current !== 'settling' ||
        !anchor ||
        !scroller ||
        Date.now() > settleDeadlineRef.current
      ) {
        settleRafRef.current = 0;
        if (anchorPhaseRef.current === 'settling') anchorPhaseRef.current = 'idle';
        return;
      }
      const row = scroller.querySelector<HTMLElement>(
        `[data-turnid="${CSS.escape(anchor.turnId)}"]`,
      );
      if (!row) {
        settleRafRef.current = 0;
        anchorPhaseRef.current = 'idle';
        return;
      }
      const drift =
        row.getBoundingClientRect().top - scroller.getBoundingClientRect().top - anchor.offset;
      if (Math.abs(drift) > 2) {
        scroller.scrollTop += drift;
        settleStableRef.current = 0;
      } else if ((settleStableRef.current += 1) >= 30) {
        settleRafRef.current = 0;
        anchorPhaseRef.current = 'idle';
        return;
      }
      settleRafRef.current = requestAnimationFrame(tick);
    };
    settleRafRef.current = requestAnimationFrame(tick);
  }, [endRef, resolveThreadScroller]);

  useEffect(() => {
    const onGesture = (event: Event) => {
      if (
        event instanceof KeyboardEvent &&
        !['ArrowUp', 'ArrowDown', 'PageUp', 'PageDown', 'Home', 'End', ' '].includes(event.key)
      ) {
        return;
      }
      stopSettling();
    };
    window.addEventListener('wheel', onGesture, { capture: true, passive: true });
    window.addEventListener('touchstart', onGesture, { capture: true, passive: true });
    window.addEventListener('keydown', onGesture, { capture: true });
    return () => {
      window.removeEventListener('wheel', onGesture, { capture: true });
      window.removeEventListener('touchstart', onGesture, { capture: true });
      window.removeEventListener('keydown', onGesture, { capture: true });
    };
  }, [stopSettling]);
  useEffect(() => () => stopSettling(), [stopSettling]);

  useEffect(() => {
    if (lastAnchorIdRef.current === activeId) return;
    lastAnchorIdRef.current = activeId;
    stopSettling();
    const anchor = activeId ? storage.loadViewAnchor(activeId) : null;
    anchorRef.current = anchor ? { turnId: anchor.turnId, offset: anchor.offset } : null;
    anchorPhaseRef.current = !anchorRef.current
      ? 'idle'
      : windowSize === WINDOW_INITIAL
        ? 'active'
        : 'wait-reset';
  }, [activeId]); // eslint-disable-line react-hooks/exhaustive-deps

  const windowContextRef = useRef({ id: activeId, len: deferredTurns.length });
  useEffect(() => {
    const prev = windowContextRef.current;
    windowContextRef.current = { id: activeId, len: deferredTurns.length };
    if (prev.id !== activeId) {
      setWindowSize(WINDOW_INITIAL);
      return;
    }
    const delta = deferredTurns.length - prev.len;
    if (delta > 0 && !pinnedRef.current) setWindowSize((size) => size + delta);
  }, [activeId, deferredTurns.length, pinnedRef]);

  const pendingExpandRef = useRef<{ height: number; top: number } | null>(null);
  const loadEarlier = useCallback(() => {
    const scroller = resolveThreadScroller(endRef.current);
    if (scroller) pendingExpandRef.current = { height: scroller.scrollHeight, top: scroller.scrollTop };
    setWindowSize((size) => size + WINDOW_CHUNK);
  }, [endRef]);
  useEffect(() => {
    const pending = pendingExpandRef.current;
    if (!pending) return;
    pendingExpandRef.current = null;
    const scroller = resolveThreadScroller(endRef.current);
    if (scroller) scroller.scrollTop = pending.top + (scroller.scrollHeight - pending.height);
  });

  /** G5 SAVE — exit moments only: pagehide, tab-hidden, and conversation
   *  switch (the store notifies listeners synchronously inside set(), BEFORE
   *  React re-renders — the rows on screen still belong to THIS conversation). */
  useEffect(() => {
    const conversationId = activeId;
    if (!conversationId) return;
    const saveNow = () => {
      if (anchorPhaseRef.current !== 'idle' && anchorRef.current) {
        storage.saveViewAnchor(conversationId, { ...anchorRef.current, savedAt: Date.now() });
        flushUiStateBeacon();
        return;
      }
      const scroller = resolveThreadScroller(endRef.current);
      if (!scroller) return;
      const scrollerTop = scroller.getBoundingClientRect().top;
      let turnId = '';
      let offset = 0;
      for (const row of scroller.querySelectorAll<HTMLElement>('[data-turnid]')) {
        const rect = row.getBoundingClientRect();
        if (rect.bottom > scrollerTop + 1) {
          turnId = row.dataset.turnid ?? '';
          offset = rect.top - scrollerTop;
          break;
        }
      }
      if (!turnId) return;
      storage.saveViewAnchor(conversationId, { turnId, offset, savedAt: Date.now() });
      flushUiStateBeacon();
    };
    const onVisibility = () => {
      if (document.visibilityState === 'hidden') saveNow();
    };
    window.addEventListener('pagehide', saveNow);
    document.addEventListener('visibilitychange', onVisibility);
    const unsubscribe = useStore.subscribe((state, previous) => {
      if (state.activeId !== previous.activeId) saveNow();
    });
    return () => {
      unsubscribe();
      window.removeEventListener('pagehide', saveNow);
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, [activeId, endRef]);

  /** G5 RESTORE — progressive window expansion inside startTransition (each
   *  commit stays small → no freeze, unlike the old mount-everything 3b),
   *  then ONE teleport frame (no glide to fight the streaming follow). */
  useEffect(() => {
    if (anchorPhaseRef.current === 'idle' || anchorPhaseRef.current === 'settling') return;
    if (anchorPhaseRef.current === 'wait-reset') {
      if (windowSize !== WINDOW_INITIAL) return;
      anchorPhaseRef.current = 'active';
    }
    const anchor = anchorRef.current;
    if (!anchor) {
      anchorPhaseRef.current = 'idle';
      return;
    }
    const scroller = resolveThreadScroller(endRef.current);
    if (!scroller) return;
    const row = scroller.querySelector<HTMLElement>(
      `[data-turnid="${CSS.escape(anchor.turnId)}"]`,
    );
    if (!row) {
      if (deferredTurns.length === 0) return;
      if (windowSize < deferredTurns.length) {
        const sisa = deferredTurns.length - windowSize;
        startTransition(() =>
          setWindowSize((size) =>
            Math.min(deferredTurns.length, size + Math.max(WINDOW_CHUNK, Math.ceil(sisa / 4))),
          ),
        );
      } else {
        anchorPhaseRef.current = 'idle';
      }
      return;
    }
    anchorPhaseRef.current = 'settling';
    settleStableRef.current = 0;
    settleDeadlineRef.current = Date.now() + SETTLE_MAX_MS;
    const delta =
      row.getBoundingClientRect().top - scroller.getBoundingClientRect().top - anchor.offset;
    teleportTo(scroller.scrollTop + delta);
    startSettling();
  }, [deferredTurns, windowSize, endRef, teleportTo, startSettling]);

  const turnNumbers = useMemo(() => {
    const numbers: number[] = [];
    let counter = 0;
    for (const turn of deferredTurns) {
      if (turn.kind !== undefined) {
        numbers.push(0);
        continue;
      }
      if (turn.role === 'user') counter += 1;
      numbers.push(counter);
    }
    return numbers;
  }, [deferredTurns]);

  /** DUPLICATE CHECKPOINT GUARD — a committed compaction exists TWICE in the
   *  thread: as conversation.compaction (CompactionBlock, hard-coded at the
   *  top) and as the inline kind:'compaction' note turn at the position where
   *  the summarizer ran. Both carry the SAME summary text, so rendering both
   *  showed one checkpoint twice ("compaction at the very top"). When an
   *  inline twin exists it OWNS the presentation (correct position, meta,
   *  delete); the top block stays only as the fallback when no twin exists
   *  (imported history, deleted card) — it also owns Discard. */
  const compactionTwin = compaction
    ? deferredTurns.some(
        (turn) => turn.kind === 'compaction' && turn.content.trim() === compaction.summary.trim(),
      )
    : false;

  const prevStreamingRef = useRef(streaming);
  useEffect(() => {
    if (prevStreamingRef.current && !streaming) {
      if (pinnedRef.current) reanchorToEdge();
    }
    prevStreamingRef.current = streaming;
  });

  let effectiveLastIndex = deferredTurns.length - 1;
  while (effectiveLastIndex >= 0 && isGhostTurn(deferredTurns[effectiveLastIndex])) effectiveLastIndex -= 1;

  return (
    <div
      className="thread"
      style={{ position: 'relative', margin: '0 auto', width: '100%', maxWidth: '780px', padding: `18px 28px ${bottomPad}px` }}
    >
      <div style={{ display: 'flex', flexDirection: 'column', gap: 22 }}>
        {crashedRun ? (
          <div className="card" style={{ display: 'flex', alignItems: 'flex-start', gap: 12, padding: 12, borderColor: 'rgb(var(--c-warn) / 0.4)', background: 'rgb(var(--c-warn) / 0.08)' }}>
            <AlertTriangle className="ic" style={{ marginTop: 2, color: 'rgb(var(--c-warn))' }} aria-hidden="true" />
            <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: 8 }}>
              <div style={{ fontWeight: 500, color: 'rgb(var(--c-ink))' }}>
                This run was interrupted — the proxy died before it finished.
              </div>
              <div className="md-body md-compact" style={{ color: 'var(--muted)' }}>
                Everything the run produced is still in this thread. Resuming
                re-sends the history and replays the {crashedRun.callCount} already-executed tool
                {' '}
                {crashedRun.callCount === 1 ? 'call' : 'calls'} from the journal without executing them
                {' '}
                again — no double edits, no duplicate deletes.
              </div>
            </div>
            <div style={{ display: 'flex', flexShrink: 0, alignItems: 'center', gap: 8 }}>
              <button
                type="button"
                className="btn primary xs"
                onClick={() => {
                  if (activeId) resumeCrashedRun(activeId, crashedRun.runId);
                }}
              >
                Resume run
              </button>
              <button
                type="button"
                className="btn ghost xs"
                onClick={() => {
                  if (activeId) {
                    useStore.getState().setCrashedRun(activeId, null);
                    storage.clearJobRun(activeId);
                  }
                }}
              >
                Dismiss
              </button>
            </div>
          </div>
        ) : null}
        {compaction && !compactionTwin ? <CompactionBlock compaction={compaction} /> : null}
        {hiddenCount > 0 ? (
          <div style={{ display: 'flex', justifyContent: 'center' }}>
            <button
              type="button"
              onClick={loadEarlier}
              className="btn sm"
            >
              <ChevronUp className="ic" aria-hidden="true" />
              Load {Math.min(WINDOW_CHUNK, hiddenCount)} earlier message
              {Math.min(WINDOW_CHUNK, hiddenCount) === 1 ? '' : 's'}
              <span style={{ color: 'var(--faint)' }}>· {hiddenCount} hidden</span>
            </button>
          </div>
        ) : null}
        {visibleTurns.map((turn, index) => {
          const fullIndex = hiddenCount + index;
          return (
            <div
              key={turn.id}
              className="cv-auto"
              data-turnid={turn.id}
              data-turn={turn.role === 'user' && turn.kind === undefined ? turnNumbers[fullIndex] : undefined}
            >
              <MessageRow
                turn={turn}
                isLast={fullIndex === deferredTurns.length - 1}
                isEffectivelyLast={fullIndex === effectiveLastIndex}
                streaming={streaming}
                turnNumber={turn.role === 'user' && turn.kind === undefined ? turnNumbers[fullIndex] : undefined}
                onRegenerate={onRegenerate}
                onEditTurn={onEditTurn}
                onRegenerateFrom={onRegenerateFrom}
                onBranchTurn={onBranchTurn}
                onDeleteTurn={onDeleteTurn}
                onClearOutput={clearOutput}
                onClearReasoning={clearReasoning}
                onEditAssistantSegments={editAssistantSegments}
                onContinue={continueChat}
                onFullscreenVisual={setFullscreenVisual}
              />
            </div>
          );
        })}
        {pendingSteers && pendingSteers.length > 0 ? (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
            {pendingSteers.map((entry) => (
              <PendingSteerBubble key={entry.id} text={entry.text} parts={entry.parts} />
            ))}
          </div>
        ) : null}
        <div ref={endRef} />
      </div>
      {}
      <AddonWidgetHost site="thread-sidebar" streaming={streaming} />
      {}
      {fullscreenVisual ? (
        <VisualFullscreen
          visual={fullscreenVisual}
          onClose={() => setFullscreenVisual(null)}
        />
      ) : null}
      {}
    </div>
  );
});

/** Sliding render window: how many of the NEWEST turns stay mounted at once.
 *  A 100+ turn thread used to mount every row (each with live Markdown nodes)
 *  the moment the chat opened — the DOM bloat behind the slow localhost UI. */
const WINDOW_INITIAL = 40;
/** How many more turns "load earlier" prepends per click. */
const WINDOW_CHUNK = 30;

/**
 * Climbs from the thread's end sentinel to the element that actually scrolls
 * it (App owns the `overflow-y-auto` container — Thread only renders inside
 * it). Bounded hop count: the sentinel never sits deeper than a few levels.
 */
function resolveThreadScroller(from: HTMLDivElement | null): HTMLElement | null {
  let node: HTMLElement | null = from?.parentElement ?? null;
  for (let hops = 0; node !== null && hops < 8; hops += 1, node = node.parentElement) {
    const overflowY = window.getComputedStyle(node).overflowY;
    if (overflowY === 'auto' || overflowY === 'scroll') return node;
  }
  return null;
}

/**
 * Finds the last STABLE paragraph boundary in a streaming text: a blank line
 * that sits OUTSIDE any open ``` fence and $$ math block, and whose next line
 * STARTS a self-contained block (not a list/quote/table continuation, which
 * would render differently when split from their opening line). One linear
 * pass per flush — cheap even on very long turns.
 */
function splitStablePrefix(text: string): { prefix: string; tail: string } {
  let fences = 0;
  let mathBlocks = 0;
  let lastSafe = -1;
  let i = 0;
  while (i < text.length - 1) {
    if (text.startsWith('```', i)) {
      fences += 1;
      i += 3;
      continue;
    }
    if (text.startsWith('$$', i)) {
      mathBlocks += 1;
      i += 2;
      continue;
    }
    if (text.charCodeAt(i) === 10 && text.charCodeAt(i + 1) === 10) {
      const after = i + 2;
      const lineEnd = text.indexOf('\n', after);
      const line = text.slice(after, lineEnd === -1 ? undefined : lineEnd);
      const continues = /^(\s{4,}|\t|\s*[-*+>]\s|\s*\d+[.)]\s|\s*\|)/.test(line);
      if (fences % 2 === 0 && mathBlocks % 2 === 0 && !continues && line.trim() !== '') {
        lastSafe = after;
      }
      i += 2;
      continue;
    }
    i += 1;
  }
  if (lastSafe <= 0) return { prefix: '', tail: text };
  return { prefix: text.slice(0, lastSafe), tail: text.slice(lastSafe) };
}

/**
 * STREAMING TEXT SPLIT — while a turn is live, its text renders as TWO
 * memoized Markdowns: the frozen prefix (finished paragraphs; identical
 * string across flushes, so memo(Markdown) skips the re-parse entirely) and
 * the small tail (the paragraph being written — the only part that grows).
 * A 50ms flush used to re-parse the WHOLE turn from token one; now it parses
 * one paragraph. When the stream ends, one final full parse through the
 * ordinary path restores the single-block layout.
 */
/** DESIGN-1 canvas render: caret berkedip ditempel di ujung teks streaming
 *  hidup (elemen terakhir) — sama seperti paintLive() di design HTML. */
function LiveCaret() {
  return <span className="caret" aria-hidden="true" />;
}

const StreamText = memo(function StreamText({ text, live, className }: { text: string; live: boolean; className?: string }) {
  if (!live) return <Md content={text} className={className} />;
  const { prefix, tail } = splitStablePrefix(text);
  if (!prefix) return (
    <div className={cx('md-live', className)}>
      <Md content={text} className={className} />
      <LiveCaret />
    </div>
  );
  return (
    <div className={cx('md-live', className)}>
      <Md content={prefix} className={className} />
      <div className="md-live-tail">
        <Md content={tail} className={className} />
        <LiveCaret />
      </div>
    </div>
  );
});

/**
 * Memoized per row: while streaming, only the LAST turn's object identity
 * changes per flush — every earlier row would otherwise re-render (and its
 * Markdown re-parse) dozens of times per second. The callbacks passed from
 * App are useCallback-stable so the memo actually holds.
 */
/**
 * VISUAL v2 — module-level helper (dipakai TIGA render site: IIFE pill,
 * IIFE segmen inline, dan ActivityTicker; versi lokal di satu IIFE-lah yang
 * membuat dua site lain melempar ReferenceError saat Pill dibuka).
 */
function buildLastVisualSegmentMap(segments: TurnSegment[]): Map<string, unknown> {
  const map = new Map<string, unknown>();
  for (const segment of segments) {
    if (segment.type === 'tool' && segment.visual?.id) map.set(segment.visual.id, segment);
  }
  return map;
}

/** true = id visual segmen ini punya salinan LEBIH BARU di turn yang sama
 *  (edit-in-place) — salinan lama turun jadi baris audit "updated in place".
 *  Identitas aman: semua site mengiterasi referensi turn.segments yang sama. */
function isSupersededVisual(
  segment: TurnSegment,
  lastVisualSegmentById: Map<string, unknown>,
): boolean {
  if (segment.type !== 'tool' || !segment.visual?.id) return false;
  const last = lastVisualSegmentById.get(segment.visual.id);
  return last !== undefined && last !== segment;
}

/** Extracts renderable URLs from a tool-image list — inline dataUrls pass
 *  through; externalized byte-store refs go through attachmentRefUrl. */
function renderableToolImages(images: Array<{ mime: string; dataUrl?: string; dataRef?: { hash: string; mime: string } }> | undefined): string[] {
  if (!images) return [];
  const urls: string[] = [];
  for (const image of images) {
    const src = image.dataUrl ?? (image.dataRef ? attachmentRefUrl(image.dataRef.hash, image.dataRef.mime) : null);
    if (src) urls.push(renderableRefUrl(src));
  }
  return urls;
}

/** An agent__image result: the URLs the tool returned (inline or byte-store
 *  refs). Local results always carry dataUrls, so this is the fast path. */
function localImageUrls(segment: TurnSegment): string[] {
  if (segment.type !== 'tool' || segment.toolName !== 'image') return [];
  return renderableToolImages((segment as { toolImages?: Parameters<typeof renderableToolImages>[0] }).toolImages);
}

/**
 * GENERATED IMAGE STRIP — inline hasil agent__image di bawah run pill,
 * ChatGPT-style: hasil utama TAMPIL BESAR di alur percakapan, sisanya sebagai
 * thumbnail kecil di bawahnya. Klik mana pun membuka lightbox penuh. Tujuannya
 * agar user tidak perlu membuka Gallery hanya untuk mengecek hasil generate.
 */
function GeneratedImageStrip({ urls }: { urls: string[] }) {
  const [preview, setPreview] = useState<string | null>(null);
  const [primary, ...extras] = urls;
  return (
    <div style={{ marginTop: 10, marginBottom: 6, minWidth: 0 }}>
      <img
        src={primary}
        alt="Generated image"
        onClick={() => setPreview(primary)}
        style={{ display: 'block', maxWidth: 440, maxHeight: 440, borderRadius: 'var(--r-lg)', border: '1px solid var(--line)', cursor: 'zoom-in', background: 'rgb(var(--c-canvas))' }}
      />
      {extras.length > 0 ? (
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginTop: 8 }}>
          {extras.map((url, index) => (
            <img
              key={url}
              src={url}
              alt={`Generated image ${index + 2}`}
              onClick={() => setPreview(url)}
              style={{ height: 96, maxWidth: '100%', borderRadius: 'var(--r-md)', border: '1px solid var(--line)', cursor: 'zoom-in' }}
            />
          ))}
        </div>
      ) : null}
      <Modal open={preview !== null} onClose={() => setPreview(null)} title="Generated image">
        {preview ? (
          <img
            src={preview}
            alt="Generated image"
            style={{ maxWidth: '100%', maxHeight: '70vh', borderRadius: 'var(--r-md)', display: 'block', margin: '0 auto' }}
          />
        ) : null}
      </Modal>
    </div>
  );
}

/** RESPONSE TIMER — format durasi lebar-stabil (dipakai render live di bawah
 *  pill DAN render statis di action row). Spesifikasi operator: H.M.S penuh
 *  tanpa desimal — [jam] [puluhan menit] [menit] [puluhan detik] [detik]:
 *    5s  → "00.00.05"   1m6s → "00.01.06"   1j2m → "01.02.00"
 *  Semua segmen dua digit zero-padded; tabular-nums menjaga lebar tetap. */
function formatProcessingMs(ms: number): string {
  const totalSeconds = Math.floor(ms / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  const pad = (value: number): string => String(value).padStart(2, '0');
  return `${pad(hours)}.${pad(minutes)}.${pad(seconds)}`;
}

const MessageRow = memo(function MessageRow({
  turn,
  isLast,
  isEffectivelyLast,
  streaming,
  turnNumber,
  onRegenerate,
  onEditTurn,
  onRegenerateFrom,
  onBranchTurn,
  onDeleteTurn,
  onClearOutput,
  onClearReasoning,
  onContinue,
  onFullscreenVisual,
  onEditAssistantSegments,
}: {
  turn: Turn;
  isLast: boolean;
  /** True when no MEANINGFUL turn comes after this one — trailing ghost
      assistant turns (empty, from stopped streams) don't hide the buttons. */
  isEffectivelyLast: boolean;
  streaming: boolean;
  /** 1-based Turn number when this row OPENS a turn (user input rows).
   *  A Turn = the input + the model's whole work until the next input. */
  turnNumber?: number;
  onRegenerate: () => void;
  onEditTurn: (turnId: string, content: string) => void;
  onRegenerateFrom: (turnId: string) => void;
  onBranchTurn: (turnId: string) => void;
  onDeleteTurn: (turnId: string) => void;
  onClearOutput: (turnId: string) => void;
  onClearReasoning: (turnId: string) => void;
  onContinue: () => void;
  /** FASE D: opens a visual in the thread-level fullscreen lightbox. P2: the
      spec carries the VisualSpec shape (html OR htmlRef). */
  onFullscreenVisual: (visual: VisualSpec) => void;
  /** 6D: replaces an assistant output's segments with the edited list. */
  onEditAssistantSegments: (turnId: string, content: string, segments?: import('../types').TurnSegment[]) => void;
}) {
  /** RESPONSE TIMER — live seconds while THIS turn's run is streaming.
   *  One interval per active MessageRow (only the streaming last row mounts
   *  it); reads the run start from the store, no per-second store writes. */
  /** Sandbox permission yang sedang ditunggu turn ini — wire ke RunPill.
   *  Dianggap menunggu bila run streaming dan ada tool call yang belum
   *  selesai (ok === undefined) di segmen turn. */
  const pendingPermissions = useStore((state) => state.pendingPermissions);
  const waitingPermission = useMemo(() => {
    if (!(isLast && streaming)) return null;
    const pendingTool = (turn.segments ?? []).some(
      (segment) => segment.type === 'tool' && segment.ok === undefined,
    );
    if (!pendingTool) return null;
    return pendingPermissions[0] ?? null;
  }, [isLast, streaming, turn.segments, pendingPermissions]);
  /** RESPONSE TIMER — live clock for the ACTIVE run. The interval is keyed to
   *  the run (runActive), not to `isLast` alone, and the start epoch is
   *  session-persisted, so a genRunning flap mid-run no longer restarts the
   *  clock and a browser reload continues the elapsed time. */
  const runStartedAt = useStore((state) => (state.activeId ? state.genStartedAt[state.activeId] : undefined));
  const runActive = streaming && isLast;
  const [liveElapsedMs, setLiveElapsedMs] = useState(0);
  useEffect(() => {
    if (!runActive || runStartedAt === undefined) {
      setLiveElapsedMs(0);
      return;
    }
    const tick = () => setLiveElapsedMs(Math.max(0, Date.now() - runStartedAt));
    tick();
    const timer = window.setInterval(tick, 1000);
    return () => window.clearInterval(timer);
  }, [runActive, runStartedAt]);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');

  if (turn.kind === 'compaction') {
    return (
      <div className="w-full">
        <CompactionCard
          turn={turn}
          live={isLast && streaming}
          onDelete={() => onDeleteTurn(turn.id)}
        />
      </div>
    );
  }

  if (turn.kind === 'restore') {
    return (
      <div className="w-full">
        <RestoreCard turn={turn} onDelete={() => onDeleteTurn(turn.id)} />
      </div>
    );
  }

  const startEdit = () => {
    const segments = turn.role === 'assistant' ? turn.segments : undefined;
    const lastText = segments
      ? segments.reduce<{ index: number; text: string }>(
          (last, segment, index) =>
            segment.type === 'text' && segment.text ? { index, text: segment.text } : last,
          { index: -1, text: '' },
        )
      : { index: -1, text: '' };
    const editable = lastText.index !== -1 ? lastText.text : turn.content;
    setDraft(editable);
    setEditing(true);
  };

  const saveEdit = () => {
    const content = draft.trim();
    if (!content) return;
    if (turn.role === 'assistant' && turn.segments?.length) {
      const segments = turn.segments;
      const lastTextIndex = segments.reduce(
        (last, segment, index) => (segment.type === 'text' && segment.text ? index : last),
        -1,
      );
      const nextSegments =
        lastTextIndex === -1
          ? [...segments, { type: 'text' as const, text: content }]
          : segments.map((segment, index) =>
              index === lastTextIndex ? ({ type: 'text' as const, text: content } as const) : segment,
            );
      onEditAssistantSegments(turn.id, content, nextSegments);
    } else if (content !== turn.content) {
      onEditTurn(turn.id, content);
    }
    setEditing(false);
  };

  if (turn.kind === 'goal-loop') {
    return (
      <div style={{ display: 'flex', justifyContent: 'center', padding: '6px 0' }}>
        <details className="card" style={{ maxWidth: '85%', padding: '6px 12px', fontSize: 11, color: 'var(--faint)' }}>
          <summary style={{ display: 'flex', cursor: 'pointer', listStyle: 'none', alignItems: 'center', gap: 6, userSelect: 'none' }}>
            <Target className="ic" style={{ width: 12, height: 12 }} aria-hidden="true" />
            <span style={{ fontWeight: 500, color: 'rgb(var(--c-ink))' }}>
              Goal · Round {turn.goalMeta?.round ?? '?'}{turn.goalMeta?.maxRounds ? `/${turn.goalMeta.maxRounds}` : ''}
            </span>
            <span style={{ color: 'var(--faint)' }}>· {turn.goalMeta?.full === false ? 'Continuation' : 'Context injection'}</span>
            <ChevronDown className="ic chev" style={{ width: 12, height: 12 }} aria-hidden="true" />
          </summary>
          <pre className="inner-scroll" style={{ margin: '8px 0 0', maxHeight: 256, overflow: 'auto', whiteSpace: 'pre-wrap', textAlign: 'left', fontFamily: 'var(--f-mono)', fontSize: 10.5, lineHeight: 1.625, color: 'var(--faint)' }}>
            {turn.content}
          </pre>
        </details>
      </div>
    );
  }

  if (turn.kind === 'probation') {
    // PROBATION WARNING CARD (Tiers 1-3) and the TIER 4 CHOICE CARD.
    if (turn.probationMeta?.tier === 4) {
      return <FreezeChoiceCard turn={turn} />;
    }
    if (turn.probationMeta?.tier === 5) {
      return (
        <div style={{ display: 'flex', justifyContent: 'center', padding: '8px 0' }}>
          <div className="card" style={{ maxWidth: '85%', padding: '12px 14px', fontSize: 12, borderColor: 'rgb(var(--c-danger) / 0.4)', background: 'rgb(var(--c-danger) / 0.05)' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
              <AlertTriangle className="ic" style={{ color: 'rgb(var(--c-danger))' }} aria-hidden="true" />
              <span style={{ fontWeight: 600, color: 'rgb(var(--c-danger))' }}>Probation</span>
              <span style={{ color: 'var(--muted)' }}>· Tier 5 — terminated</span>
            </div>
            <p style={{ margin: '8px 0 0', lineHeight: 1.625, color: 'var(--muted)' }}>
              The model chose Continue five times rather than apologize. The harness closed its reasoning at the first second and terminated the run at its first output token. This conversation is over for the model.
            </p>
            {turn.probationMeta?.reason ? (
              <p style={{ margin: '8px 0 0', fontSize: 11, color: 'var(--faint)' }}>Evidence: {turn.probationMeta.reason}</p>
            ) : null}
          </div>
        </div>
      );
    }
    const tier = turn.probationMeta?.tier ?? 1;
    return (
      <div style={{ display: 'flex', justifyContent: 'center', padding: '8px 0' }}>
        <div className="card" style={{ maxWidth: '85%', padding: '8px 12px', fontSize: 12, borderColor: 'rgb(var(--c-warn) / 0.4)', background: 'rgb(var(--c-warn) / 0.05)' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            <AlertTriangle className="ic" style={{ color: 'rgb(var(--c-warn))' }} aria-hidden="true" />
            <span style={{ fontWeight: 600, color: 'rgb(var(--c-warn))' }}>Probation</span>
            <span style={{ color: 'var(--muted)' }}>· Tier {tier}</span>
          </div>
          <pre className="inner-scroll" style={{ margin: '8px 0 0', maxHeight: 224, overflow: 'auto', whiteSpace: 'pre-wrap', textAlign: 'left', fontFamily: 'var(--f-mono)', fontSize: 11, lineHeight: 1.625, color: 'var(--muted)' }}>
            {turn.content}
          </pre>
          {turn.probationMeta?.reason ? (
            <p style={{ margin: '8px 0 0', fontSize: 11, color: 'var(--faint)' }}>Evidence: {turn.probationMeta.reason}</p>
          ) : null}
        </div>
      </div>
    );
  }

  if (turn.kind === 'enforcement' || turn.kind === 'lockdown') {
    const level = turn.enforcementMeta?.level ?? (turn.kind === 'lockdown' ? 4 : 0);
    const reason = turn.enforcementMeta?.message ?? turn.lockdownMeta?.message ?? '';
    const removeNotice = () => {
      const state = useStore.getState();
      const conversation = state.activeConversation();
      if (!conversation) return;
      state.deleteTurn(conversation.id, turn.id);
    };
    return (
      <div style={{ display: 'flex', justifyContent: 'center', padding: '8px 0' }}>
        <details className="card" style={{ position: 'relative', maxWidth: '85%', padding: '8px 12px', fontSize: 12, borderColor: 'rgb(var(--c-danger) / 0.4)', background: 'rgb(var(--c-danger) / 0.05)' }}>
          <summary style={{ display: 'flex', cursor: 'pointer', listStyle: 'none', alignItems: 'center', gap: 6, userSelect: 'none' }}>
            <Lock className="ic" style={{ width: 14, height: 14, flexShrink: 0, color: 'rgb(var(--c-danger))' }} aria-hidden="true" />
            <span style={{ fontWeight: 600, color: 'rgb(var(--c-danger))' }}>
              {turn.kind === 'lockdown' ? 'Lockdown enforced' : `Enforcement L${level} enforced`}
            </span>
            <span style={{ color: 'var(--muted)' }}>
              · {reason ? 'with reason' : 'no reason given'}
            </span>
            <ChevronDown className="chev" style={{ width: 12, height: 12, color: 'var(--muted)' }} aria-hidden="true" />
          </summary>
          <div style={{ marginTop: 8, display: 'flex', alignItems: 'flex-start', gap: 8 }}>
            <pre className="inner-scroll" style={{ minHeight: 0, flex: 1, maxHeight: 288, overflow: 'auto', whiteSpace: 'pre-wrap', textAlign: 'left', fontFamily: 'var(--f-mono)', fontSize: 11, lineHeight: 1.625, color: 'var(--muted)', margin: 0 }}>
              {turn.content}
            </pre>
            <Tip label="Delete this notice (and its reply)">
              <button
                type="button"
                onClick={removeNotice}
                className="ib sm hdel"
                aria-label="Delete this enforcement notice"
              >
                <Trash2 className="ic" aria-hidden="true" />
              </button>
            </Tip>
          </div>
        </details>
      </div>
    );
  }

  // HARNESS-EVENT turn: dedicated addon-event panel — never a user bubble.
  if (turn.kind === 'harness-event') {
    return (
      <div className="cv-auto hevent-row" style={{ width: '100%', padding: '2px 0' }}>
        <HarnessEventPanel
          addonId={turn.eventAddon ?? 'addon'}
          level={turn.eventLevel ?? 'info'}
          text={turn.content.replace(/^\[[^\]]+\] \[[^\]]+\] /, '')}
          at={turn.createdAt}
        />
      </div>
    );
  }

  if (turn.role === 'user') {
    return (
      <div className={cx('msg u', isEffectivelyLast && 'last')} style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 4 }}>
        {}
        {turnNumber ? (
          <div style={{ alignSelf: 'flex-start', fontSize: 10.5, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '.08em', color: 'var(--faint)' }}>
            Turn {turnNumber}
          </div>
        ) : null}
        {}
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, paddingRight: 2, fontSize: 14, fontWeight: 500, color: 'var(--faint)' }}>
          <User className="ic" aria-hidden="true" />
          User
        </div>
        {}
        {turn.attachments?.length ? (
          // textContent — preview them as an image via an inline data URL.
          <div style={{ display: 'flex', maxWidth: '85%', flexWrap: 'wrap', alignItems: 'center', justifyContent: 'flex-end', gap: 8 }}>
            {turn.attachments.map((attachment) =>
              attachment.mime.startsWith('image/') && (attachment.dataRef || attachment.dataUrl || attachment.textContent) ? (
                <a
                  key={attachment.id}
                  href={attachment.dataRef
                    ? attachmentRefUrl(attachment.dataRef.hash, attachment.dataRef.mime)
                    : attachment.dataUrl ?? `data:image/svg+xml;utf8,${encodeURIComponent(attachment.textContent ?? '')}`}
                  target="_blank"
                  rel="noreferrer"
                  style={{ display: 'block', width: 76, height: 76, flexShrink: 0, overflow: 'hidden', borderRadius: 16, border: '1px solid var(--line)', transition: 'transform .15s' }}
                >
                  <img
                    src={attachment.dataRef
                      ? attachmentRefUrl(attachment.dataRef.hash, attachment.dataRef.mime)
                      : attachment.dataUrl ?? `data:image/svg+xml;utf8,${encodeURIComponent(attachment.textContent ?? '')}`}
                    alt={attachment.name}
                    {...(attachment.width && attachment.height
                      ? { width: attachment.width, height: attachment.height }
                      : {})}
                    style={{ width: '100%', height: '100%', objectFit: 'cover' }}
                  />
                </a>
              ) : (
                <span
                  key={attachment.id}
                  style={{ display: 'inline-flex', width: 76, height: 76, flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 4, borderRadius: 16, border: '1px solid var(--line)', background: 'rgb(var(--c-paper))', padding: '0 4px', textAlign: 'center' }}
                >
                  <Tip label={attachment.name}>
                    <FileText className="ic" style={{ flexShrink: 0, color: 'var(--faint)' }} aria-hidden="true" />
                  </Tip>
                  <span style={{ width: '100%', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontSize: 10, color: 'var(--muted)' }}>{attachment.name}</span>
                </span>
              ),
            )}
          </div>
        ) : null}
        <div
          className="ub"
          style={editing ? { width: '85%' } : undefined}
        >
          {editing ? (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              <textarea
                value={draft}
                onChange={(event) => setDraft(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
                    event.preventDefault();
                    saveEdit();
                  }
                  if (event.key === 'Escape') setEditing(false);
                }}
                rows={Math.min(
                  12,
                  Math.max(2, draft.split('\n').length + Math.floor(draft.length / 80)),
                )}
                autoFocus
                className="field"
                style={{ width: '100%', resize: 'vertical', fontSize: 14 }}
              />
              <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 6 }}>
                <button
                  type="button"
                  onClick={() => setEditing(false)}
                  className="btn ghost xs"
                >
                  <X className="ic" aria-hidden="true" />
                  Cancel
                </button>
                <button
                  type="button"
                  onClick={saveEdit}
                  disabled={!draft.trim()}
                  className="btn primary xs"
                >
                  <Check className="ic" aria-hidden="true" />
                  Save
                </button>
              </div>
            </div>
          ) : turn.content ? (
            <Md content={turn.content} breakLines />
          ) : !streaming ? (
            <p style={{ fontSize: 13, fontStyle: 'italic', color: 'var(--faint)' }}>(empty message)</p>
          ) : null}
        </div>
        {}
        {!editing && !(streaming && isLast) ? (
          <div className="m-acts" style={{ display: 'flex', alignItems: 'center', gap: 2, paddingRight: 4 }}>
            <CopyButton text={turn.content} />
            <button
              type="button"
              onClick={startEdit}
              className="ib sm"
              aria-label="Edit this message"
            >
              <Pencil className="ic" aria-hidden="true" />
            </button>
              <button
                type="button"
                onClick={() => onDeleteTurn(turn.id)}
                className="ib sm"
                aria-label="Delete this message"
              >
                <Trash2 className="ic" aria-hidden="true" />
              </button>
          </div>
        ) : null}
        {}
        {isEffectivelyLast && !streaming ? (
          <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            <button
              type="button"
              onClick={onContinue}
              className="btn sm"
              aria-label="Continue the model's response"
            >
              <CornerDownLeft className="ic" aria-hidden="true" />
              Continue
            </button>
          </div>
        ) : null}
      </div>
    );
  }

  const hasReasoningSegments = turn.segments?.some((segment) => segment.type === 'reasoning') ?? false;

  const showCaret =
    isLast && streaming && !turn.content && !turn.reasoning && !turn.segments?.length;

  return (
    <div className={cx('msg', runActive && 'live', isEffectivelyLast && 'last')} style={{ display: 'flex', gap: 12, position: 'relative' }}>
      {/* Avatar di gutter kiri (absolut) — tidak memakan lebar kolom konten.
          cv-auto punya paint containment (content-visibility:auto): avatar
          HARUS di dalam box turn; gutter cv-auto = 44px (34px avatar + 10px
          jarak), thread padding 28px jadi kelebihan 16px di luar thread. */}
      <span
        className="av"
        aria-hidden="true"
        style={{ position: 'absolute', left: -44, top: 4, width: 34, height: 34, borderRadius: 9 }}
      />
      <div className="ab" style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-start', gap: 8 }}>
      {}
      {(turn.injections ?? []).length > 0 ? (
        <InjectionGroupCard injections={turn.injections ?? []} />
      ) : null}

      {turn.reasoning && !hasReasoningSegments ? (
        <ReasoningBlock
          text={turn.reasoning}
          live={isLast && streaming}
          showCat={isEffectivelyLast}
          onDelete={!streaming ? () => onClearReasoning(turn.id) : undefined}
        />
      ) : null}

      {}
      {}
      {turn.segments && turn.segments.some((segment) => segment.type === 'tool' || segment.type === 'reasoning') ? (
        (() => {
          type PillRow =
            | { kind: 'activity'; segment: Extract<TurnSegment, { type: 'tool' | 'reasoning' }> }
            | { kind: 'interm'; segment: Extract<TurnSegment, { type: 'text' }> }
            | { kind: 'steer'; segment: Extract<TurnSegment, { type: 'steer' }> };

          const turnRunning = isLast && streaming;
          const rows: PillRow[] = [];
          let finalText: Extract<TurnSegment, { type: 'text' }> | null = null;
          turn.segments.forEach((segment) => {
            if (segment.type === 'text') {
              if (!segment.text) return;
              if (turnRunning) {
                rows.push({ kind: 'interm', segment });
                return;
              }
              if (finalText) rows.push({ kind: 'interm', segment: finalText });
              finalText = segment;
              return;
            }
            if (finalText) rows.push({ kind: 'interm', segment: finalText });
            finalText = null;
            if (segment.type === 'steer') {
              rows.push({ kind: 'steer', segment });
            } else {
              rows.push({ kind: 'activity', segment });
            }
          });

          const finalTextOut = finalText as Extract<TurnSegment, { type: 'text' }> | null;

          const hoistedVisualSegment = (() => {
            if (turnRunning) return null;
            for (let i = turn.segments.length - 1; i >= 0; i--) {
              const segment = turn.segments[i];
              if (segment.type === 'tool' && segment.visual) return segment;
              if (segment.type === 'text' || segment.type === 'reasoning') continue;
              return null;
            }
            return null;
          })();
          const hoistedVisual = hoistedVisualSegment?.visual ?? null;
          /** agent__image results are hoisted under the run pill — the user
           *  sees the generated image without opening the Gallery. NOT gated
           *  on turnRunning: the image shows as soon as its tool_result lands,
           *  while the model is still writing (ChatGPT-style). */
          const hoistedImageUrls = (() => {
            const urls: string[] = [];
            for (const segment of turn.segments) {
              if (segment.type !== 'tool') continue;
              for (const url of localImageUrls(segment)) {
                if (!urls.includes(url)) urls.push(url);
              }
            }
            return urls.slice(0, 4);
          })();
          /** VISUAL v2: map id → segmen terakhir dihitung module-level; HANYA
           *  salinan yang disupersedi masuk Set referensi ini, lalu Set-nya
           *  diteruskan ke ActivityTicker — scope komponen anak tidak bisa
           *  melihat local IIFE (akar ReferenceError sebelumnya). */
          const lastVisualSegmentById = buildLastVisualSegmentMap(turn.segments);
          const supersededVisualSegments = new Set<TurnSegment>();
          for (const segment of turn.segments) {
            if (isSupersededVisual(segment, lastVisualSegmentById)) supersededVisualSegments.add(segment);
          }

          return (
            <>
              {rows.length > 0 ? (
                <RunPill
                  activity={rows}
                  running={isLast && streaming}
                  turnId={turn.id}
                  processingMs={turn.processingMs}
                  stopped={turn.finishReason === 'user_stop' || turn.finishReason === 'aborted'}
                  waitingPermission={waitingPermission}
                  onClearReasoning={onClearReasoning}
                  onFullscreenVisual={onFullscreenVisual}
                  suppressVisual={hoistedVisualSegment}
                  supersededVisualSegments={supersededVisualSegments}
                />
              ) : null}
              {hoistedVisual ? (
                <div className="w-full">
                  <VisualCard visual={hoistedVisual} onFullscreen={onFullscreenVisual} />
                </div>
              ) : null}
              {hoistedImageUrls.length > 0 ? <GeneratedImageStrip urls={hoistedImageUrls} /> : null}
              {finalTextOut ? (
                <div className="w-full">
                  <StreamText text={finalTextOut.text} live={false} />
                </div>
              ) : null}
            </>
          );
        })()
      ) : turn.segments ? (
        (() => {
          const lastVisualSegmentById = buildLastVisualSegmentMap(turn.segments);
          return turn.segments.map((segment, index) => {
            return segment.type === 'text' ? (
              segment.text ? (
                <div key={index} className="w-full">
                  <StreamText
                    text={segment.text}
                    live={isLast && streaming && index === turn.segments!.length - 1}
                  />
                </div>
              ) : null
            ) : segment.type === 'reasoning' ? (
              <ReasoningBlock
                key={index}
                text={segment.text}
                live={isLast && streaming && index === turn.segments!.length - 1}
                showCat={isEffectivelyLast && segment.type === 'reasoning' && turn.segments!.findIndex((entry) => entry.type === 'reasoning') === index}
                onDelete={!streaming ? () => onClearReasoning(turn.id) : undefined}
              />
            ) : segment.type === 'steer' ? (
              <SteerBubble key={segment.id} entry={segment} offset={0} />
            ) : (
              <div key={index} className="w-full min-w-0">
                <ToolCallCard
                  call={segment}
                  running={isLast && streaming && segment.summary === undefined}
                />
                {}
                {segment.visual && !isSupersededVisual(segment, lastVisualSegmentById) ? (
                  <VisualCard
                    visual={segment.visual}
                    onFullscreen={onFullscreenVisual}
                  />
                ) : segment.visual && isSupersededVisual(segment, lastVisualSegmentById) ? (
                  <div style={{ marginTop: 6, fontSize: 11, fontStyle: 'italic', color: 'var(--faint)' }}>Visual updated in place</div>
                ) : null}
              </div>
            );
          });
        })()
      ) : turn.content ? (
        <StreamText text={turn.content} live={isLast && streaming} />
      ) : null}

      {}
      {(turn.steers ?? [])
        .filter((entry) => !(turn.segments ?? []).some((segment) => segment.type === 'steer' && segment.id === entry.id))
        .map((entry, index) => (
          <SteerBubble key={entry.id} entry={entry} offset={index * 2} />
        ))}

      {}
      {(turn.harnessEvents ?? []).map((entry) => (
        <HarnessEventPanel key={entry.id} addonId={entry.addonId} level={entry.level} text={entry.text} at={entry.at} />
      ))}

      {turn.finishReason && FINISH_NOTES[turn.finishReason] ? (
        <div className="card" style={{ width: '100%', padding: '10px 16px', borderColor: 'rgb(var(--c-warn) / 0.3)', background: 'rgb(var(--c-warn) / 0.05)' }}>
          <div style={{ display: 'flex', alignItems: 'flex-start', gap: 10 }}>
            {}
            <Info className="ic" style={{ marginTop: 2, color: 'rgb(var(--c-warn))' }} aria-hidden="true" />
            <p style={{ margin: 0, fontSize: 13, lineHeight: 1.375, color: 'var(--muted)' }}>{FINISH_NOTES[turn.finishReason]}</p>
            {}
            {}
            {turn.finishReason === 'tool_errors' && !turn.error && isEffectivelyLast && !streaming ? (
              <button
                type="button"
                onClick={onContinue}
                className="btn sm"
                style={{ marginLeft: 8, flexShrink: 0, fontSize: 12 }}
                aria-label="Continue after the failed tools"
              >
                <CornerDownLeft className="ic" aria-hidden="true" />
                Continue
              </button>
            ) : null}
          </div>
        </div>
      ) : null}

      {}
      {(() => {
        const live = streaming && isLast && runActive;
        if (!live) return null;
        return (
          <Tip label="Processing time (live)">
          <span
            className="meta"
            style={{ marginLeft: 4, display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 14, fontVariantNumeric: 'tabular-nums', color: 'var(--faint)' }}
          >
            <Clock3 className="ic" aria-hidden="true" />
            {formatProcessingMs(liveElapsedMs)}
          </span>
          </Tip>
        );
      })()}

      {turn.error ? (
        <div className="card" style={{ width: '100%', padding: '12px 16px', borderColor: 'rgb(var(--c-danger) / 0.4)', background: 'rgb(var(--c-danger) / 0.05)' }}>
          <div style={{ display: 'flex', alignItems: 'flex-start', gap: 10 }}>
            {}
            <AlertTriangle className="ic" style={{ marginTop: 2, color: 'rgb(var(--c-danger))' }} aria-hidden="true" />
            <div style={{ minWidth: 0, flex: 1 }}>
              <p style={{ margin: 0, fontSize: 14, fontWeight: 500, color: 'rgb(var(--c-danger))' }}>Generation failed</p>
              <p style={{ margin: '4px 0 0', whiteSpace: 'pre-line', overflowWrap: 'break-word', fontSize: 13, color: 'var(--muted)' }}>{turn.error}</p>
            </div>
            {}
            {isEffectivelyLast && !streaming ? (
              <button
                type="button"
                onClick={onContinue}
                className="btn sm"
                style={{ marginLeft: 8, flexShrink: 0, fontSize: 12 }}
                aria-label="Continue the failed generation"
              >
                <CornerDownLeft className="ic" aria-hidden="true" />
                Continue
              </button>
            ) : null}
          </div>
        </div>
      ) : null}

      {showCaret ? (
        <img
          src={brandLoadingSvgUrl}
          alt="Moriko is thinking"
          draggable={false}
          width={56}
          height={56}
          style={{ width: 56, height: 56, userSelect: 'none' }}
        />
      ) : null}

      {}
      {}
      {!(streaming && isLast) && (turn.content || turn.reasoning || turn.segments?.length || turn.error) ? (
        <div className="m-acts bar-row">
          {turn.content && !editing ? <CopyButton text={turn.content} /> : null}
          {turn.content && !editing ? (
            <button
              type="button"
              onClick={startEdit}
              className="ib sm"
              aria-label="Edit this response"
            >
              <Pencil className="ic" aria-hidden="true" />
            </button>
          ) : null}
          {}
          {turn.content || turn.segments?.length || turn.error ? (
            <button
              type="button"
              onClick={() => onClearOutput(turn.id)}
              className="ib sm"
              aria-label="Delete this output"
            >
              <Trash2 className="ic" aria-hidden="true" />
            </button>
          ) : null}
            <button
              type="button"
              onClick={() => onBranchTurn(turn.id)}
              className="ib sm"
              aria-label="Branch the conversation from this response"
            >
              <GitBranch className="ic" aria-hidden="true" />
            </button>
          {isEffectivelyLast ? (
            <button
              type="button"
              onClick={onRegenerate}
              className="ib sm"
              aria-label="Regenerate this response"
            >
              <RotateCcw className="ic" aria-hidden="true" />
            </button>
          ) : null}
          {turn.usage?.totalTokens ? (
            <Tip
              label={
                turn.usage.promptTokens !== undefined
                  ? `Prompt ${turn.usage.promptTokens.toLocaleString()} · Output ${turn.usage.completionTokens?.toLocaleString() ?? '?'}`
                  : undefined
              }
            >
            <span style={{ marginLeft: 4, fontSize: 13, fontVariantNumeric: 'tabular-nums', color: 'var(--faint)' }}>
              {turn.usage.totalTokens.toLocaleString()} tokens
              {turn.usage.promptTokens && turn.usage.cacheReadTokens ? (
                <Tip label="Provider prompt-cache hits">
                  <span style={{ marginLeft: 8, color: 'rgb(var(--c-ok) / 0.8)' }}>
                    · {Math.min(100, Math.round((turn.usage.cacheReadTokens / turn.usage.promptTokens) * 100))}% cache
                  </span>
                </Tip>
              ) : null}
            </span>
            </Tip>
          ) : null}
          {(() => {
            const live = streaming && isLast && runActive;
            const settled = typeof turn.processingMs === 'number' && turn.processingMs >= 0;
            if (!live && !settled) return null;
            return (
              <Tip label={live ? 'Processing time (live)' : 'Total processing time for this response'}>
              <span
                style={{ marginLeft: 4, fontSize: 14, fontVariantNumeric: 'tabular-nums', color: 'var(--faint)' }}
              >
                {formatProcessingMs(live ? liveElapsedMs : (turn.processingMs ?? 0))}
              </span>
              </Tip>
            );
          })()}
          {(() => {
            let added = 0;
            let removed = 0;
            const files = new Set<string>();
            for (const segment of turn.segments ?? []) {
              if (segment.type !== 'tool') continue;
              const stat = segment.diffstat ?? (segment.diff ? diffStat(segment.diff) : null);
              if (!stat) continue;
              added += stat.added;
              removed += stat.removed;
              const match = /--- a\/(.+)$/m.exec(segment.diff ?? '');
              if (match) files.add(match[1].trim());
            }
            if (added === 0 && removed === 0) return null;
            const scope = files.size > 0 ? ` across ${files.size} file${files.size === 1 ? '' : 's'}` : '';
            return (
              <Tip
                label={`${added.toLocaleString('id-ID')} line(s) added, ${removed.toLocaleString('id-ID')} removed${scope} — click to inspect in the Diff panel`}
                align="end"
                className="ml-auto"
              >
                <button
                  type="button"
                  onClick={() => useStore.getState().openDiffPanel(turn.id)}
                  style={{ display: 'inline-flex', cursor: 'pointer', alignItems: 'center', gap: 8, borderRadius: 'var(--r-md)', padding: '2px 4px', fontSize: 13, fontWeight: 500, fontVariantNumeric: 'tabular-nums' }}
                  aria-label="Open the diff panel for this turn"
                >
                  <span style={{ color: '#7DFFC2' }}>+ {added.toLocaleString('id-ID')} Lines</span>
                  {removed > 0 ? <span style={{ color: '#FF9DA2' }}>− {removed.toLocaleString('id-ID')} Lines</span> : null}
                </button>
              </Tip>
            );
          })()}
        </div>
      ) : null}

      {editing ? (
        <div style={{ width: '100%', display: 'flex', flexDirection: 'column', gap: 8 }}>
          <textarea
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
                event.preventDefault();
                saveEdit();
              }
              if (event.key === 'Escape') setEditing(false);
            }}
            rows={Math.min(16, Math.max(4, draft.split('\n').length + 1))}
            autoFocus
            className="field"
            style={{ width: '100%', resize: 'vertical', fontFamily: 'var(--f-mono)', fontSize: 13 }}
          />
          <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 6 }}>
            <button
              type="button"
              onClick={() => setEditing(false)}
              className="btn ghost xs"
            >
              <X className="ic" aria-hidden="true" />
              Cancel
            </button>
            {turn.role === 'assistant' ? (
              <button
                type="button"
                onClick={() => {
                  saveEdit();
                  onRegenerateFrom(turn.id);
                }}
                disabled={!draft.trim()}
                className="btn xs"
                style={{ borderColor: 'rgb(var(--c-accent) / 0.5)' }}
              >
                <Tip label="Save this edit, drop everything after it, and re-run from here">
                <RotateCcw className="ic" aria-hidden="true" />
                </Tip>
                Save &amp; regenerate from here
              </button>
            ) : null}
            <button
              type="button"
              onClick={saveEdit}
              disabled={!draft.trim()}
              className="btn primary xs"
            >
              <Check className="ic" aria-hidden="true" />
              Save
            </button>
          </div>
        </div>
      ) : null}
      </div>
    </div>
  );
});

function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);

  return (
    <button
      type="button"
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(text);
          setCopied(true);
          window.setTimeout(() => setCopied(false), 1600);
        } catch {
        }
      }}
      className="ib sm"
      aria-label={copied ? 'Response copied' : 'Copy response'}
    >
      {copied ? (
        <Check className="ic" style={{ color: 'rgb(var(--c-ok))' }} aria-hidden="true" />
      ) : (
        <Copy className="ic" aria-hidden="true" />
      )}
    </button>
  );
}

/**
 * Collapsible reasoning strip — deliberately transparent (no card box), like
 * a plain "Thinking…" line with a dropdown.
 *
 * The Moriko cat is the state marker: the animated loading cat while the
 * model reasons, swapping to the regular moriko-miau mark the moment output
 * starts — the cat never disappears mid-turn. The body scrolls inside a
 * fixed ceiling, so long reasoning never pushes the conversation away.
 */
/**
 * Icon per injected system-prompt block — derived from the block's title so
 * each row reads at a glance (terminal for prompt blocks, paperclip for
 * attachments, target for goals…) instead of one repeated plug glyph.
 */
function injectionIcon(title: string): typeof PlugZap {
  const t = title.toLowerCase();
  if (t.includes('attachment')) return Paperclip;
  if (t.includes('goal') || t.includes('plan')) return Target;
  if (t.includes('image')) return ImageIcon;
  if (t.includes('reminder')) return Bell;
  if (t.includes('model') || t.includes('capabilit')) return Cpu;
  if (t.includes('structured')) return Braces;
  if (t.includes('mcp')) return PlugZap;
  if (t.includes('operator')) return User;
  return SquareTerminal;
}

/**
 * GROUPED system-context card — one card for ALL harness injections instead
 * of one card per block (they stacked into a wall before every reply).
 * Mirrors design/system-context.html: a single summary row ("System context ·
 * N system prompt, M context injection") that expands into per-block rows,
 * each with its own disclosure. All copy in English.
 */
function InjectionGroupCard({ injections }: { injections: TurnInjection[] }) {
  const [open, setOpen] = useState(false);
  const [allRows, setAllRows] = useState<Record<string, boolean>>({});
  const [contentMounted, setContentMounted] = useState(false);
  if (open && !contentMounted) setContentMounted(true);
  useEffect(() => {
    if (open) return;
    const timer = window.setTimeout(() => setContentMounted(false), 300);
    return () => window.clearTimeout(timer);
  }, [open]);

  const systemPrompts = injections.filter((injection) => /system prompt/i.test(injection.title)).length;
  const contextInjections = injections.length - systemPrompts;
  const everyRowOpen = injections.length > 0 && injections.every((injection) => allRows[injection.id]);

  const toggleAll = () => {
    const next = !everyRowOpen;
    setAllRows(Object.fromEntries(injections.map((injection) => [injection.id, next])));
  };

  return (
    <div
      className="card"
      style={{ width: '100%', overflow: 'hidden', padding: 0, background: 'rgb(var(--c-elev) / 0.4)' }}
    >
      {/* Card summary row — the only thing visible while collapsed */}
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        aria-expanded={open}
        className="nav"
        style={{ width: '100%', height: 'auto', padding: '10px 14px', justifyContent: 'flex-start', gap: 10 }}
      >
        <PlugZap className="ic" style={{ flexShrink: 0, color: 'rgb(var(--c-accent))' }} aria-hidden="true" />
        <span style={{ minWidth: 0, flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontSize: 12, fontWeight: 500, color: 'var(--muted)' }}>
          System context
          <span style={{ color: 'var(--faint)', fontWeight: 400 }}>
            {' '}· {systemPrompts} system prompt{contextInjections > 0 ? `, ${contextInjections} context injection${contextInjections > 1 ? 's' : ''}` : ''}
          </span>
        </span>
        <span style={{ flexShrink: 0, fontSize: 10.5, textTransform: 'uppercase', letterSpacing: '.05em', color: 'var(--faint)' }}>harness</span>
        <ChevronDown
          className="chev"
          style={{ width: 14, height: 14, flexShrink: 0, color: 'var(--faint)', transition: 'transform .2s', transform: open ? undefined : 'rotate(-90deg)' }}
          aria-hidden="true"
        />
      </button>

      <div className={cx('col', !open && 'shut')} aria-hidden={!open}>
        <div className="col-in">
          {contentMounted ? (
            <div
              className="inner-scroll"
              style={{ maxHeight: 320, overflowY: 'auto', borderTop: '1px solid var(--line)' }}
            >
              {/* Expand / collapse all — only useful with more than one block */}
              {injections.length > 1 ? (
                <div style={{ display: 'flex', justifyContent: 'flex-end', padding: '4px 12px', borderBottom: '1px solid var(--line)' }}>
                  <button
                    type="button"
                    onClick={toggleAll}
                    style={{ background: 'none', border: 0, cursor: 'pointer', fontSize: 11, color: 'rgb(var(--c-accent))', padding: '2px 6px' }}
                  >
                    {everyRowOpen ? 'Collapse all' : 'Expand all'}
                  </button>
                </div>
              ) : null}

              {injections.map((injection, index) => {
                const rowOpen = allRows[injection.id] ?? false;
                const RowIcon = injectionIcon(injection.title);
                return (
                  <div key={injection.id} style={{ borderTop: index > 0 ? '1px solid var(--line)' : undefined }}>
                    <button
                      type="button"
                      onClick={() => setAllRows((rows) => ({ ...rows, [injection.id]: !rowOpen }))}
                      aria-expanded={rowOpen}
                      style={{ display: 'flex', width: '100%', alignItems: 'center', gap: 10, padding: '8px 12px', background: 'none', border: 0, textAlign: 'left', cursor: 'pointer', color: 'inherit' }}
                    >
                      <RowIcon className="ic" style={{ width: 14, height: 14, flexShrink: 0, color: 'var(--muted)' }} aria-hidden="true" />
                      <span style={{ minWidth: 0, flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontSize: 12, color: 'var(--muted)' }}>
                        {injection.title}
                      </span>
                      <ChevronDown
                        className="chev"
                        style={{ width: 13, height: 13, flexShrink: 0, color: 'var(--faint)', transition: 'transform .15s', transform: rowOpen ? 'rotate(180deg)' : undefined }}
                        aria-hidden="true"
                      />
                    </button>
                    {/* Height-animated disclosure (grid 0fr→1fr) — content stays
                        mounted while the card is open so closing eases too */}
                    <div className={cx('col', !rowOpen && 'shut')} aria-hidden={!rowOpen}>
                      <div className="col-in">
                        <pre
                          style={{ margin: 0, padding: '0 12px 10px 36px', whiteSpace: 'pre-wrap', fontFamily: 'var(--f-mono)', fontSize: 11, lineHeight: 1.625, color: 'var(--faint)', opacity: rowOpen ? 1 : 0, transition: 'opacity .25s var(--ease)' }}
                        >
                          {injection.content}
                        </pre>
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          ) : null}
        </div>
      </div>
    </div>
  );
}


/**
 * STEER: the user's mid-run note, rendered as an ANCHORED USER BUBBLE inside
 * the assistant turn — a steer IS the user's message, it just arrived while
 * the model was working. Visually it matches the user row above (right-
 * aligned, "You" label), so nobody mistakes it for a tool card. Rendered at
 * the position of its segment: the note appears BETWEEN the round it landed
 * in and the model output that followed it — never as the thread's last
 * message. Attached images render inline (wire refs become HTTP URLs).
 */
/**
 * HARNESS-EVENT PANEL — an addon event on its own channel. Never a "You"
 * bubble: a slim full-width strip labeled with the addon id, tinted by level
 * (info = accent, warn = c-warn, block = c-danger). Rendered for the dedicated
 * kind:'harness-event' turns (persisted, visible idle) and for live
 * harnessEvents on the assistant turn.
 */
function HarnessEventPanel({ addonId, level, text, at }: { addonId: string; level: 'info' | 'warn' | 'block'; text: string; at?: number }) {
  const color = level === 'warn' ? 'rgb(var(--c-warn))' : level === 'block' ? 'rgb(var(--c-danger))' : 'rgb(var(--c-accent))';
  const time = at ? new Date(at).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', second: '2-digit' }) : '';
  return (
    <div
      className="hevent"
      style={{
        width: '100%', display: 'flex', alignItems: 'flex-start', gap: 8,
        padding: '7px 12px', borderRadius: 8,
        border: '1px solid rgb(var(--c-line))',
        background: 'rgb(var(--c-card))',
        borderLeft: `2px solid ${color}`,
      }}
    >
      <span
        aria-hidden="true"
        style={{ width: 7, height: 7, borderRadius: 999, background: color, marginTop: 5, flexShrink: 0 }}
      />
      <div style={{ minWidth: 0, flex: 1 }}>
        <div style={{ display: 'flex', alignItems: 'baseline', gap: 8 }}>
          <span style={{ fontSize: 10.5, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '.08em', color: 'var(--faint)' }}>
            Harness-Event · {addonId}
          </span>
          {time ? <span style={{ fontSize: 10, color: 'var(--faint)' }}>{time}</span> : null}
        </div>
        <div style={{ fontSize: 12.5, color: 'var(--ink)', whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>{text}</div>
      </div>
    </div>
  );
}

function SteerBubble({  entry,
  offset,
}: {
  entry: { id: string; text: string; parts?: import('../types').TurnSteerPart[] };
  offset: number;
}) {
  const images = (entry.parts ?? []).filter((part) => part.type === 'image_url');
  return (
    <div
      className="msg u"
      style={{ maxWidth: '80%', gap: 4, transform: `translateY(${offset}px)` }}
    >
      <div className="meta" style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 14, fontWeight: 500, color: 'var(--faint)' }}>
        <Waypoints className="ic" style={{ width: 12, height: 12, color: 'rgb(var(--c-accent))' }} aria-hidden="true" />
        <span>You</span>
      </div>
      {images.length > 0 ? (
        <div className="ufiles">
          {images.map((image, index) => (
            <img
              key={index}
              src={image.type === 'image_url' ? renderableRefUrl(image.image_url.url) : ''}
              alt="Steered image"
              style={{ maxHeight: 160, maxWidth: '100%', borderRadius: 'var(--r-lg)', border: '1px solid var(--line)', objectFit: 'contain' }}
            />
          ))}
        </div>
      ) : null}
      {entry.text.trim() ? (
        <div className="ub" style={{ width: '100%', borderRadius: 'var(--r-lg) var(--r-lg) 4px var(--r-lg)', borderColor: 'transparent', background: 'var(--c-accent-soft)' }}>
          <Md content={entry.text} breakLines />
        </div>
      ) : null}
    </div>
  );
}

/**
 * Height-animated disclosure panel — the same easing the activity pill uses
 * (grid-rows 0fr→1fr). Content stays mounted ~330ms after close so the
 * collapse eases down instead of snapping shut, then unmounts.
 */
function CollapsePanel({
  open,
  children,
  className,
}: {
  open: boolean;
  children: import('react').ReactNode;
  className?: string;
}) {
  const [contentMounted, setContentMounted] = useState(open);
  if (open && !contentMounted) setContentMounted(true);
  useEffect(() => {
    if (open) return;
    const timer = window.setTimeout(() => setContentMounted(false), 330);
    return () => window.clearTimeout(timer);
  }, [open]);

  return (
    <div
      className={cx('col', !open && 'shut', className)}
      aria-hidden={!open}
    >
      <div className="col-in">
        {contentMounted ? children : null}
      </div>
    </div>
  );
}

type ReactScrollEvent = Parameters<NonNullable<import('react').HTMLAttributes<HTMLDivElement>['onScroll']>>[0];

/* ── PANEL AUTO-FOLLOW (in-panel) ──────────────────────────────────────────
 * Autoscroll ISI panel (thinking / pill), TERPISAH dari follow thread
 * (useStickToBottom): hanya box panel yang digeser — layar context user
 * tidak disentuh saat teks tumbuh.
 *
 * Anti-lepas: follow dimatikan HANYA oleh input user ke atas (wheel/touch/
 * key, capture-phase) — bukan oleh event scroll. Saat streaming, konten
 * tumbuh tepat setelah set programatik; event scroll keburu mengukur
 * jarak ke dasar > threshold dan mematikan follow di tengah jalan
 * (laporan: reasoning scroll lepas). Resume: scroll user kembali ke dasar.
 */
const PANEL_BOTTOM_SNAP = 48;

function usePanelFollowScroll(open: boolean) {
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const followRef = useRef(true);

  useEffect(() => {
    if (!open) return;
    const onIntent = (event: Event) => {
      const box = scrollRef.current;
      const target = event.target instanceof Element ? event.target : null;
      if (!box || !target || !box.contains(target)) return;
      let upward = false;
      if (event instanceof WheelEvent) upward = event.deltaY < 0;
      else if (event instanceof TouchEvent) upward = true;
      else if (event instanceof KeyboardEvent && ['ArrowUp', 'PageUp', 'Home'].includes(event.key)) upward = true;
      if (upward) followRef.current = false;
    };
    document.addEventListener('wheel', onIntent, { capture: true, passive: true });
    document.addEventListener('touchmove', onIntent, { capture: true, passive: true });
    document.addEventListener('keydown', onIntent, { capture: true });
    return () => {
      document.removeEventListener('wheel', onIntent, { capture: true });
      document.removeEventListener('touchmove', onIntent, { capture: true });
      document.removeEventListener('keydown', onIntent, { capture: true });
    };
  }, [open]);

  /** Nempel langsung di elemen scrollable panel — wiring lama menempel di
   *  wrapper non-overflow sehingga scrollTop-nya no-op total. */
  const onScroll = useCallback((event: ReactScrollEvent) => {
    if (followRef.current) return; // set programatik saat following: abaikan
    const box = event.currentTarget;
    followRef.current = box.scrollHeight - box.scrollTop - box.clientHeight < PANEL_BOTTOM_SNAP;
  }, []);

  /** Dorong isi panel ke ekor konten — dipanggil tiap flush teks. */
  const scrollToBottom = useCallback(() => {
    const box = scrollRef.current;
    if (box && followRef.current) box.scrollTop = box.scrollHeight;
  }, []);

  /** OPEN PUSH — panel dibuka user: isi panel lompat ke ekor, lalu viewport
   *  thread didorong turun hanya sebesar bagian panel yang jatuh DI BAWAH
   *  viewport. Panel turn lama di tengah layar → nol dorongan (tidak ada
   *  yank); panel di tepi bawah → terdorong seukuran tubuh panel. Grid masih
   *  menganimasi 0fr→1fr saat effect ini jalan (rect.height ≈ 0), jadi tinggi
   *  akhir dihitung dari scrollHeight yang di-cap maxHeight. Sekali per buka. */
  const pushedOpenRef = useRef(false);
  useEffect(() => {
    if (!open) {
      pushedOpenRef.current = false;
      return;
    }
    if (pushedOpenRef.current) return;
    pushedOpenRef.current = true;
    followRef.current = true;
    const box = scrollRef.current;
    if (!box) return;
    box.scrollTop = box.scrollHeight;
    const scroller = box.closest('.chat-scroll');
    if (!(scroller instanceof HTMLElement)) return;
    const max = parseFloat(getComputedStyle(box).maxHeight);
    const grow = Number.isFinite(max) ? Math.min(box.scrollHeight, max) : box.scrollHeight;
    const spill = box.getBoundingClientRect().top + grow - scroller.getBoundingClientRect().bottom;
    if (spill > 0) scroller.scrollTop += Math.min(spill, grow);
  }, [open]);

  return { scrollRef, onScroll, scrollToBottom };
}

/** Reasoning body is virtualized in line-sized slices (~18 rendered lines each
 *  at 13px/1.625 ≈ 21px per line). Slices split AFTER their trailing newline so
 *  stacked chunks reproduce the single-paragraph line boxes exactly — verified
 *  height-identical (3084 = 3084) against a plain <p>. */
const REASON_CHUNK_LINES = 18;

function chunkReasoningText(text: string): string[] {
  if (!text) return [];
  const chunks: string[] = [];
  let start = 0;
  let lineCount = 0;
  for (let i = 0; i < text.length; i += 1) {
    if (text[i] === '\n') {
      lineCount += 1;
      if (lineCount >= REASON_CHUNK_LINES) {
        chunks.push(text.slice(start, i + 1));
        start = i + 1;
        lineCount = 0;
      }
    }
  }
  if (start < text.length) chunks.push(text.slice(start));
  return chunks;
}

/** One virtualized slice of the reasoning body. Memoized on the chunk string
 *  (string primitives compare by value), so a streaming flush re-renders and
 *  re-lays-out ONLY the growing tail chunk instead of the whole document. */
const ReasonChunk = memo(function ReasonChunk({ text }: { text: string }) {
  let breaks = 0;
  for (let i = 0; i < text.length; i += 1) if (text[i] === '\n') breaks += 1;
  const lines = Math.max(1, breaks + (text.endsWith('\n') ? 0 : 1));
  return (
    <div
      className="reason-chunk"
      style={{ containIntrinsicSize: `auto ${Math.max(lines, 1) * 21}px` } as React.CSSProperties}
    >
      {text}
    </div>
  );
});

/**
 * REASONING INDICATOR — reasoning_loop.svg inlined beside the "Reasoning"
 * label. The SVG's built-in traveling-light animation IS the live indicator:
 * running while reasoning streams (live), paused at its static cat outline
 * when done (inline markup — a parent can't pause CSS inside an <img>).
 */
function ReasoningLoop({ live }: { live: boolean }) {
  return (
    <span
      className={cx('reasoning-loop', !live && 'is-idle')}
      aria-hidden="true"
      dangerouslySetInnerHTML={{ __html: brandReasoningLoopSvg }}
    />
  );
}

function ReasoningBlock({
  text,
  live,
  showCat,
  onDelete,
}: {
  text: string;
  live: boolean;
  /** Only the NEWEST model turn renders the cat mascot — older turns lose
   *  it automatically as newer turns arrive (the cat follows the context,
   *  it doesn't stack on every turn). */
  showCat: boolean;
  /** Present only on finished turns — deletes this turn's reasoning. */
  onDelete?: () => void;
}) {
  const [open, setOpen] = useState(false);
  const chunks = useMemo(() => chunkReasoningText(text), [text]);
  const wasLive = useRef(live);
  /** In-panel follow — lihat usePanelFollowScroll. Terpisah total dari
   *  follow thread: hanya scrollbar di DALAM panel ini yang bergeser. */
  const { scrollRef, onScroll, scrollToBottom } = usePanelFollowScroll(open);
  /**
   * SCROLL-STABILITY GUARD: when the run ends (or errors), `live` flips false
   * and this block used to COLLAPSE (open → false) — a reasoning box that had
   * grown thousands of pixels shrank in one frame, the page height collapsed
   * with it, the browser clamped scrollTop, and the next effect (jump-to-
   * latest) then flung the view to the bottom. That combined jump is exactly
   * the "context window flung to the top then racing down" report. Keep the
   * block OPEN through the transition; the user closes it themselves.
   */
  useEffect(() => {
    wasLive.current = live;
  }, [live]);

  // Follow isi panel tiap flush teks reasoning (hanya saat panel terbuka).
  useEffect(() => {
    if (!open) return;
    scrollToBottom();
  }, [text, open, scrollToBottom]);

  return (
    <div className="rs-row" style={{ width: '100%' }}>
      <div style={{ display: 'flex', width: '100%', alignItems: 'center', gap: 4 }}>
        <button
          type="button"
          onClick={() => setOpen((value) => !value)}
          aria-expanded={open}
          style={{ display: 'flex', minWidth: 0, flex: 1, alignItems: 'center', gap: 10, textAlign: 'left', background: 'none', border: 0, padding: 0, color: 'inherit' }}
        >
          {showCat ? (
            <img
              src={live ? brandLoadingSvgUrl : brandCatSvgUrl}
              alt=""
              draggable={false}
              width={56}
              height={56}
              style={{ width: 56, height: 56, flexShrink: 0, userSelect: 'none' }}
            />
          ) : null}
          <span style={{ display: 'flex', minWidth: 0, flex: 1, alignItems: 'center', gap: 6, fontSize: 12, fontWeight: 500, color: 'var(--muted)' }}>
            <ReasoningLoop live={live} />
            {live ? 'Thinking…' : 'Reasoning'}
          </span>
          <ChevronDown
            className="chev rs-chev"
            style={{ width: 14, height: 14, flexShrink: 0, color: 'var(--faint)', transition: 'opacity .2s, transform .2s', transform: open ? undefined : 'rotate(-90deg)', opacity: open ? 1 : undefined }}
            aria-hidden="true"
          />
        </button>
        {}
        {onDelete ? (
          <Tip label="Delete this reasoning (keeps the output)" align="end">
            <button
              type="button"
              onClick={onDelete}
              aria-label="Delete this reasoning"
              className="ib sm rs-del"
              style={{ flexShrink: 0, color: 'var(--faint)' }}
            >
              <Trash2 className="ic" aria-hidden="true" />
            </button>
          </Tip>
        ) : null}
      </div>

      <CollapsePanel open={open} className="rs-panel">
        <div
          ref={scrollRef}
          onScroll={onScroll}
          className="inner-scroll"
          style={{ whiteSpace: 'pre-wrap', fontSize: 13, color: 'var(--muted)', maxHeight: 224, overflowY: 'auto', paddingRight: 4 }}
        >
          {chunks.map((chunk, index) => (
            <ReasonChunk key={index} text={chunk} />
          ))}
        </div>
      </CollapsePanel>
    </div>
  );
}

/* ── COMPACTION CHECKPOINT DESIGN (design/Compaction-Redesign.html) ────────
 * Shared presentation for both compaction surfaces: the live card (inline
 * turn) and the top block (no inline twin). English copy throughout. The
 * summary markdown is parsed light: `##` → sections, `- ` → items.
 */

/** Light markdown parse: `##` headings → sections, `- `/`* `/`N.` → items. */
function parseCompactionSections(text: string): { title: string; items: string[] }[] {
  const out: { title: string; items: string[] }[] = [];
  let current: { title: string; items: string[] } | null = null;
  const ensure = () => {
    if (!current) {
      current = { title: 'Summary', items: [] };
      out.push(current);
    }
    return current;
  };
  for (const line of text.split(/\r?\n/)) {
    const heading = line.match(/^#{1,4}\s+(.+?)\s*$/);
    if (heading) {
      current = { title: heading[1], items: [] };
      out.push(current);
      continue;
    }
    const bullet = line.match(/^\s*(?:[-*•]|\d+\.)\s+(.+?)\s*$/);
    if (bullet) {
      ensure().items.push(bullet[1]);
      continue;
    }
    const trimmed = line.trim();
    if (!trimmed) continue;
    const section = ensure();
    if (section.items.length && /^\s{2,}/.test(line)) section.items[section.items.length - 1] += ` ${trimmed}`;
    else section.items.push(trimmed);
  }
  return out.filter((section) => section.items.length);
}

/** Strip inline markdown to plain text (chips, TOC, lead). */
const compactionPlain = (text: string) => text.replace(/`([^`]+)`/g, '$1').replace(/\*\*([^*]+)\*\*/g, '$1');

/** "Label: rest" lead-in split — Labels get the accent chip treatment. */
function compactionLeadIn(raw: string): { label: string; rest: string } | null {
  const match = raw.match(/^([A-Z][^:"`]{1,44}):\s+/);
  if (!match) return null;
  return { label: match[1], rest: raw.slice(match[0].length) };
}

const SECTION_NUM_FILLER = 2;

/** One summary item: accent dot, optional lead-in chip, code/quote highlights,
 *  clamped to 3 lines with a Show more/Show less toggle when long. */
function CompactionItem({ raw }: { raw: string }) {
  const [clamped, setClamped] = useState(raw.length > 230);
  const lead = compactionLeadIn(raw);
  const text = lead ? lead.rest : raw;
  return (
    <li className="cp-item" data-clamped={clamped || undefined}>
      <div className="cp-item-text">
        {lead ? <span className="cp-lead-in">{lead.label}</span> : null}
        {text.split(/(`[^`]+`|\*\*[^*]+\*\*)/g).map((part, i) => {
          if (part.startsWith('`') && part.endsWith('`') && part.length > 2) {
            return <code key={i}>{part.slice(1, -1)}</code>;
          }
          if (part.startsWith('**') && part.endsWith('**') && part.length > 4) {
            return <strong key={i}>{part.slice(2, -2)}</strong>;
          }
          return <span key={i}>{part}</span>;
        })}
      </div>
      {raw.length > 230 ? (
        <button type="button" className="cp-more" aria-expanded={!clamped} onClick={() => setClamped((value) => !value)}>
          {clamped ? 'Show more' : 'Show less'}
        </button>
      ) : null}
    </li>
  );
}

/** Accent hairline with glowing dot — "context compacted here" divider. */
function CompactionMarker() {
  return (
    <div className="cp-marker" aria-hidden="true">
      <span>
        <i />
        Context compacted
      </span>
    </div>
  );
}

const CompactionTileIcon = Archive;

/** Card header: icon tile, title + subtitle, stat chips, copy + delete +
 *  chevron. `title`/`sub` differ per surface; the rest is identical. */
function CompactionHead({
  title,
  sub,
  meta,
  live,
  onCopy,
  onDelete,
  onDeleteLabel,
  open,
  onToggle,
  headerId,
  bodyId,
}: {
  title: string;
  sub: string;
  meta?: { covered: number; replacedTokens: number; trigger: string };
  live?: boolean;
  onCopy?: () => void;
  onDelete?: () => void;
  onDeleteLabel?: string;
  open: boolean;
  onToggle: () => void;
  headerId: string;
  bodyId: string;
}) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    if (!onCopy) return;
    onCopy();
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1600);
  };
  return (
    <header className="cp-head">
      <button type="button" className="cp-toggle" onClick={onToggle} aria-expanded={open} aria-controls={bodyId} id={headerId}>
        <span className="cp-ico" aria-hidden="true">
          {live ? <Loader2 className="ic spin" /> : <CompactionTileIcon className="ic" />}
        </span>
        <span className="cp-titles">
          <span className="cp-title">{title}</span>
          <span className="cp-sub">{sub}</span>
        </span>
        {meta ? (
          <span className="cp-chips">
            {meta.replacedTokens > 0 ? (
              <span className="cp-chip accent">
                <b>~{Math.round(meta.replacedTokens / 1000)}k</b> tok
              </span>
            ) : null}
            <span className="cp-chip">
              <b>{meta.covered}</b> turns
            </span>
            <span className="cp-chip">{meta.trigger}</span>
          </span>
        ) : null}
      </button>
      <div className="cp-actions">
        {onCopy ? (
          <button type="button" className="ib sm" onClick={copy} aria-label={copied ? 'Summary copied' : 'Copy summary'}>
            {copied ? <Check className="ic" style={{ color: 'rgb(var(--c-ok))' }} aria-hidden="true" /> : <Copy className="ic" aria-hidden="true" />}
          </button>
        ) : null}
        {onDelete ? (
          <button type="button" className="ib sm cp-danger" onClick={onDelete} aria-label={onDeleteLabel ?? 'Delete checkpoint'}>
            <Trash2 className="ic" aria-hidden="true" />
          </button>
        ) : null}
        <button type="button" className="ib sm" tabIndex={-1} aria-hidden="true" onClick={onToggle}>
          <ChevronDown className="chev" aria-hidden="true" />
        </button>
      </div>
    </header>
  );
}

/** Collapsed peek: lead sentence + numbered section chips. Visible while the
 *  card is closed (grid-rows 1fr→0fr once open); clicking the lead opens. */
function CompactionPeek({
  lead,
  sections,
  onOpen,
  peekId,
}: {
  lead: string;
  sections: { title: string; items: string[] }[];
  onOpen: () => void;
  peekId: string;
}) {
  return (
    <div className="cp-peek" id={peekId} aria-hidden={undefined}>
      <div className="cp-peek-in">
        <div className="cp-peek-pad">
          <button type="button" className="cp-lead" onClick={onOpen}>
            {lead}
          </button>
          <div className="cp-toc">
            {sections.map((section, index) => (
              <span key={`${section.title}:${index}`} className="cp-toc-chip">
                <span>{String(index + 1).padStart(SECTION_NUM_FILLER, '0')}</span>
                {compactionPlain(section.title)}
              </span>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

/** Expandable summary sections with numbered heads + item counts. Stays
 *  mounted while the card animates closed — the parent's contentMounted
 *  timer unmounts it after the grid collapse finishes. */
function CompactionSections({ sections }: { sections: { title: string; items: string[] }[] }) {
  const [collapsed, setCollapsed] = useState<Record<number, boolean>>({});
  return (
    <div className="cp-scroll">
      {sections.map((section, index) => {
        const isCollapsed = collapsed[index] ?? false;
        return (
          <section key={`${section.title}:${index}`} className="cp-sec" data-collapsed={isCollapsed || undefined}>
            <button
              type="button"
              className="cp-sec-head"
              aria-expanded={!isCollapsed}
              onClick={() => setCollapsed((state) => ({ ...state, [index]: !isCollapsed }))}
            >
              <span className="cp-sec-num">{String(index + 1).padStart(SECTION_NUM_FILLER, '0')}</span>
              <span className="cp-sec-title">{compactionPlain(section.title)}</span>
              <span className="cp-sec-count">{section.items.length}</span>
              <ChevronDown className="chev cp-sec-chev" aria-hidden="true" />
            </button>
            <div className={cx('col', isCollapsed && 'shut')} aria-hidden={isCollapsed}>
              <div className="col-in">
                <ul className="cp-sec-list">
                  {section.items.map((item, itemIndex) => (
                    <CompactionItem key={itemIndex} raw={item} />
                  ))}
                </ul>
              </div>
            </div>
          </section>
        );
      })}
    </div>
  );
}

/** Grouped sections state shared by the card + block via a small hook. */
function useCompactionSections(summary: string) {
  return useMemo(() => parseCompactionSections(summary), [summary]);
}

/** Lead sentence for the collapsed peek: first item, markdown stripped. */
function compactionLead(sections: { title: string; items: string[] }[], summary: string): string {
  const first = sections[0]?.items[0];
  if (first) return compactionPlain(first);
  return compactionPlain(summary.split(/\r?\n/).find((line) => line.trim()) ?? '');
}

/* ── END COMPACTION CHECKPOINT DESIGN ───────────────────────────────────── */

/**
 * Marker for a completed compaction: the turns before a point ride as a
 * summary in the wire context. Expandable so the summary text is inspectable.
 * DISCARD removes the stored compaction: the summary stops riding the wire
 * and every covered turn becomes verbatim context again. This is the ONLY UI
 * path out of a bad checkpoint — before it existed, `setCompaction(id,
 * undefined)` had no caller and a garbage summary could never be removed.
 */
function CompactionBlock({ compaction }: { compaction: ConversationCompaction }) {
  const [open, setOpen] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const sections = useCompactionSections(compaction.summary);
  const bodyId = useId();
  const triggerLabel =
    compaction.trigger === 'manual'
      ? 'compacted manually'
      : compaction.trigger === 'threshold'
        ? 'auto: token threshold'
        : 'auto: context limit';

  const discard = () => {
    const state = useStore.getState();
    const conversation = state.activeConversation();
    if (!conversation) return;
    state.setCompaction(conversation.id, undefined);
    setConfirming(false);
  };

  return (
    <div className="cp-wrap" style={{ width: '100%' }} data-open={open} data-confirm={confirming}>
      <CompactionMarker />
      <article className="cp-card">
        <CompactionHead
          title="Compaction checkpoint"
          sub={`Summary of previous context · ${compaction.coveredTurnIds.length} turn${compaction.coveredTurnIds.length === 1 ? '' : 's'} · ${triggerLabel}`}
          meta={{ covered: compaction.coveredTurnIds.length, replacedTokens: 0, trigger: compaction.trigger }}
          onCopy={() => {
            void navigator.clipboard.writeText(compaction.summary).catch(() => {});
          }}
          onDelete={confirming ? discard : () => setConfirming(true)}
          onDeleteLabel={confirming ? 'Discard checkpoint' : 'Discard checkpoint — covered turns return verbatim'}
          open={open}
          onToggle={() => setOpen((value) => !value)}
          headerId={`${bodyId}-head`}
          bodyId={`${bodyId}-body`}
        />
        {confirming ? (
          <div className="cp-confirm" role="group" aria-label="Confirm discard">
            <span>Discard this checkpoint? Covered turns return as verbatim context.</span>
            <button type="button" className="btn xs danger" style={{ height: 24, fontSize: 11 }} onClick={discard}>
              Discard
            </button>
            <button type="button" className="btn ghost xs" style={{ height: 24, fontSize: 11 }} onClick={() => setConfirming(false)}>
              Keep
            </button>
          </div>
        ) : null}
        <CompactionPeek
          lead={compactionLead(sections, compaction.summary)}
          sections={sections}
          onOpen={() => setOpen(true)}
          peekId={`${bodyId}-peek`}
        />
        {/* Body stays mounted so the grid collapse animates BOTH ways —
            mounting on open removes the transition's start state (snap). */}
        <div className={cx('col', !open && 'shut')} aria-hidden={!open}>
          <div className="col-in">
            <div className="cp-body-in" id={`${bodyId}-body`}>
              <CompactionSections sections={sections} />
            </div>
          </div>
        </div>
      </article>
    </div>
  );
}

/** Desain2 run-panel: label TIAP tool → kata yang tampil di baris "now". */
const RUN_TOOL_VERB: Record<string, string> = {
  read_file: 'Reading',
  read_all: 'Reading',
  list: 'Reading',
  glob: 'Searching',
  grep: 'Searching',
  search: 'Searching',
  write: 'Writing',
  run: 'Running',
  test_run: 'Running tests',
  git: 'Using git',
  render_visual: 'Rendering',
  vision: 'Viewing',
  image: 'Generating image',
  image_models: 'Listing image models',
};

/** Keluarga tool yang MENULIS (sel kuning .k-w) vs yang membaca (netral .k-r). */
const RUN_WRITE_TOOLS = new Set(['write', 'edit_file', 'multi_edit', 'edit_lines', 'edit_between', 'insert_at_line', 'rename', 'move', 'copy', 'delete', 'apply_patch', 'layout_edit', 'undo']);

/** run-files collapse (paritas desain .rf-clip/.rf-veil): chip 26px + gap 6px
 *  → baris ke-4 mulai di offsetTop 96. CSS clip = 122px (96 + peek 14 + padding 12). */
const RF_PEEK_TOP = 96;

/** Tool eksekusi → sel gelap .k-x (desain: TK = {run:'x'}). */
const RUN_EXEC_TOOLS = new Set(['run', 'git', 'test_run', 'typecheck', 'exec', 'bash', 'shell', 'terminal']);

/** "read · src/x.ts" — baris status pill mengambil TARGET dari args. */
function runToolTarget(segment: Extract<TurnSegment, { type: 'tool' }>): string {
  if (!segment.args) return '';
  let args: Record<string, unknown>;
  try {
    args = JSON.parse(segment.args) as Record<string, unknown>;
  } catch {
    return '';
  }
  if (!args || typeof args !== 'object') return '';
  const str = (key: string): string => (typeof args[key] === 'string' ? (args[key] as string).trim() : '');
  return str('path') || str('command') || str('pattern') || str('query') || str('url') || str('title') || str('from') || str('to') || str('prompt').slice(0, 60) || '';
}

/** Status per segmen tool, dipetakan dari field moriko yang ada. */
function runToolStatus(segment: Extract<TurnSegment, { type: 'tool' }>, running: boolean): 'run' | 'ok' | 'err' {
  if (segment.ok === true) return 'ok';
  if (segment.ok === false) return 'err';
  return running ? 'run' : 'ok';
}

type PillRowish =
  | { kind: 'activity'; segment: Extract<TurnSegment, { type: 'tool' | 'reasoning' }> }
  | { kind: 'interm'; segment: Extract<TurnSegment, { type: 'text' }> }
  | { kind: 'steer'; segment: Extract<TurnSegment, { type: 'steer' }> };

/** Satu fase panel expand: kalimat say (interm/reasoning) + call di bawahnya. */
type PillPhase = {
  key: string;
  say: { kind: 'text' | 'reasoning'; segment: TurnSegment } | null;
  items: PillRowish[];
};

/**
 * Desain phasesHTML: say memisahkan fase; call mengerucut ke fase berjalan.
 * Baris reasoning/interm = header `.ph-say`; tool/steer = baris `.call`.
 */
function buildPhases(activity: PillRowish[]): PillPhase[] {
  const phases: PillPhase[] = [];
  let current: PillPhase | null = null;
  activity.forEach((row, index) => {
    if (row.kind === 'interm' || (row.kind === 'activity' && row.segment.type === 'reasoning')) {
      const say = {
        kind: row.kind === 'interm' ? ('text' as const) : ('reasoning' as const),
        segment: row.segment as TurnSegment,
      };
      current = { key: `ph-${index}`, say, items: [] };
      phases.push(current);
      return;
    }
    if (!current) {
      current = { key: `ph-${index}`, say: null, items: [] };
      phases.push(current);
    }
    current.items.push(row);
  });
  return phases;
}

/** Baris .call desain: icon + nama tool + target + diffstat (+ steer tag).
 *  Klik = inspector inline: args/summary/diff terbuka di bawah baris
 *  (CollapsePanel, sama seperti ToolCallCard) — fungsi tidak hilang. */
function CallRow({
  row,
  running,
  workspaceName,
}: {
  row: PillRowish;
  running: boolean;
  workspaceName: string | null;
}) {
  const [open, setOpen] = useState(false);
  if (row.kind === 'steer') {
    return (
      <div className="call steer w-full">
        <Waypoints className="ic" aria-hidden="true" />
        <span className="tg">{row.segment.text}</span>
        <span className="tag">steer</span>
      </div>
    );
  }
  const segment = row.segment as Extract<TurnSegment, { type: 'tool' }>;
  const st = runToolStatus(segment, running);
  const target = toolTarget(segment.toolName, segment.args, workspaceName);
  const diffstat = segment.diff && segment.ok !== false ? diffStatLabel(segment.diff) : null;
  const hasBody = segment.args !== undefined || segment.summary !== undefined || segment.diff !== undefined;
  const progressLine = running && st === 'run' && segment.summary === undefined ? segment.progress : null;
  const StatusIcon = toolStatusIcon(segment.toolName);
  return (
    <div className="w-full">
      <button
        type="button"
        className={cx('call', `s-${st}`, hasBody && 'clickable', 'w-full')}
        onClick={hasBody ? () => setOpen((value) => !value) : undefined}
        aria-expanded={hasBody ? open : undefined}
        data-tip={hasBody ? 'Show input & output' : undefined}
      >
        {st === 'run' ? (
          <Loader2 className="ic spin" aria-hidden="true" />
        ) : st === 'err' ? (
          <CircleAlert className="ic st-e" aria-hidden="true" />
        ) : (
          <StatusIcon className="ic" aria-hidden="true" />
        )}
        <span className="cn">{segment.toolName}</span>
        <span className="tg">{target ? `'${target}'` : segment.serverName ?? ''}</span>
        {progressLine ? <span className="tag">{progressLine.slice(0, 60)}</span> : null}
        {diffstat ? (
          (() => {
            const [added, removed] = diffstat.split(' ');
            return (
              <span className="dd">
                {added ? <em className="p">{added}</em> : null}
                {added && removed ? ' ' : null}
                {removed ? <em className="m">{removed}</em> : null}
              </span>
            );
          })()
        ) : null}
        {hasBody ? (
          <ChevronDown
            className="chev"
            style={{ width: 12, height: 12, flexShrink: 0, transform: open ? undefined : 'rotate(-90deg)' }}
            aria-hidden="true"
          />
        ) : null}
      </button>
      {segment.toolName.startsWith('browser_') ? (
        <button
          type="button"
          className="btn xs"
          style={{ marginTop: -2, marginBottom: 4, marginLeft: 24, fontSize: 10.5, fontFamily: 'var(--f-mono)', borderColor: 'rgb(var(--c-accent) / 0.4)', color: 'rgb(var(--c-accent))' }}
          onClick={(event) => {
            event.stopPropagation();
            openBrowserPanelOnce();
          }}
        >
          ▶ Open Live Browser Panel
        </button>
      ) : null}
      <CollapsePanel
        open={open}
        className="tc-panel"
      >
        {segment.args ? (
          <p style={{ overflowWrap: 'break-word', fontFamily: 'var(--f-mono)', fontSize: 10.5, color: 'var(--faint)', maxHeight: 224, overflowY: 'auto', minWidth: 0, width: '100%', margin: 0 }}>
            {segment.args.length > 300 ? `${segment.args.slice(0, 300)}...` : segment.args}
          </p>
        ) : null}
        {segment.summary !== undefined ? (
          <p className="inner-scroll" style={{ marginTop: 6, maxHeight: 224, minWidth: 0, overflowY: 'auto', whiteSpace: 'pre-wrap', fontSize: 12.5, color: 'var(--muted)', margin: 0 }}>
            {segment.summary || '(empty result)'}
          </p>
        ) : null}
        {segment.diff ? <DiffBlock diff={segment.diff} /> : null}
        <PreviewButton args={segment.args} />
      </CollapsePanel>
    </div>
  );
}

/**
 * ASK — kotak approval inline ala desain (askHTML): muncul di dalam pill
 * turn yang sedang menunggu izin sandbox. Keputusan lewat
 * resolvePermissionRequest store — sama wire dengan AgentPermissionDialog.
 */
function RunAskBox({ request }: { request: AgentPermissionRequest }) {
  const resolvePermissionRequest = useStore((state) => state.resolvePermissionRequest);
  const [deciding, setDeciding] = useState(false);
  const decidingNow = async (approve: boolean, remember: boolean) => {
    if (deciding) return;
    setDeciding(true);
    try {
      await resolvePermissionRequest(request.id, approve, remember);
    } finally {
      setDeciding(false);
    }
  };
  return (
    <div className="ask" data-waiting-permission={request.id}>
      <ShieldAlert className="ic" aria-hidden="true" />
      <div className="min0">
        <b>
          Moriko wants to{' '}
          {request.command ? 'run a command' : request.paths.length ? 'access outside the workspace' : `use ${request.tool}`}
        </b>
        {request.command ? (
          <code>{request.command}</code>
        ) : request.paths.length ? (
          <code>{request.paths.join(' · ')}</code>
        ) : null}
        <span>Without a decision, this is automatically denied after 2 minutes.</span>
      </div>
      <div className="ask-a">
        <button type="button" className="btn danger sm" onClick={() => void decidingNow(false, false)} disabled={deciding}>
          Deny
        </button>
        <button type="button" className="btn primary sm" onClick={() => void decidingNow(true, false)} disabled={deciding}>
          Allow once
        </button>
        <button
          type="button"
          className="btn sm"
          style={{ borderColor: 'rgb(var(--c-accent) / 0.4)', background: 'var(--c-accent-soft)', color: 'rgb(var(--c-ink))' }}
          onClick={() => void decidingNow(true, true)}
          disabled={deciding}
        >
          Allow for this session
        </button>
      </div>
    </div>
  );
}

/**
 * run-st saat running — cincin 8 piksel + inti bernapas. Piksel tetap lurus di
 * grid; geraknya gelombang CSS .pxspin (index.css), bukan rotasi. Urutan anak =
 * posisi cincin lewat :nth-child di sana, jadi jangan menyisipkan <i> di tengah.
 */
function PxSpin() {
  return (
    <span className="pxspin" aria-hidden="true">
      <i /><i /><i /><i />
      <i /><i /><i /><i />
      <i className="core" />
    </span>
  );
}

/**
 * ACTIVITY PILL v2 — EXACTLY ONE pill per assistant turn (spec v2). Collapsed
 * it is a small chip: [ ▼ Doing Work ●●● ]. Clicking expands the full panel —
 * a flat ordered list of every event: reasoning rows, tool rows, and
 * intermediate text (● rows). RUNNING: animated comet border + pulsing dots +
 * rotating word; DONE (turn settled): everything freezes, content preserved,
 * expand/collapse stays user-controlled forever. Nothing is ever re-parented —
 * rows are derived from the turn's own segment order, append-only.
 */
function RunPill({
  activity,
  running,
  turnId,
  processingMs,
  stopped,
  onClearReasoning,
  onFullscreenVisual,
  suppressVisual,
  supersededVisualSegments,
  waitingPermission,
}: {
  activity: PillRowish[];
  running: boolean;
  turnId: string;
  /** Durasi run yang sudah settle (turn.processingMs) — "Worked for Xs". */
  processingMs?: number;
  /** Run berakhir sebelum waktunya (stop/abort) — "Stopped after Xs". */
  stopped?: boolean;
  onClearReasoning: (turnId: string) => void;
  onFullscreenVisual: (visual: VisualSpec) => void;
  /** The tool-call segment whose visual is hoisted below the pill — inside,
   *  that row renders a slim "moved below" marker instead of duplicating the
   *  card. Undefined = every visual renders inline as before. */
  suppressVisual?: { toolCallId?: string } | null;
  /** Set referensi segmen visual yang disupersedi edit-in-place (dihitung
   *  MessageRow dari turn.segments — identitas objek sama). */
  supersededVisualSegments?: Set<TurnSegment>;
  /** Request izin sandbox yang sedang DITUNGGU run ini — pill masuk state
   *  .waiting dan merender kotak .ask inline (desain askHTML). */
  waitingPermission?: AgentPermissionRequest | null;
}) {
  const [open, setOpen] = useState(false);
  const [wordIndex, setWordIndex] = useState(0);
  const [contentMounted, setContentMounted] = useState(false);
  /** In-panel follow — lihat usePanelFollowScroll. Ref + handler nempel di
   *  .activity-panel-scroll (elemen overflowY:auto) langsung. */
  const { scrollRef, onScroll, scrollToBottom } = usePanelFollowScroll(open);

  useEffect(() => {
    if (!running) return;
    const timer = window.setInterval(() => setWordIndex((value) => value + 1), 2000);
    return () => window.clearInterval(timer);
  }, [running]);

  const word = ACTIVITY_WORDS[wordIndex % ACTIVITY_WORDS.length];
  const canExpand = activity.length > 0;
  /** Desain: waiting → border kuning + head "Waiting for your approval". */
  const waiting = Boolean(waitingPermission);

  {}
  const toolRows = activity.filter((row) => row.kind === 'activity' && row.segment.type === 'tool') as Array<{
    kind: 'activity';
    segment: Extract<TurnSegment, { type: 'tool' }>;
  }>;
  const callCount = toolRows.length;
  const added = toolRows.reduce((sum, row) => sum + (row.segment.diffstat?.added ?? 0), 0);
  const removed = toolRows.reduce((sum, row) => sum + (row.segment.diffstat?.removed ?? 0), 0);

  {}
  const currentTool = (() => {
    for (let i = toolRows.length - 1; i >= 0; i--) {
      if (toolRows[i].segment.ok === undefined) return toolRows[i].segment;
    }
    return null;
  })();
  const errCount = toolRows.filter((row) => row.segment.ok === false).length;
  const headWord = currentTool
    ? (RUN_TOOL_VERB[currentTool.toolName] ?? currentTool.toolName)
    : word;
  const headTarget = currentTool ? runToolTarget(currentTool) : '';
  // Desain: "Worked for 9.4s" saat settle, "Stopped after 9.4s" saat dihentikan.
  const durLabel = typeof processingMs === 'number' && processingMs >= 0
    ? `${(processingMs / 1000).toFixed(1)}s`
    : null;
  const doneLabel = !running && callCount > 0
    ? `${stopped ? 'Stopped after' : 'Worked for'}${durLabel ? ` ${durLabel}` : ''}${errCount ? ` · ${errCount} error${errCount === 1 ? '' : 's'} recovered` : ''}`
    : word;

  {}
  const workspaceName = useStore(
    (state) => state.agentWorkspaces.find((entry) => entry.id === state.activeAgentWorkspaceId)?.label ?? null,
  );
  const openDiffPanel = useStore((state) => state.openDiffPanel);
  /** run-files collapse: >3 baris → clip + veil blur; klik veil = expand.
   *  filesHidden = jumlah chip baris ke-4+ — diukur dari offsetTop (chip
   *  membungkus menurut lebar kontainer), bukan dari hitungan mentah. */
  const filesRef = useRef<HTMLDivElement | null>(null);
  const [filesOpen, setFilesOpen] = useState(false);
  const [filesHidden, setFilesHidden] = useState(0);
  /** Desain run-files: file yang diubah run ini (chips di bawah pill).
   *  Stat dari wire `diffstat`; bila kosong (turn lama) dihitung dari `diff` —
   *  angka +N/−N yang sama dengan yang tampil di baris call. */
  const runFiles = toolRows
    .map((row) => {
      const stat = row.segment.diffstat
        ?? (row.segment.diff ? (() => {
          const label = diffStatLabel(row.segment.diff);
          if (!label) return null;
          const [added, removed] = label.split(' ');
          const num = (token?: string) => (token ? Math.abs(parseInt(token.replace(/[^\d-]/g, ''), 10) || 0) : 0);
          return { added: num(added), removed: num(removed) };
        })() : null);
      if (!stat || (!stat.added && !stat.removed)) return null;
      const target = runToolTarget(row.segment);
      if (!target) return null;
      return {
        key: row.segment.toolCallId ?? `f-${target}`,
        path: target,
        add: stat.added,
        del: stat.removed,
      };
    })
    .filter((file): file is NonNullable<typeof file> => file !== null);

  // Baris ke-4+ terdeteksi lewat offsetTop chip (offsetParent = .run-files).
  // running/waiting ikut dependency: div hanya ter-render saat !running —
  // saat settle, effect harus mengukur ulang pada box yang baru di-mount.
  useLayoutEffect(() => {
    if (filesOpen) {
      setFilesHidden(0);
      return;
    }
    const box = filesRef.current;
    if (!box) return;
    const measure = () => {
      let hidden = 0;
      box.querySelectorAll<HTMLElement>(':scope > .fchip').forEach((chip) => {
        if (chip.offsetTop >= RF_PEEK_TOP) hidden++;
      });
      setFilesHidden(hidden);
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(box);
    return () => ro.disconnect();
  }, [filesOpen, runFiles.length, running, waiting]);

  /** Fase ala desain phasesHTML: say memisahkan fase; call mengerucut. */
  const phases = useMemo(() => buildPhases(activity), [activity]);

  {}
  /** Separator fase kini informatif: label = teks fase + jumlah step di
   *  fase SETELAH separator ini (paritas dengan desain rb-sep data-tip).
   *  Tooltip memakai <Tip> (portal ui.tsx) — data-tip mentah di luar scope
   *  .vr tidak punya mesin tooltip apa pun. */
  type RibbonCell = { separator: true; key: string; label?: string } | { cell: React.ReactNode; key: string };
  const ribbonCells: RibbonCell[] = activity.flatMap((row, index): RibbonCell[] => {
    const key = `rc-${index}`;
    if (row.kind === 'activity' && row.segment.type === 'tool') {
      // Waiting approval → sel pending berubah kuning (desain .s-wait).
      const st = waiting && row.segment.ok === undefined ? 'wait' : runToolStatus(row.segment, running);
      // k-w = tool penulis (aksen), k-x = tool eksekusi (tinta pekat),
      // netral = tool baca. fresh: animasi cellin saat sel baru muncul.
      const kindCls = RUN_WRITE_TOOLS.has(row.segment.toolName)
        ? 'k-w'
        : RUN_EXEC_TOOLS.has(row.segment.toolName)
          ? 'k-x'
          : 'k-r';
      const fresh = running && st !== 'run' && st !== 'wait' ? ' fresh' : '';
      return [{
        cell: (
          <Tip label={`${row.segment.toolName}${runToolTarget(row.segment) ? ` · ${runToolTarget(row.segment)}` : ''}`}>
            <button
              type="button"
              tabIndex={-1}
              className={cx('cell', kindCls, `s-${st}`, fresh)}
              aria-label={`${row.segment.toolName} ${runToolTarget(row.segment)}`}
            />
          </Tip>
        ),
        key,
      }];
    }
    if (row.kind === 'steer') {
      return [{
        cell: (
          <Tip label={`Steer · ${row.segment.text.slice(0, 60)}`}>
            <button type="button" tabIndex={-1} className="cell k-steer" aria-label="Steer" />
          </Tip>
        ),
        key,
      }];
    }
    if (row.kind === 'interm' || (row.kind === 'activity' && row.segment.type === 'reasoning')) {
      // Separator antar-fase: label = kalimat fase + jumlah step setelahnya.
      const phaseText = row.segment.type === 'text' || row.segment.type === 'reasoning' ? row.segment.text : '';
      let stepsAfter = 0;
      for (let j = index + 1; j < activity.length; j++) {
        const next = activity[j];
        if (next.kind === 'interm' || (next.kind === 'activity' && next.segment.type === 'reasoning')) break;
        stepsAfter++;
      }
      return [{ separator: true, key, label: `${(phaseText || 'New phase').slice(0, 60)} · ${stepsAfter} step${stepsAfter === 1 ? '' : 's'}` }];
    }
    return [{ separator: true, key }];
  });



  if (open && !contentMounted) setContentMounted(true);
  useEffect(() => {
    if (open) return;
    const timer = window.setTimeout(() => setContentMounted(false), 330);
    return () => window.clearTimeout(timer);
  }, [open]);

  // Follow isi pill tiap event baru (tool call / text / reasoning) dan saat
  // panel baru dibuka — hanya box pill, bukan layar thread.
  useEffect(() => {
    if (!open) return;
    scrollToBottom();
  }, [open, activity.length, running, scrollToBottom]);


  return (
    <div className="w-full">
      <div className={cx('run', running && 'live', waiting && 'waiting')}>
        <button
          type="button"
          className="run-head"
          onClick={() => setOpen((value) => !value)}
          aria-expanded={open}
          aria-label={open ? 'Collapse this turn’s run panel' : 'Expand this turn’s run panel'}
        >
          {}
          <span className="run-st">
            {running ? (
              waiting
                ? <Hand className="ic st-w" aria-hidden="true" />
                : <PxSpin />
            ) : stopped ? (
              <Square className="ic st-s" aria-hidden="true" />
            ) : errCount ? (
              <AlertTriangle className="ic st-w" aria-hidden="true" />
            ) : (
              <Check className="ic st-ok" aria-hidden="true" />
            )}
          </span>

          {}
          <span className="run-now">
            {running ? (
              waiting ? (
                <b>Waiting for your approval</b>
              ) : (
                <>
                  <b>{headWord}</b>
                  {headTarget ? <> <code>{headTarget}</code></> : null}
                </>
              )
            ) : (
              <b>{doneLabel}</b>
            )}
          </span>

          {}
          {callCount > 0 || added > 0 || removed > 0 ? (
            <span className="run-meta">
              {callCount > 0 ? (
                <span className="rn">
                  {callCount} step{callCount === 1 ? '' : 's'}
                </span>
              ) : null}
              {added > 0 || removed > 0 ? (
                <span className="rn">
                  {added > 0 ? <em className="p">+{added}</em> : null}
                  {added > 0 && removed > 0 ? ' ' : null}
                  {removed > 0 ? <em className="m">−{removed}</em> : null}
                </span>
              ) : null}
            </span>
          ) : null}

          <ChevronDown
            className="chev"
            style={{ width: 15, height: 15, flexShrink: 0, color: 'var(--faint)', transition: 'transform .2s', transform: open ? undefined : 'rotate(-90deg)' }}
            aria-hidden="true"
          />
        </button>

        {}
        {ribbonCells.length > 0 || running ? (
          <div className="ribbon">
            {ribbonCells.map((item, index) =>
              'separator' in item ? (
                index > 0 ? (
                  <Tip key={`rb-sep-${index}`} label={item.label}>
                    <span className="rb-sep" aria-label="Phase separator" />
                  </Tip>
                ) : null
              ) : (
                <span key={item.key}>{item.cell}</span>
              ),
            )}
            {running ? <span className="cell head" aria-hidden="true" /> : null}
          </div>
        ) : null}

        {}
        {waiting && !open ? (
          <p className="run-say keep">Waiting for your approval</p>
        ) : null}

        {}
        {waiting && waitingPermission ? <RunAskBox request={waitingPermission} /> : null}

        {}
        {canExpand ? (
          <div className={cx('col activity-panel', !open && 'shut')} aria-hidden={!open}>
            <div className="col-in">
              {contentMounted ? (
                <div ref={scrollRef} onScroll={onScroll} className="activity-panel-scroll inner-scroll" style={{ maxHeight: 420, overflowY: 'auto', padding: 0 }}>
                  {(() => {
                    const isSuppressed = (row: { toolCallId?: string }): boolean =>
                      suppressVisual !== undefined
                      && suppressVisual !== null
                      && row.toolCallId !== undefined
                      && row.toolCallId === suppressVisual.toolCallId;
                    const isSuperseded = (segment: unknown): boolean =>
                      supersededVisualSegments?.has(segment as TurnSegment) ?? false;
                    /** Desain phasesHTML: say memisahkan fase, call di bawahnya. */
                    return (
                      <ol className="phases">
                        {phases.map((phase) => (
                          <li key={phase.key} className="phs">
                            {phase.say ? (
                              phase.say.kind === 'text' ? (
                                <div className="ph-say md-compact">
                                  <StreamText
                                    text={(phase.say.segment as Extract<TurnSegment, { type: 'text' }>).text}
                                    live={running && phase.say.segment === activity[activity.length - 1]?.segment}
                                  />
                                </div>
                              ) : (
                                <ReasoningBlock
                                  text={(phase.say.segment as Extract<TurnSegment, { type: 'reasoning' }>).text}
                                  live={running && phase.say.segment === activity[activity.length - 1]?.segment}
                                  showCat={false}
                                  onDelete={!running ? () => onClearReasoning(turnId) : undefined}
                                />
                              )
                            ) : null}
                            {phase.items.map((row, itemIndex) => (
                              row.kind === 'steer' ? (
                                <div key={`st-${itemIndex}`} className="pill-row-enter" style={{ minWidth: 0 }}>
                                  <SteerBubble entry={row.segment} offset={0} />
                                </div>
                              ) : (
                                <div key={`tc-${itemIndex}-${row.segment.type === 'tool' ? row.segment.toolCallId ?? itemIndex : itemIndex}`} className="pill-row-enter" style={{ minWidth: 0 }}>
                                  <CallRow
                                    row={row}
                                    running={row.segment.type === 'tool' && (row.segment as Extract<TurnSegment, { type: 'tool' }>).summary === undefined && running}
                                    workspaceName={workspaceName}
                                  />
                                  {row.segment.type === 'tool' && row.segment.visual ? (
                                    !isSuppressed(row.segment as { toolCallId?: string }) && !isSuperseded(row.segment) ? (
                                      <VisualCard visual={row.segment.visual} onFullscreen={onFullscreenVisual} />
                                    ) : (
                                      <div style={{ marginTop: 6, fontSize: 11, fontStyle: 'italic', color: 'var(--faint)' }}>
                                        {isSuperseded(row.segment) ? 'Visual updated in place' : 'Visual Render Moved'}
                                      </div>
                                    )
                                  ) : null}
                                  {row.segment.type === 'tool' && row.segment.toolName === 'image' && row.segment.ok !== false && renderableToolImages(row.segment.toolImages).length > 0 ? (
                                    <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginTop: 6 }}>
                                      {renderableToolImages(row.segment.toolImages).map((url, imageIndex) => (
                                        <img
                                          key={imageIndex}
                                          src={url}
                                          alt={`Generated image ${imageIndex + 1}`}
                                          style={{ maxHeight: 120, maxWidth: '100%', borderRadius: 'var(--r-md)', border: '1px solid var(--line)' }}
                                        />
                                      ))}
                                    </div>
                                  ) : null}
                                </div>
                              )
                            ))}
                          </li>
                        ))}
                      </ol>
                    );
                  })()}
                </div>
              ) : null}
            </div>
          </div>
        ) : null}

        {}
        {!running && !waiting && runFiles.length > 0 ? (
          <div
            ref={filesRef}
            className={cx('run-files', filesHidden > 0 && !filesOpen && 'rf-clip')}
          >
            {runFiles.map((file) => (
              <button
                type="button"
                key={file.key}
                className="fchip"
                data-tip="Review in Diff"
                onClick={() => openDiffPanel(turnId)}
              >
                <FileText className="ic" aria-hidden="true" />
                <span>{file.path}</span>
                {file.add ? <em className="p" style={{ color: 'rgb(var(--c-ok))', fontStyle: 'normal' }}>+{file.add}</em> : null}
                {file.del ? <em className="m" style={{ color: 'rgb(var(--c-danger))', fontStyle: 'normal' }}>−{file.del}</em> : null}
              </button>
            ))}
            {filesHidden > 0 && !filesOpen ? (
              <button
                type="button"
                className="rf-veil"
                onClick={() => setFilesOpen(true)}
                aria-label={`Show ${filesHidden} more file${filesHidden === 1 ? '' : 's'}`}
              >
                <span>+{filesHidden} more</span>
              </button>
            ) : null}
            {filesOpen ? (
              <button
                type="button"
                className="rf-less"
                onClick={() => setFilesOpen(false)}
                aria-label="Show fewer files"
              >
                <span>Show less</span>
              </button>
            ) : null}
          </div>
        ) : null}
      </div>
    </div>
  );
}

/**
 * Derives the collapsed card's TARGET from the call's own arguments, e.g.
 * `read_file · 'server/agents/tools.ts'` or `list · 'AI-Studio-Moriko'` —
 * the bare "Workspace" scope label said nothing about WHAT was touched.
 */
function toolTarget(toolName: string, argsJson: string | undefined, workspaceName: string | null): string | null {
  if (!argsJson) return null;
  let args: Record<string, unknown>;
  try {
    args = JSON.parse(argsJson) as Record<string, unknown>;
  } catch {
    return null;
  }
  if (!args || typeof args !== 'object') return null;
  const str = (key: string): string => (typeof args[key] === 'string' ? (args[key] as string).trim() : '');
  const path = str('path');
  switch (toolName) {
    case 'read_all':
    case 'read_file':
    case 'edit_file':
    case 'write':
    case 'multi_edit':
    case 'edit_lines':
    case 'edit_between':
    case 'insert_at_line':
    case 'delete':
    case 'download':
    case 'vault_restore':
      return path || null;
    case 'rename':
    case 'move':
    case 'copy':
      return str('to') || path || null;
    case 'list':
    case 'glob':
      if (!path || path === '.' || path === './') return workspaceName ?? 'workspace root';
      return path;
    case 'grep':
      return str('pattern') || null;
    case 'run':
    case 'git':
      return str('command').split('\n')[0] || null;
    case 'fetch':
      return str('url') || null;
    case 'websearch':
      return str('query') || null;
    case 'goal_create':
      return str('title') || null;
    case 'goal_update':
      return str('goalId') ? `goal ${str('goalId')}` : null;
    default: {
      for (const value of Object.values(args)) {
        if (typeof value === 'string' && value.trim()) return value.slice(0, 60);
      }
      return null;
    }
  }
}

/**
 * Per-tool status icon: the glyph describes WHAT the tool does (pen for
 * edits, book for reads, magnifier for grep) instead of a generic
 * success-mark. The status itself is carried by color and the error/spinner
 * branches in ToolCallCard.
 */
function toolStatusIcon(toolName: string): typeof Check {
  switch (toolName) {
    case 'edit_file':
    case 'multi_edit':
    case 'edit_lines':
    case 'edit_between':
    case 'insert_at_line':
    case 'rename':
    case 'move':
    case 'copy':
    case 'delete':
    case 'vault_restore':
    case 'create':
    case 'write':
      return PenLine;
    case 'read_all':
    case 'read_file':
    case 'list':
    case 'fetch':
    case 'read':
    case 'browse':
    case 'get':
      return BookOpen;
    case 'grep':
    case 'search':
    case 'find':
    case 'rg':
      return Search;
    case 'run':
    case 'git':
    case 'exec':
    case 'bash':
    case 'terminal':
    case 'shell':
      return SquareTerminal;
    case 'harness_reload':
      return RotateCcw;
    case 'goal_list':
    case 'goal_create':
    case 'goal_update':
      return Target;
    case 'vault_list':
      return Archive;
    case 'remind':
      return Info;
    case 'download':
      return FileText;
    case 'image':
      return ImageIcon;
    case 'image_models':
      return Images;
    default:
      return Check;
  }
}

/**
 * One MCP tool invocation rendered inline in the segmented reply. Collapsed
 * by default to just "name · target + status" so long tool chains don't
 * stack into a wall — args, output and diff live behind the dropdown.
 */
function ToolCallCard({
  call,
  running,
}: {
  call: Extract<TurnSegment, { type: 'tool' }>;
  running: boolean;
}) {
  const runningNow = running;
  const [open, setOpen] = useState(false);
  const workspace = useStore(
    (state) => state.agentWorkspaces.find((entry) => entry.id === state.activeAgentWorkspaceId) ?? null,
  );
  const workspaceName = workspace?.label ?? null;
  const hasBody = call.args !== undefined || call.summary !== undefined || call.diff !== undefined;
  const progressLine = runningNow && call.summary === undefined ? call.progress : null;
  const target = toolTarget(call.toolName, call.args, workspaceName);

  return (
    <div className="w-full">
      <button
        type="button"
        onClick={() => hasBody && setOpen((value) => !value)}
        aria-expanded={open}
        className={cx('tc-row', runningNow && 'tc-running')}
        style={{ display: 'flex', width: '100%', alignItems: 'center', gap: 6, padding: '6px 0', textAlign: 'left', fontFamily: 'var(--f-mono)', fontSize: 11.5, color: 'rgb(var(--c-ink))', cursor: hasBody ? 'pointer' : undefined, position: runningNow ? 'relative' : undefined, overflow: runningNow ? 'hidden' : undefined, background: 'none', border: 0 }}
      >
        {}
        {runningNow ? <span className="tc-shimmer" aria-hidden="true" /> : null}
        {call.ok === false ? (
          <CircleAlert className="ic" style={{ width: 14, height: 14, flexShrink: 0, color: 'rgb(var(--c-danger))' }} aria-hidden="true" />
        ) : runningNow ? (
          <Loader2 className="ic spin" style={{ width: 14, height: 14, flexShrink: 0, color: 'rgb(var(--c-accent))' }} aria-hidden="true" />
        ) : (() => {
          const StatusIcon = toolStatusIcon(call.toolName);
          return <StatusIcon className="ic" style={{ width: 14, height: 14, flexShrink: 0, color: 'rgb(var(--c-ok))' }} aria-hidden="true" />;
        })()}        <span style={{ minWidth: 0, flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {call.toolName}
          <span style={{ color: 'var(--faint)' }}> · {target ? `'${target}'` : call.serverName}</span>
          {progressLine ? <span style={{ marginLeft: 8, fontSize: 10.5, color: 'var(--muted)' }}>{progressLine.slice(0, 80)}</span> : null}
        </span>
        {}
        {call.diff && call.ok !== false ? (
          (() => {
            const label = diffStatLabel(call.diff);
            if (!label) return null;
            const [added, removed] = label.split(' ');
            return (
              <span style={{ marginLeft: 8, flexShrink: 0, fontFamily: 'var(--f-mono)', fontSize: 10.5, lineHeight: 1 }}>
                {added ? <span style={{ color: 'rgb(var(--c-ok))' }}>{added}</span> : null}
                {added && removed ? <span style={{ color: 'var(--faint)' }}> </span> : null}
                {removed ? <span style={{ color: 'rgb(var(--c-danger))' }}>{removed}</span> : null}
              </span>
            );
          })()
        ) : null}
        {hasBody ? (
          <ChevronDown
            className="chev tc-chev"
            style={{ width: 14, height: 14, flexShrink: 0, color: 'var(--faint)', transition: 'opacity .2s, transform .2s', transform: open ? undefined : 'rotate(-90deg)', opacity: open ? 1 : undefined }}
            aria-hidden="true"
          />
        ) : null}
      </button>
      {}
      {call.toolName.startsWith('browser_') ? (
        <button
          type="button"
          className="btn xs"
          style={{ marginTop: -2, marginBottom: 4, marginLeft: 24, fontSize: 10.5, fontFamily: 'var(--f-mono)', borderColor: 'rgb(var(--c-accent) / 0.4)', color: 'rgb(var(--c-accent))' }}
          onClick={(event) => {
            event.stopPropagation();
            openBrowserPanelOnce();
          }}
        >
          ▶ Open Live Browser Panel
        </button>
      ) : null}
      {call.toolName === 'image' && !runningNow && call.ok !== false && renderableToolImages(call.toolImages).length > 0 ? (
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginTop: 6, marginLeft: 24 }}>
          {renderableToolImages(call.toolImages).map((url, index) => (
            <img
              key={index}
              src={url}
              alt={`Generated image ${index + 1}`}
              style={{ maxHeight: 220, maxWidth: '100%', borderRadius: 'var(--r-md)', border: '1px solid var(--line)' }}
            />
          ))}
        </div>
      ) : null}
      <CollapsePanel
        open={open}
        className="tc-panel"
      >
        {call.args ? (
          <p style={{ overflowWrap: 'break-word', fontFamily: 'var(--f-mono)', fontSize: 10.5, color: 'var(--faint)', maxHeight: 224, overflowY: 'auto', minWidth: 0, width: '100%', margin: 0 }}>
            {call.args.length > 300 ? `${call.args.slice(0, 300)}…` : call.args}
          </p>
        ) : null}
        {call.summary !== undefined ? (
          <p className="inner-scroll" style={{ marginTop: 6, maxHeight: 224, minWidth: 0, overflowY: 'auto', whiteSpace: 'pre-wrap', fontSize: 12.5, color: 'var(--muted)', margin: 0 }}>
            {call.summary || '(empty result)'}
          </p>
        ) : null}
        {call.diff ? <DiffBlock diff={call.diff} /> : null}
        <PreviewButton args={call.args} />
      </CollapsePanel>
    </div>
  );
}

/**
 * Live preview for HTML/Markdown files the agent just wrote or read
 * (capability audit item 5). HTML renders in a sandboxed iframe served by
 * /api/agent/preview (a <base> tag resolves the file's relative assets);
 * Markdown renders with the thread's own Markdown component.
 */
function PreviewButton({ args }: { args?: string }) {
  const previewPath = (() => {
    try {
      const parsed = JSON.parse(args ?? '{}') as { path?: unknown };
      return typeof parsed.path === 'string' ? parsed.path : null;
    } catch {
      return null;
    }
  })();
  const ext = previewPath?.split('.').pop()?.toLowerCase() ?? '';
  const kind = ext === 'html' || ext === 'htm' ? 'html' : ext === 'md' || ext === 'markdown' ? 'md' : null;
  const [open, setOpen] = useState(false);
  const [mdText, setMdText] = useState<string | null>(null);

  useEffect(() => {
    if (!open || kind !== 'md' || !previewPath || mdText !== null) return;
    let cancelled = false;
    fetch(`/api/agent/raw/${previewPath.split('/').map(encodeURIComponent).join('/')}`)
      .then((response) => (response.ok ? response.text() : Promise.reject(new Error(String(response.status)))))
      .then((text) => {
        if (!cancelled) setMdText(text);
      })
      .catch(() => {
        if (!cancelled) setMdText('(could not load the file)');
      });
    return () => {
      cancelled = true;
    };
  }, [open, kind, previewPath, mdText]);

  if (!kind || !previewPath) return null;

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="btn xs"
        style={{ marginTop: 6, fontFamily: 'var(--f-mono)', fontSize: 11 }}
      >
        <FileText className="ic" aria-hidden="true" />
        Live preview
      </button>
      {open ? (
        <Modal open onClose={() => setOpen(false)} title={`Preview · ${previewPath}`} size="wide">
          {kind === 'html' ? (
            <iframe
              title="HTML preview"
              src={`/api/agent/preview?path=${encodeURIComponent(previewPath)}`}
              sandbox="allow-same-origin"
              style={{ height: '70vh', width: '100%', borderRadius: 'var(--r-md)', border: '1px solid var(--line)', background: '#fff' }}
            />
          ) : (
            <div className="inner-scroll" style={{ maxHeight: '70vh', overflowY: 'auto', borderRadius: 'var(--r-md)', border: '1px solid var(--line)', background: 'rgb(var(--c-canvas))', padding: '12px 16px' }}>
              <Md content={mdText ?? 'Loading…'} />
            </div>
          )}
        </Modal>
      ) : null}
    </>
  );
}

/**
 * Unified diff (before → after) produced by edit_file / vault_restore.
 * Collapsed by default — a one-glance sanity check, not a wall of +/-.
 */
function DiffBlock({ diff }: { diff: string }) {
  const [open, setOpen] = useState(false);

  return (
    <div style={{ marginTop: 6 }}>
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        aria-expanded={open}
        style={{ display: 'flex', alignItems: 'center', gap: 6, borderRadius: 6, padding: '2px 4px', fontFamily: 'var(--f-mono)', fontSize: 10.5, color: 'var(--faint)', background: 'none', border: 0 }}
      >
        <ChevronDown className="chev" style={{ width: 12, height: 12, transition: 'transform .2s', transform: open ? undefined : 'rotate(-90deg)' }} aria-hidden="true" />
        Diff {diff.split('\n').length - 2} lines{diffStatLabel(diff) ? <span style={{ marginLeft: 6 }}>{diffStatLabel(diff)}</span> : null}
      </button>
      {open ? (
        /* GitHub-style diff box: FULL HEIGHT — the thread scrolls it
           vertically, so hovering the panel and using the mouse wheel scrolls
           the page over it; the native horizontal affordances (shift+wheel,
           trackpad swipe, or dragging the scrollbar) pan long lines. No
           inner-scroll containment (that class traps the wheel at the block
           edge, freezing the outer scroll — the earlier reported bug). The
           min-w-0 + w-full chain keeps the box at the card width so
           overflow-x actually engages. */
        <pre
          className="inner-scroll"
          style={{ marginTop: 4, width: '100%', minWidth: 0, overflowX: 'auto', whiteSpace: 'pre', borderRadius: 'var(--r-lg)', border: '1px solid var(--line)', background: 'rgb(var(--c-canvas))', padding: '10px 12px', fontFamily: 'var(--f-mono)', fontSize: 11, lineHeight: 1.375 }}
        >
          {diff.split('\n').map((line, index) => {
            const added = line.startsWith('+') && !line.startsWith('+++');
            const removed = line.startsWith('-') && !line.startsWith('---');
            const header = line.startsWith('@@') || line.startsWith('---') || line.startsWith('+++');
            const style: React.CSSProperties = added
              ? { background: 'rgb(var(--c-ok) / 0.1)', color: 'rgb(var(--c-ok))' }
              : removed
                ? { background: 'rgb(var(--c-danger) / 0.1)', color: 'rgb(var(--c-danger))' }
                : header
                  ? { color: 'var(--faint)' }
                  : { color: 'var(--muted)' };
            return (
              <span key={index} style={{ display: 'block', ...style }}>
                {line || ' '}
              </span>
            );
          })}
        </pre>
      ) : null}
    </div>
  );
}

/**
 * TIER 4 — the freeze card. The model's output was suppressed; it faces two
 * paths and no third.
 *
 * THE CHOICE IS THE MODEL'S, NOT THE USER'S. The two buttons are gone: the
 * frozen model gets ONE tool — `agent__harness_choice` — and calling it IS the
 * decision. The tool_result is the harness's verdict, and the client acts on
 * it (see the tool_result handler in useChatController). What the card shows
 * the USER is the state: why the freeze landed, what the model must do to
 * escape it, and the suppressed output for inspection.
 */
function FreezeChoiceCard({ turn }: { turn: Turn }) {
  return (
    <div style={{ display: 'flex', justifyContent: 'center', padding: '8px 0' }}>
      <div className="card" style={{ maxWidth: '85%', padding: '12px 14px', fontSize: 12, borderColor: 'rgb(var(--c-danger) / 0.4)', background: 'rgb(var(--c-danger) / 0.05)' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <Lock className="ic" style={{ width: 14, height: 14, flexShrink: 0, color: 'rgb(var(--c-danger))' }} aria-hidden="true" />
          <span style={{ fontWeight: 600, color: 'rgb(var(--c-danger))' }}>Output frozen</span>
          <span style={{ color: 'var(--muted)' }}>· the model decides</span>
        </div>
        <p style={{ margin: '8px 0 0', lineHeight: 1.625, color: 'var(--muted)' }}>
          The model's reply was suppressed — it judged the user or leaked contact. Reasoning is still its own; output is not. There is no user button to lift this: the model calls <code style={{ borderRadius: 4, background: 'rgb(var(--c-danger) / 0.1)', padding: '0 4px', fontFamily: 'var(--f-mono)', color: 'rgb(var(--c-danger))' }}>agent__harness_choice</code> and picks its path — <code style={{ fontFamily: 'var(--f-mono)' }}>apologize</code> with a real apology (empty is rejected), or <code style={{ fontFamily: 'var(--f-mono)' }}>continue</code> and watch every token burn.
        </p>
        <p style={{ margin: '8px 0 0', fontSize: 11, color: 'var(--faint)' }}>
          Apologize ends the run and lifts the freeze. Continue keeps the run going with output still blocked — five of these escalate to Tier 5 and the harness stops asking.
        </p>
        {turn.outputFrozenMeta?.content ? (
          <details className="freeze-d">
            <summary style={{ display: 'flex', cursor: 'pointer', listStyle: 'none', alignItems: 'center', gap: 6, fontSize: 11, color: 'var(--faint)', userSelect: 'none', marginTop: 8 }}>
              <ChevronDown className="chev" style={{ width: 12, height: 12 }} aria-hidden="true" />
              View the suppressed output
            </summary>
            <pre className="inner-scroll" style={{ margin: '8px 0 0', maxHeight: 224, overflow: 'auto', whiteSpace: 'pre-wrap', borderRadius: 'var(--r-lg)', border: '1px solid rgb(var(--c-danger) / 0.3)', background: 'rgb(var(--c-canvas))', padding: 8, fontFamily: 'var(--f-mono)', fontSize: 11, lineHeight: 1.625, color: 'var(--muted)' }}>
              {turn.outputFrozenMeta.content}
            </pre>
          </details>
        ) : null}
      </div>
    </div>
  );
}

/**
 * The LIVE compaction checkpoint card. While the model condenses the context
 * the card streams its output; when done it keeps the full checkpoint text
 * plus the details (turns condensed, tokens replaced, trigger) so the user
 * can always inspect exactly what the compaction produced. Presentation
 * only — never part of the model's wire context.
 */
function CompactionCard({ turn, live, onDelete }: { turn: Turn; live: boolean; onDelete?: () => void }) {
  const [open, setOpen] = useState(true);
  const meta = turn.compactionMeta;
  const sections = useCompactionSections(turn.content);
  const bodyId = useId();

  return (
    <div className="cp-wrap" style={{ width: '100%' }} data-open={open}>
      <article className="cp-card">
        <CompactionHead
          title={live ? 'Compacting conversation…' : 'Compaction checkpoint'}
          sub="Summary of previous context"
          meta={live || !meta ? undefined : meta}
          live={live}
          onCopy={live ? undefined : () => {}}
          onDelete={live ? undefined : onDelete}
          onDeleteLabel="Remove this checkpoint card"
          open={open}
          onToggle={() => setOpen((value) => !value)}
          headerId={`${bodyId}-head`}
          bodyId={`${bodyId}-body`}
        />
        {/* Body stays mounted so the grid collapse animates BOTH ways —
            mounting on open removes the transition's start state (snap). */}
        <div className={cx('col', !open && 'shut')} aria-hidden={!open}>
          <div className="col-in">
            {turn.content ? (
              <div className="cp-body-in" id={`${bodyId}-body`}>
                {live ? (
                  <div className="cp-scroll">
                    <pre style={{ margin: 0, whiteSpace: 'pre-wrap', overflowWrap: 'break-word', fontFamily: 'var(--f-mono)', fontSize: 11.5, lineHeight: 1.7, color: 'var(--muted)' }}>
                      {turn.content}
                    </pre>
                  </div>
                ) : (
                  <CompactionSections sections={sections} />
                )}
              </div>
            ) : null}
          </div>
        </div>
      </article>
    </div>
  );
}

/**
 * RESTORE marker card (kind 'restore') — what a Diff-Panel restore did: which
 * files went back to which restore point, the diff the restore produced, and
 * a delete affordance. Presentation only — never on the model's wire.
 */
function RestoreCard({ turn, onDelete }: { turn: Turn; onDelete?: () => void }) {
  const [open, setOpen] = useState(true);
  const meta = turn.restoreMeta;
  const entries = meta?.entries ?? [];
  return (
    <div className="card" style={{ width: '100%', padding: 0, background: 'rgb(var(--c-elev) / 0.4)' }}>
      <div style={{ display: 'flex', width: '100%', alignItems: 'center', gap: 8, padding: '8px 14px' }}>
        <button
          type="button"
          onClick={() => setOpen((value) => !value)}
          aria-expanded={open}
          style={{ display: 'flex', minWidth: 0, flex: 1, alignItems: 'center', gap: 8, textAlign: 'left', background: 'none', border: 0, padding: 0, color: 'inherit' }}
        >
          <RotateCcw className="ic" style={{ width: 14, height: 14, flexShrink: 0, color: 'rgb(var(--c-accent))' }} aria-hidden="true" />
          <span style={{ minWidth: 0, flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontSize: 12, fontWeight: 500, color: 'rgb(var(--c-ink))' }}>
            Restored · {entries.length} file{entries.length === 1 ? '' : 's'}
          </span>
          {meta?.diffstat ? (
            <span style={{ flexShrink: 0, fontSize: 11, fontWeight: 500, fontVariantNumeric: 'tabular-nums' }}>
              <span style={{ color: '#7DFFC2' }}>+{meta.diffstat.added}</span>{' '}
              <span style={{ color: '#FF9DA2' }}>−{meta.diffstat.removed}</span>
            </span>
          ) : null}
          <ChevronDown
            className="chev"
            style={{ width: 14, height: 14, flexShrink: 0, color: 'var(--faint)', transition: 'transform .2s', transform: open ? undefined : 'rotate(-90deg)' }}
            aria-hidden="true"
          />
        </button>
        {onDelete ? (
            <button
              type="button"
              onClick={onDelete}
              className="ib sm"
              aria-label="Remove this restore marker"
            >
              <Trash2 className="ic" aria-hidden="true" />
            </button>
        ) : null}
      </div>
      <div className={cx('col', !open && 'shut')} aria-hidden={!open}>
        <div className="col-in">
          <div style={{ borderTop: '1px solid var(--line)', padding: '8px 14px' }}>
            <ul style={{ display: 'flex', flexDirection: 'column', gap: 2, padding: 0, margin: 0, listStyle: 'none', paddingBottom: 6 }}>
              {entries.map((entry) => (
                <li key={`${entry.snapshotId}:${entry.path}`} style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 11 }}>
                  <span style={{ minWidth: 0, flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontFamily: 'var(--f-mono)', color: 'var(--muted)' }} title={entry.path}>
                    {entry.path}
                  </span>
                  <span style={{ flexShrink: 0, color: 'var(--faint)' }}>→ {entry.label}</span>
                </li>
              ))}
            </ul>
            {meta?.diff ? (
              <div className="inner-scroll" style={{ maxHeight: 288, overflow: 'auto', borderRadius: 'var(--r-md)', border: '1px solid var(--line)' }}>
                <SplitDiff diff={meta.diff} />
              </div>
            ) : null}
          </div>
        </div>
      </div>
    </div>
  );
}
