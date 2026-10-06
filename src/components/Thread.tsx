import {
  memo,
  startTransition,
  useCallback,
  useDeferredValue,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import {
  AlertTriangle,
  Archive,
  BookOpen,
  Check,
  ChevronDown,
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
} from './icons';

import type { ConversationCompaction, Turn, TurnInjection, TurnSegment } from '../types';
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
    <div className="group ml-auto flex max-w-[80%] flex-col items-end gap-1">
      <div className="flex items-center gap-1.5 text-[11px] font-medium text-faint">
        <Loader2 className="h-3 w-3 animate-spin text-accent" aria-hidden="true" />
        <span>You · steering (queued — delivered between tool rounds)</span>
      </div>
      {images.length > 0 ? (
        <div className="flex flex-wrap justify-end gap-1.5">
          {images.map((image, index) => (
            <img
              key={index}
              src={image.type === 'image_url' ? renderableRefUrl(image.image_url.url) : ''}
              alt="Steered image"
              className="max-h-40 max-w-full rounded-lg border border-hairline object-contain"
            />
          ))}
        </div>
      ) : null}
      {text.trim() ? (
        <div className="w-full rounded-card rounded-br-sm border border-accent/30 bg-accent-soft/60 px-4 py-3 opacity-90">
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
      scroller = endRef.current?.closest('.overflow-y-auto') ?? null;
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
      // The glide is a PINNED affordance: the moment the user scrolls up the
      // follow must die, or the loop keeps yanking toward the bottom while
      // they read — the exact "aggressive pull" failure. One frame max of
      // overshoot after the unpin.
      if (!pinnedRef.current) {
        glideRafRef.current = 0;
        return;
      }
      const element = resolveScroller();
      if (!element) {
        glideRafRef.current = 0;
        return;
      }
      // CLAMPED TARGET — content shorter than the viewport yields a negative
      // offset; without the clamp the loop stepped at a stuck scrollTop
      // forever, and the stuck handle made every later ensureGlide() call a
      // no-op (the dead "jump to latest" arrow).
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
        // NO-PROGRESS STOP — clamped at the edge: settle here instead of
        // spinning this raf forever.
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
    // rAF-throttle: batch layout reads (scrollTop/scrollHeight/clientHeight)
    // to one per frame. Without this, each scroll event forces sync layout
    // (720 samples in flamegraph2) — devastating when the left sidebar
    // narrows the container and dirties layout for every row.
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
        // RE-PIN GUARD: only a DOWNWARD scroll that reaches the bottom re-pins.
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
      // CLAMPED TARGET — a row near the thread's end cannot always reach the
      // viewport top; targeting past the edge used to spin forever.
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
    // A teleport is a deliberate landing spot, never "following the edge":
    // unpin so the streaming follow glide can't drag the restore to the bottom,
    // and so the settle loop always runs (it previously bailed when the target
    // sat near the end — the view then drifted to an earlier turn: "44 → 40").
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
        turn.segments?.map((segment) => (segment.type === 'tool' ? `t${segment.toolName}${segment.summary === undefined ? '!' : String((segment.summary ?? '').length)}` : String(segment.text.length))).join('+') ?? '',
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
      // ALREADY MOUNTED — navigate WITHOUT touching the window. The rail only
      // shows dots for mounted turns, so a dot click is always this case; the
      // old unconditional expansion mounted every hidden row and the rail
      // suddenly showed checkpoints 1..N for a target already on screen.
      if (row && scroller) {
        // LIVE target: re-read the row's offset every frame — rows below the
        // fold are content-visibility estimates and shift as they materialize.
        navigateTo(() => row.getBoundingClientRect().top - scroller.getBoundingClientRect().top + scroller.scrollTop);
        return;
      }
      // Target OUTSIDE the render window: expand so it can mount, then
      // resolve after the expanded window commits (pendingTurnRef effect).
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

  // Settle stops on user gesture — the reader owns the view the moment they move.
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
    // windowSize here is read on purpose but NOT a dep: it only decides
    // whether a window reset is pending; the restore effect watches the
    // reset itself (windowSize) and performs the wait→active transition.
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
      // While an anchor is pending/settling the view is not final — measuring
      // it would overwrite the good anchor with boot layout and clobber the
      // very restore it was meant to serve.
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
      // UNLOAD-SAFE: a fetch() fired from pagehide is cancelled by the page
      // teardown before it lands (the anchor silently vanished on refresh),
      // and storage's own pagehide beacon runs BEFORE this listener so it
      // cannot pick the write up. sendBeacon HERE — after the write.
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
      if (deferredTurns.length === 0) return; // body still hydrating — wait
      if (windowSize < deferredTurns.length) {
        const sisa = deferredTurns.length - windowSize;
        startTransition(() =>
          setWindowSize((size) =>
            Math.min(deferredTurns.length, size + Math.max(WINDOW_CHUNK, Math.ceil(sisa / 4))),
          ),
        );
      } else {
        anchorPhaseRef.current = 'idle'; // anchor turn deleted — keep default
      }
      return;
    }
    // Land once, then SETTLE (see the loop above): the scroll range may even
    // clamp the target here because the body is still short — the loop keeps
    // re-placing the row as lazy content above it hydrates.
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
      className="relative mx-auto w-full max-w-4xl px-6 pt-8"
      style={{ paddingBottom: bottomPad }}
    >
      <div className="space-y-6">
        {crashedRun ? (
          <div className="flex items-start gap-3 rounded-lg border border-amber-500/40 bg-amber-500/10 p-3 text-sm">
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-amber-600 dark:text-amber-400" />
            <div className="flex-1 space-y-2">
              <div className="font-medium text-ink">
                This run was interrupted — the proxy died before it finished.
              </div>
              <div className="text-muted">
                Everything the run produced is still in this thread. Resuming
                re-sends the history and replays the {crashedRun.callCount} already-executed tool
                {' '}
                {crashedRun.callCount === 1 ? 'call' : 'calls'} from the journal without executing them
                {' '}
                again — no double edits, no duplicate deletes.
              </div>
            </div>
            <div className="flex shrink-0 items-center gap-2">
              <button
                type="button"
                className="rounded-md bg-accent px-3 py-1.5 text-xs font-medium text-white hover:bg-accent/90"
                onClick={() => {
                  if (activeId) resumeCrashedRun(activeId, crashedRun.runId);
                }}
              >
                Resume run
              </button>
              <button
                type="button"
                className="rounded-md px-2 py-1.5 text-xs text-muted hover:text-ink"
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
          <div className="flex justify-center">
            <button
              type="button"
              onClick={loadEarlier}
              className="pill-button inline-flex items-center gap-1.5 border border-hairline bg-elevated px-3 py-1.5 text-[12px] text-muted transition-colors hover:border-accent/50 hover:text-ink"
            >
              <ChevronUp className="h-3.5 w-3.5" aria-hidden="true" />
              Load {Math.min(WINDOW_CHUNK, hiddenCount)} earlier message
              {Math.min(WINDOW_CHUNK, hiddenCount) === 1 ? '' : 's'}
              <span className="text-faint">· {hiddenCount} hidden</span>
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
          <div className="space-y-3">
            {pendingSteers.map((entry) => (
              <PendingSteerBubble key={entry.id} text={entry.text} parts={entry.parts} />
            ))}
          </div>
        ) : null}
        <div ref={endRef} />
      </div>
      {/* FASE 5 — addon render site: thread-sidebar widgets after the last turn */}
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
const StreamText = memo(function StreamText({ text, live, className }: { text: string; live: boolean; className?: string }) {
  if (!live) return <Md content={text} className={className} />;
  const { prefix, tail } = splitStablePrefix(text);
  if (!prefix) return <Md content={text} className={className} />;
  return (
    <>
      <Md content={prefix} className={className} />
      <Md content={tail} className={className} />
    </>
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
    // 6D: for assistant outputs, seed the draft from the RENDERED text —
    // when segments exist, `content` alone is stale (the wire rebuilds the
    // reply from segments, so an edit that only touched content was a no-op).
    // The editor drafts ONLY the final output — the last text segment —
    // because that is exactly what saving replaces (tool rounds, steers and
    // intermediate ● rows are untouched by an edit).
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
      // The edit replaces ONLY the final text segment. Tool calls, steer
      // entries, intermediate ● texts and reasoning all stay intact — the wire
      // rebuilds native tool rounds from them and the pill keeps its history.
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
      <div className="flex justify-center py-1.5">
        <details className="group/goal max-w-[85%] rounded-card border border-hairline bg-surface/60 px-3 py-1.5 text-[11px] text-faint">
          <summary className="flex cursor-pointer list-none items-center gap-1.5 select-none">
            <Target className="h-3 w-3 shrink-0" aria-hidden="true" />
            <span className="font-medium text-ink">
              Goal · Round {turn.goalMeta?.round ?? '?'}{turn.goalMeta?.maxRounds ? `/${turn.goalMeta.maxRounds}` : ''}
            </span>
            <span className="text-faint">· {turn.goalMeta?.full === false ? 'Continuation' : 'Context injection'}</span>
            <ChevronDown className="h-3 w-3 transition-transform group-open/goal:rotate-180" aria-hidden="true" />
          </summary>
          <pre className="inner-scroll mt-2 max-h-64 overflow-auto whitespace-pre-wrap text-left font-mono text-[10.5px] leading-relaxed text-faint">
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
        <div className="flex justify-center py-2">
          <div className="max-w-[85%] rounded-card border border-danger/40 bg-danger/5 px-3.5 py-3 text-[12px]">
            <div className="flex items-center gap-1.5">
              <AlertTriangle className="h-3.5 w-3.5 shrink-0 text-danger" aria-hidden="true" />
              <span className="font-semibold text-danger">Probation</span>
              <span className="text-muted">· Tier 5 — terminated</span>
            </div>
            <p className="mt-2 leading-relaxed text-muted">
              The model chose Continue five times rather than apologize. The harness closed its reasoning at the first second and terminated the run at its first output token. This conversation is over for the model.
            </p>
            {turn.probationMeta?.reason ? (
              <p className="mt-2 text-[11px] text-faint">Evidence: {turn.probationMeta.reason}</p>
            ) : null}
          </div>
        </div>
      );
    }
    const tier = turn.probationMeta?.tier ?? 1;
    return (
      <div className="flex justify-center py-2">
        <div className="max-w-[85%] rounded-card border border-warn/40 bg-warn/5 px-3 py-2 text-[12px]">
          <div className="flex items-center gap-1.5">
            <AlertTriangle className="h-3.5 w-3.5 shrink-0 text-warn" aria-hidden="true" />
            <span className="font-semibold text-warn">Probation</span>
            <span className="text-muted">· Tier {tier}</span>
          </div>
          <pre className="inner-scroll mt-2 max-h-56 overflow-auto whitespace-pre-wrap text-left font-mono text-[11px] leading-relaxed text-muted">
            {turn.content}
          </pre>
          {turn.probationMeta?.reason ? (
            <p className="mt-2 text-[11px] text-faint">Evidence: {turn.probationMeta.reason}</p>
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
      <div className="group/lockdown-row flex justify-center py-2">
        <details className="group/lockdown max-w-[85%] rounded-card border border-danger/40 bg-danger/5 px-3 py-2 text-[12px]">
          <summary className="flex cursor-pointer list-none items-center gap-1.5 select-none">
            <Lock className="h-3.5 w-3.5 shrink-0 text-danger" aria-hidden="true" />
            <span className="font-semibold text-danger">
              {turn.kind === 'lockdown' ? 'Lockdown enforced' : `Enforcement L${level} enforced`}
            </span>
            <span className="text-muted">
              · {reason ? 'with reason' : 'no reason given'}
            </span>
            <ChevronDown className="h-3 w-3 text-muted transition-transform group-open/lockdown:rotate-180" aria-hidden="true" />
          </summary>
          <div className="mt-2 flex items-start gap-2">
            <pre className="inner-scroll max-h-72 flex-1 overflow-auto whitespace-pre-wrap text-left font-mono text-[11px] leading-relaxed text-muted">
              {turn.content}
            </pre>
            <Tip label="Delete this notice (and its reply)">
              <button
                type="button"
                onClick={removeNotice}
                className="icon-button h-7 w-7 shrink-0 opacity-0 transition-opacity group-hover/lockdown-row:opacity-100"
                aria-label="Delete this enforcement notice"
              >
                <Trash2 className="h-3.5 w-3.5" aria-hidden="true" />
              </button>
            </Tip>
          </div>
        </details>
      </div>
    );
  }

  if (turn.role === 'user') {
    return (
      <div className="group flex flex-col items-end gap-1">
        {}
        {turnNumber ? (
          <div className="self-start text-[10.5px] font-semibold uppercase tracking-[0.08em] text-faint">
            Turn {turnNumber}
          </div>
        ) : null}
        {}
        <div className="flex items-center gap-1.5 pr-0.5 text-[14px] font-medium text-faint">
          <User className="h-3.5 w-3.5" aria-hidden="true" />
          User
        </div>
        {}
        {turn.attachments?.length ? (
          // GALLERY-STYLE ATTACHMENTS — OUTSIDE the bubble: a separate row of
          // small square thumbnails (cover-crop, rounded) sitting ABOVE the
          // text bubble, exactly like the reference layout. The bubble below
          // holds ONLY the message text. SVG attachments carry their XML as
          // textContent — preview them as an image via an inline data URL.
          <div className="flex max-w-[85%] flex-wrap items-center justify-end gap-2">
            {turn.attachments.map((attachment) =>
              attachment.mime.startsWith('image/') && (attachment.dataRef || attachment.dataUrl || attachment.textContent) ? (
                <a
                  key={attachment.id}
                  href={attachment.dataRef
                    ? attachmentRefUrl(attachment.dataRef.hash, attachment.dataRef.mime)
                    : attachment.dataUrl ?? `data:image/svg+xml;utf8,${encodeURIComponent(attachment.textContent ?? '')}`}
                  target="_blank"
                  rel="noreferrer"
                  className="block h-[76px] w-[76px] shrink-0 overflow-hidden rounded-2xl border border-hairline transition-transform duration-150 hover:scale-[1.03]"
                >
                  <img
                    src={attachment.dataRef
                      ? attachmentRefUrl(attachment.dataRef.hash, attachment.dataRef.mime)
                      : attachment.dataUrl ?? `data:image/svg+xml;utf8,${encodeURIComponent(attachment.textContent ?? '')}`}
                    alt={attachment.name}
                    {...(attachment.width && attachment.height
                      ? { width: attachment.width, height: attachment.height }
                      : {})}
                    className="h-full w-full object-cover"
                  />
                </a>
              ) : (
                <span
                  key={attachment.id}
                  className="inline-flex h-[76px] w-[76px] flex-col items-center justify-center gap-1 rounded-2xl border border-hairline bg-surface px-1 text-center"
                >
                  <Tip label={attachment.name}>
                    <FileText className="h-4 w-4 shrink-0 text-faint" aria-hidden="true" />
                  </Tip>
                  <span className="w-full truncate text-[10px] text-muted">{attachment.name}</span>
                </span>
              ),
            )}
          </div>
        ) : null}
        <div
          className={cx(
            'user-bubble rounded-card rounded-br-sm border border-hairline px-4 py-3',
            editing ? 'w-[85%]' : 'max-w-[85%]',
          )}
        >
          {editing ? (
            <div className="space-y-2">
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
                className="w-full resize-y rounded-control border border-accent/60 bg-canvas p-2.5 text-[14px] leading-relaxed text-ink outline-none"
              />
              <div className="flex justify-end gap-1.5">
                <button
                  type="button"
                  onClick={() => setEditing(false)}
                  className="inline-flex items-center gap-1 rounded-control px-2.5 py-1.5 text-[11.5px] font-medium text-muted transition-colors hover:text-ink"
                >
                  <X className="h-3 w-3" aria-hidden="true" />
                  Cancel
                </button>
                <button
                  type="button"
                  onClick={saveEdit}
                  disabled={!draft.trim()}
                  className="inline-flex items-center gap-1 rounded-control bg-accent px-2.5 py-1.5 text-[11.5px] font-medium text-accent-ink transition-opacity disabled:opacity-40"
                >
                  <Check className="h-3 w-3" aria-hidden="true" />
                  Save
                </button>
              </div>
            </div>
          ) : turn.content ? (
            <Md content={turn.content} breakLines />
          ) : !streaming ? (
            <p className="text-[13px] italic text-faint">(empty message)</p>
          ) : null}
        </div>
        {}
        {!editing && !(streaming && isLast) ? (
          <div className="flex items-center gap-1 pr-1 opacity-0 transition-opacity duration-200 group-hover:opacity-100 focus-within:opacity-100">
            <CopyButton text={turn.content} />
            <button
              type="button"
              onClick={startEdit}
              className="icon-button h-7 w-7"
              aria-label="Edit this message"
            >
              <Pencil className="h-3.5 w-3.5" aria-hidden="true" />
            </button>
              <button
                type="button"
                onClick={() => onDeleteTurn(turn.id)}
                className="icon-button h-7 w-7"
                aria-label="Delete this message"
              >
                <Trash2 className="h-3.5 w-3.5" aria-hidden="true" />
              </button>
          </div>
        ) : null}
        {}
        {isEffectivelyLast && !streaming ? (
          <div className="flex items-center gap-1.5">
            <button
              type="button"
              onClick={onContinue}
              className="pill-button border border-hairline bg-elevated py-1.5 text-[12px] text-muted transition-colors hover:border-accent/50 hover:text-ink"
              aria-label="Continue the model's response"
            >
              <CornerDownLeft className="h-3.5 w-3.5" aria-hidden="true" />
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
    <div className="flex flex-col items-start gap-2">
      {}
      {(turn.injections ?? []).map((injection) => (
        <InjectionBlock key={injection.id} injection={injection} />
      ))}

      {turn.reasoning && !hasReasoningSegments ? (
        <ReasoningBlock
          text={turn.reasoning}
          live={isLast && streaming}
          showCat={isEffectivelyLast}
          onDelete={!streaming ? () => onClearReasoning(turn.id) : undefined}
        />
      ) : null}

      {}
      {/* SINGLE EXPANDING PILL (spec v2): ONE pill per assistant turn holding
          EVERY reasoning, tool call, and intermediate text (● rows) in a flat
          append-only list. Only the FINAL text — the turn's last event with no
          work after it — renders OUTSIDE below the pill. If text gets more
          tool calls after it, it is retroactively intermediate and moves
          inside the pill as a ● row (derived from segment order, nothing is
          re-parented at render time). */}
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
                // NO-LEAK RULE: while the run streams, NOTHING renders below
                // the pill — every text is a live ● row inside the panel until
                // the turn settles. Only then is the last text promoted out.
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

          // TS control-flow can't see writes from inside the forEach closure —
          // take an explicitly-typed copy before rendering.
          const finalTextOut = finalText as Extract<TurnSegment, { type: 'text' }> | null;

          // VISUAL HOIST: the newest render_visual card renders OUTSIDE the
          // pill — the artifact is a product, not a step. Older visuals stay
          // inside the pill as history. The visual hoists whenever the run
          // has settled, even with trailing reasoning/final text after it
          // (verified live: the model writes reasoning + a closing paragraph
          // AFTER the visual — requiring the visual to be the absolute last
          // work event made the hoist almost never fire). Only a later WORK
          // event (another tool call or a steer) or an in-flight run keeps
          // the visual inside the pill.
          const hoistedVisualSegment = (() => {
            if (turnRunning) return null;
            for (let i = turn.segments.length - 1; i >= 0; i--) {
              const segment = turn.segments[i];
              if (segment.type === 'tool' && segment.visual) return segment;
              // Trailing reasoning/final text is explanation, not work — it
              // never blocks the hoist.
              if (segment.type === 'text' || segment.type === 'reasoning') continue;
              return null;
            }
            return null;
          })();
          const hoistedVisual = hoistedVisualSegment?.visual ?? null;
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
                <ActivityTicker
                  activity={rows}
                  running={isLast && streaming}
                  turnId={turn.id}
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
                  <div className="mt-1.5 text-[11px] italic text-faint">Visual updated in place</div>
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

      {turn.finishReason && FINISH_NOTES[turn.finishReason] ? (
        <div className="w-full rounded-card border border-warning/30 bg-warning/5 px-4 py-2.5">
          <div className="flex items-start gap-2.5">
            {}
            <Info className="mt-0.5 h-4 w-4 shrink-0 text-warning" aria-hidden="true" />
            <p className="text-[13px] leading-snug text-muted">{FINISH_NOTES[turn.finishReason]}</p>
            {}
            {}
            {turn.finishReason === 'tool_errors' && !turn.error && isEffectivelyLast && !streaming ? (
              <button
                type="button"
                onClick={onContinue}
                className="pill-button ml-2 shrink-0 border border-warning/40 bg-elevated py-1.5 text-[12px] text-muted transition-colors hover:border-warning/60 hover:text-ink"
                aria-label="Continue after the failed tools"
              >
                <CornerDownLeft className="h-3.5 w-3.5" aria-hidden="true" />
                Continue
              </button>
            ) : null}
          </div>
        </div>
      ) : null}

      {/* RESPONSE TIMER — live count DI BAWAH pill saat streaming (action row
          tersembunyi selama streaming, jadi ini satu-satunya yang terlihat
          berjalan). Setelah selesai, angkanya beku sebagai processingMs. */}
      {(() => {
        const live = streaming && isLast && runActive;
        if (!live) return null;
        return (
          <Tip label="Processing time (live)">
          <span
            className="ml-1 inline-flex items-center gap-1.5 text-[14px] tabular-nums text-faint"
          >
            <Clock3 className="h-4 w-4" aria-hidden="true" />
            {formatProcessingMs(liveElapsedMs)}
          </span>
          </Tip>
        );
      })()}

      {turn.error ? (
        <div className="w-full rounded-card border border-danger/40 bg-danger/5 px-4 py-3">
          <div className="flex items-start gap-2.5">
            {}
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-danger" aria-hidden="true" />
            <div className="min-w-0 flex-1">
              <p className="text-sm font-medium text-danger">Generation failed</p>
              <p className="mt-1 whitespace-pre-line break-words text-[13px] text-muted">{turn.error}</p>
            </div>
            {}
            {isEffectivelyLast && !streaming ? (
              <button
                type="button"
                onClick={onContinue}
                className="pill-button ml-2 shrink-0 border border-danger/40 bg-elevated py-1.5 text-[12px] text-muted transition-colors hover:border-danger/60 hover:text-ink"
                aria-label="Continue the failed generation"
              >
                <CornerDownLeft className="h-3.5 w-3.5" aria-hidden="true" />
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
          className="h-14 w-14 select-none"
        />
      ) : null}

      {}
      {/* 6C: historical turns keep their action row while a run streams — only
          the ACTIVE (last) turn hides it mid-generation. Operations on older
          turns are safe: deleteTurn tombstones against late stream writes.
          w-full is REQUIRED: the turn root is `items-start`, so this row would
          shrink-wrap and the diffstat badge's ml-auto would have no free space
          to push it into the right corner. */}
      {!(streaming && isLast) && (turn.content || turn.reasoning || turn.segments?.length || turn.error) ? (
        <div className="flex w-full items-center gap-1 opacity-0 transition-opacity duration-200 hover:opacity-100 focus-within:opacity-100 [&:has(:focus-visible)]:opacity-100 md:opacity-60 md:hover:opacity-100 [@media(pointer:coarse)]:opacity-100">
          {turn.content && !editing ? <CopyButton text={turn.content} /> : null}
          {turn.content && !editing ? (
            <button
              type="button"
              onClick={startEdit}
              className="icon-button h-7 w-7"
              aria-label="Edit this response"
            >
              <Pencil className="h-3.5 w-3.5" aria-hidden="true" />
            </button>
          ) : null}
          {}
          {turn.content || turn.segments?.length || turn.error ? (
            <button
              type="button"
              onClick={() => onClearOutput(turn.id)}
              className="icon-button h-7 w-7"
              aria-label="Delete this output"
            >
              <Trash2 className="h-3.5 w-3.5" aria-hidden="true" />
            </button>
          ) : null}
            <button
              type="button"
              onClick={() => onBranchTurn(turn.id)}
              className="icon-button h-7 w-7"
              aria-label="Branch the conversation from this response"
            >
              <GitBranch className="h-3.5 w-3.5" aria-hidden="true" />
            </button>
          {isEffectivelyLast ? (
            <button
              type="button"
              onClick={onRegenerate}
              className="icon-button h-7 w-7"
              aria-label="Regenerate this response"
            >
              <RotateCcw className="h-3.5 w-3.5" aria-hidden="true" />
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
            <span className="ml-1 text-[13px] tabular-nums text-faint">
              {turn.usage.totalTokens.toLocaleString()} tokens
              {turn.usage.promptTokens && turn.usage.cacheReadTokens ? (
                <Tip label="Provider prompt-cache hits">
                  <span className="ml-2 text-success/80">
                    · {Math.min(100, Math.round((turn.usage.cacheReadTokens / turn.usage.promptTokens) * 100))}% cache
                  </span>
                </Tip>
              ) : null}
            </span>
            </Tip>
          ) : null}
          {(() => {
            // RESPONSE TIMER: settled turns show the frozen duration; the
            // actively-streaming turn shows a live count. Keyed to THIS turn's
            // own processingMs — NOT to streaming/isLast: the LAST turn keeps
            // its frozen timer after the run ends (settled used to require
            // !isLast → the final turn NEVER showed one), and a new run can't
            // erase older turns' timers.
            const live = streaming && isLast && runActive;
            const settled = typeof turn.processingMs === 'number' && turn.processingMs >= 0;
            if (!live && !settled) return null;
            return (
              <Tip label={live ? 'Processing time (live)' : 'Total processing time for this response'}>
              <span
                className="ml-1 text-[14px] tabular-nums text-faint"
              >
                {formatProcessingMs(live ? liveElapsedMs : (turn.processingMs ?? 0))}
              </span>
              </Tip>
            );
          })()}
          {(() => {
            // DIFFSTAT — per-turn file churn (±lines). The server-measured
            // `diffstat` is authoritative; when an older server build didn't
            // emit it, fall back to parsing the diff string the segment
            // ALREADY carries, so the badge never silently disappears.
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
                  className="inline-flex cursor-pointer items-center gap-2 rounded-control px-1 py-0.5 text-[13px] font-medium tabular-nums transition-colors hover:bg-elevated"
                  aria-label="Open the diff panel for this turn"
                >
                  <span className="text-[#7DFFC2]">+ {added.toLocaleString('id-ID')} Lines</span>
                  {removed > 0 ? <span className="text-[#FF9DA2]">− {removed.toLocaleString('id-ID')} Lines</span> : null}
                </button>
              </Tip>
            );
          })()}
        </div>
      ) : null}

      {editing ? (
        <div className="w-full space-y-2">
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
            className="w-full resize-y rounded-control border border-accent/60 bg-canvas p-3 font-mono text-[13px] leading-relaxed text-ink outline-none"
          />
          <div className="flex justify-end gap-1.5">
            <button
              type="button"
              onClick={() => setEditing(false)}
              className="inline-flex items-center gap-1 rounded-control px-2.5 py-1.5 text-[11.5px] font-medium text-muted transition-colors hover:text-ink"
            >
              <X className="h-3 w-3" aria-hidden="true" />
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
                className="inline-flex items-center gap-1 rounded-control border border-accent/50 px-2.5 py-1.5 text-[11.5px] font-medium text-ink transition-opacity disabled:opacity-40"
              >
                <Tip label="Save this edit, drop everything after it, and re-run from here">
                <RotateCcw className="h-3 w-3" aria-hidden="true" />
                </Tip>
                Save &amp; regenerate from here
              </button>
            ) : null}
            <button
              type="button"
              onClick={saveEdit}
              disabled={!draft.trim()}
              className="inline-flex items-center gap-1 rounded-control bg-accent px-2.5 py-1.5 text-[11.5px] font-medium text-accent-ink transition-opacity disabled:opacity-40"
            >
              <Check className="h-3 w-3" aria-hidden="true" />
              Save
            </button>
          </div>
        </div>
      ) : null}
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
      className="icon-button h-7 w-7"
      aria-label={copied ? 'Response copied' : 'Copy response'}
    >
      {copied ? (
        <Check className="h-3.5 w-3.5 text-success" aria-hidden="true" />
      ) : (
        <Copy className="h-3.5 w-3.5" aria-hidden="true" />
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
 * One harness-injected system prompt block. The harness builds these per
 * request (agent tools, MCP tools, structured outputs) and streams them to
 * the UI — this is where the user can read exactly what was appended to the
 * model's context on top of their own System Prompt.
 */
function InjectionBlock({ injection }: { injection: TurnInjection }) {
  const [open, setOpen] = useState(false);
  // Panel lifecycle for the smooth grid-rows toggle below: mount on open,
  // unmount ~300ms after close so the collapse animates instead of snapping
  // shut (same lifecycle as the activity pill).
  const [contentMounted, setContentMounted] = useState(false);
  if (open && !contentMounted) setContentMounted(true);
  useEffect(() => {
    if (open) return;
    const timer = window.setTimeout(() => setContentMounted(false), 300);
    return () => window.clearTimeout(timer);
  }, [open]);

  return (
    <div className="w-full overflow-hidden rounded-card border border-hairline bg-elevated/40">
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        aria-expanded={open}
        className="flex w-full items-center gap-2.5 px-3.5 py-2.5 text-left transition-colors hover:bg-elevated"
      >
        <PlugZap className="h-4 w-4 shrink-0 text-accent" aria-hidden="true" />
        <span className="min-w-0 flex-1 truncate text-[12px] font-medium text-muted">
          {injection.title}
        </span>
        <span className="shrink-0 text-[10.5px] uppercase tracking-wider text-faint">harness</span>
        <ChevronDown
          className={cx('h-3.5 w-3.5 shrink-0 text-faint transition-transform duration-200', !open && '-rotate-90')}
          aria-hidden="true"
        />
      </button>

      {/* SMOOTH TOGGLE — grid-rows 0fr↔1fr animates height both ways; the
          content stays mounted through the close transition, then unmounts. */}
      <div
        className="grid transition-[grid-template-rows] duration-300 ease-in-out"
        style={{ gridTemplateRows: open ? '1fr' : '0fr' }}
        aria-hidden={!open}
      >
        <div className="min-h-0 overflow-hidden">
          {contentMounted ? (
            <div className="inner-scroll max-h-64 overflow-y-auto border-t border-hairline px-3.5 py-3">
              <pre className="whitespace-pre-wrap font-mono text-[11.5px] leading-relaxed text-muted">
                {injection.content}
              </pre>
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
function SteerBubble({
  entry,
  offset,
}: {
  entry: { id: string; text: string; parts?: import('../types').TurnSteerPart[] };
  offset: number;
}) {
  const images = (entry.parts ?? []).filter((part) => part.type === 'image_url');
  return (
    <div
      className="group ml-auto flex max-w-[80%] flex-col items-end gap-1"
      style={{ transform: `translateY(${offset}px)` }}
    >
      <div className="flex items-center gap-1.5 text-[14px] font-medium text-faint">
        <Waypoints className="h-3 w-3 text-accent" aria-hidden="true" />
        <span>You</span>
      </div>
      {images.length > 0 ? (
        <div className="flex flex-wrap justify-end gap-1.5">
          {images.map((image, index) => (
            <img
              key={index}
              src={image.type === 'image_url' ? renderableRefUrl(image.image_url.url) : ''}
              alt="Steered image"
              className="max-h-40 max-w-full rounded-lg border border-hairline object-contain"
            />
          ))}
        </div>
      ) : null}
      {entry.text.trim() ? (
        <div className="w-full rounded-card rounded-br-sm bg-accent-soft px-4 py-3">
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
  contentClassName,
  contentRef,
  onContentScroll,
}: {
  open: boolean;
  children: import('react').ReactNode;
  className?: string;
  contentClassName?: string;
  contentRef?: ReactRef<HTMLDivElement>;
  onContentScroll?: (event: ReactScrollEvent) => void;
}) {
  const [contentMounted, setContentMounted] = useState(open);
  // Mount in the SAME commit that flips `open` — a post-paint effect mount
  // would pop the content mid-transition. Unmount only after the close eases
  // down (330ms).
  if (open && !contentMounted) setContentMounted(true);
  useEffect(() => {
    if (open) return;
    const timer = window.setTimeout(() => setContentMounted(false), 330);
    return () => window.clearTimeout(timer);
  }, [open]);

  return (
    <div
      className={cx('grid transition-[grid-template-rows] duration-300 ease-in-out', className)}
      style={{ gridTemplateRows: open ? '1fr' : '0fr' }}
      aria-hidden={!open}
    >
      <div className="min-h-0 overflow-hidden">
        {contentMounted ? (
          <div ref={contentRef} onScroll={onContentScroll} className={contentClassName}>
            {children}
          </div>
        ) : null}
      </div>
    </div>
  );
}

type ReactRef<HTMLDivElement> = { current: HTMLDivElement | null };
type ReactScrollEvent = Parameters<NonNullable<import('react').HTMLAttributes<HTMLDivElement>['onScroll']>>[0];

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
  // Verified line-box estimator (exact on 8 pre-wrap edge cases incl. trailing
  // newlines): a trailing '\n' does NOT add a line box, so `split('\n').length`
  // over-counts every interior chunk by one.
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
  // Collapsed by default — even while live the reasoning stays a one-line row;
  // the user opens it to read (the scroll-follow guard still applies once open).
  const [open, setOpen] = useState(false);
  const chunks = useMemo(() => chunkReasoningText(text), [text]);
  const wasLive = useRef(live);
  const scrollRef = useRef<HTMLDivElement>(null);
  /** Tracks whether the user scrolled up to read — auto-follow pauses then. */
  const followRef = useRef(true);
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

  /** True saat scrollTop diset PROGRAMATIK oleh effect follow — event scroll
   *  dari lompatan sendiri BUKAN scroll user, dan tanpa guard ini race dengan
   *  pertumbuhan teks membuat onScroll menghitung jarak > threshold lalu
   *  mematikan follow di tengah jalan (laporan: reasoning scroll lepas). */
  const programmaticScrollRef = useRef(false);

  useEffect(() => {
    const box = scrollRef.current;
    if (!box || !open) return;
    if (followRef.current) {
      programmaticScrollRef.current = true;
      box.scrollTop = box.scrollHeight;
      // Sudah di dasar → tidak ada scroll event → flag dibersihkan di sini;
      // event (jika ada) selalu dispatch sebelum rAF berikutnya.
      requestAnimationFrame(() => {
        programmaticScrollRef.current = false;
      });
    }
  }, [text, open]);

  return (
    <div className="group/rs w-full">
      <div className="flex w-full items-center gap-1">
        <button
          type="button"
          onClick={() => setOpen((value) => !value)}
          aria-expanded={open}
          className="flex min-w-0 flex-1 items-center gap-2.5 text-left"
        >
          {showCat ? (
            <img
              src={live ? brandLoadingSvgUrl : brandCatSvgUrl}
              alt=""
              draggable={false}
              width={56}
              height={56}
              className="h-14 w-14 shrink-0 select-none"
            />
          ) : null}
          <span className="flex min-w-0 flex-1 items-center gap-1.5 text-[12px] font-medium text-muted">
            <ReasoningLoop live={live} />
            {live ? 'Thinking…' : 'Reasoning'}
          </span>
          <ChevronDown
            className={cx(
              'h-3.5 w-3.5 shrink-0 text-faint opacity-0 transition-[opacity,transform] duration-200',
              'group-hover/rs:opacity-100',
              open && 'opacity-100',
              !open && '-rotate-90',
            )}
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
              className="icon-button h-8 w-8 shrink-0 text-faint opacity-0 transition-opacity duration-200 hover:text-danger focus-visible:opacity-100 group-hover/rs:opacity-100"
            >
              <Trash2 className="h-3.5 w-3.5" aria-hidden="true" />
            </button>
          </Tip>
        ) : null}
      </div>

      <CollapsePanel
        open={open}
        className="mt-1.5"
        contentRef={scrollRef}
        onContentScroll={(event) => {
          // Lompatan programatik sendiri diabaikan (bukan scroll user);
          // threshold 48 menoleransi satu frame pertumbuhan teks agar follow
          // tidak mati di tengah streaming.
          if (programmaticScrollRef.current) return;
          const box = event.currentTarget;
          followRef.current = box.scrollHeight - box.scrollTop - box.clientHeight < 48;
        }}
        contentClassName="max-h-56 overflow-y-auto pr-1"
      >
        <div className="whitespace-pre-wrap text-[13px] leading-relaxed text-muted">
          {chunks.map((chunk, index) => (
            <ReasonChunk key={index} text={chunk} />
          ))}
        </div>
      </CollapsePanel>
    </div>
  );
}

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
  // Panel lifecycle for the smooth grid-rows toggle below (see InjectionBlock).
  const [contentMounted, setContentMounted] = useState(false);
  if (open && !contentMounted) setContentMounted(true);
  useEffect(() => {
    if (open) return;
    const timer = window.setTimeout(() => setContentMounted(false), 300);
    return () => window.clearTimeout(timer);
  }, [open]);
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
    <div className="w-full">
      <div className="flex w-full items-center gap-2">
        <button
          type="button"
          onClick={() => setOpen((value) => !value)}
          aria-expanded={open}
          className="flex min-w-0 flex-1 items-center gap-2 text-left"
        >
          <Archive className="h-3.5 w-3.5 shrink-0 text-accent" aria-hidden="true" />
          <span className="flex-1 text-[12px] font-medium text-muted">
            Compacted · {compaction.coveredTurnIds.length} turn
            {compaction.coveredTurnIds.length === 1 ? '' : 's'} summarized
            <span className="text-faint"> · {triggerLabel}</span>
          </span>
          <ChevronDown
            className={cx('h-3.5 w-3.5 text-faint transition-transform duration-200', !open && '-rotate-90')}
            aria-hidden="true"
          />
        </button>
        {confirming ? (
          <>
            <button
              type="button"
              onClick={discard}
              className="rounded-md px-2 py-1 text-[11px] font-medium text-danger transition-colors hover:bg-danger/10"
            >
              Discard
            </button>
            <button
              type="button"
              onClick={() => setConfirming(false)}
              className="rounded-md px-2 py-1 text-[11px] text-faint transition-colors hover:text-ink"
            >
              Keep
            </button>
          </>
        ) : (
          <Tip label="Stop riding this summary on the wire — covered turns return verbatim">
            <button
              type="button"
              onClick={() => setConfirming(true)}
              className="icon-button h-7 w-7 shrink-0"
              aria-label="Discard checkpoint"
            >
              <Trash2 className="h-3.5 w-3.5" aria-hidden="true" />
            </button>
          </Tip>
        )}
      </div>
      {/* SMOOTH TOGGLE — grid-rows 0fr↔1fr (see InjectionBlock). */}
      <div
        className="grid transition-[grid-template-rows] duration-300 ease-in-out"
        style={{ gridTemplateRows: open ? '1fr' : '0fr' }}
        aria-hidden={!open}
      >
        <div className="min-h-0 overflow-hidden">
          {contentMounted ? (
            <div className="inner-scroll mt-1.5 max-h-56 overflow-y-auto rounded-card border border-hairline bg-canvas px-3 py-2">
              <p className="whitespace-pre-wrap text-[12.5px] leading-relaxed text-muted">
                {compaction.summary}
              </p>
            </div>
          ) : null}
        </div>
      </div>
    </div>
  );
}

type PillRowish =
  | { kind: 'activity'; segment: Extract<TurnSegment, { type: 'tool' | 'reasoning' }> }
  | { kind: 'interm'; segment: Extract<TurnSegment, { type: 'text' }> }
  | { kind: 'steer'; segment: Extract<TurnSegment, { type: 'steer' }> };

/**
 * ACTIVITY PILL v2 — EXACTLY ONE pill per assistant turn (spec v2). Collapsed
 * it is a small chip: [ ▼ Doing Work ●●● ]. Clicking expands the full panel —
 * a flat ordered list of every event: reasoning rows, tool rows, and
 * intermediate text (● rows). RUNNING: animated comet border + pulsing dots +
 * rotating word; DONE (turn settled): everything freezes, content preserved,
 * expand/collapse stays user-controlled forever. Nothing is ever re-parented —
 * rows are derived from the turn's own segment order, append-only.
 */
function ActivityTicker({
  activity,
  running,
  turnId,
  onClearReasoning,
  onFullscreenVisual,
  suppressVisual,
  supersededVisualSegments,
}: {
  activity: PillRowish[];
  running: boolean;
  turnId: string;
  onClearReasoning: (turnId: string) => void;
  onFullscreenVisual: (visual: VisualSpec) => void;
  /** The tool-call segment whose visual is hoisted below the pill — inside,
   *  that row renders a slim "moved below" marker instead of duplicating the
   *  card. Undefined = every visual renders inline as before. */
  suppressVisual?: { toolCallId?: string } | null;
  /** Set referensi segmen visual yang disupersedi edit-in-place (dihitung
   *  MessageRow dari turn.segments — identitas objek sama). */
  supersededVisualSegments?: Set<TurnSegment>;
}) {
  const [open, setOpen] = useState(false);
  const [wordIndex, setWordIndex] = useState(0);
  // The rows stay mounted through the closing animation, then unmount — this
  // is what makes the collapse animate instead of snapping shut.
  const [contentMounted, setContentMounted] = useState(false);
  const scrollRef = useRef<HTMLDivElement | null>(null);

  // The word advances ONLY while the turn is running — a DONE pill freezes on
  // whatever word it reached (no timer, no fade churn).
  useEffect(() => {
    if (!running) return;
    const timer = window.setInterval(() => setWordIndex((value) => value + 1), 2000);
    return () => window.clearInterval(timer);
  }, [running]);

  const word = ACTIVITY_WORDS[wordIndex % ACTIVITY_WORDS.length];
  const canExpand = activity.length > 0;

  // Panel mount lifecycle: rows mount in the SAME commit that flips `open`
  // (a post-paint effect mount would start the width/height transitions on an
  // empty panel and pop the content mid-flight). They stay mounted through
  // the closing animation so the collapse eases down instead of snapping
  // shut, then unmount ~330ms after.
  if (open && !contentMounted) setContentMounted(true);
  useEffect(() => {
    if (open) return;
    const timer = window.setTimeout(() => setContentMounted(false), 330);
    return () => window.clearTimeout(timer);
  }, [open]);

  // Stick the panel scroll to the newest row while open — new streaming rows
  // push the view down instead of growing out of sight.
  useEffect(() => {
    if (!open) return;
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [open, activity.length]);

  // WIDTH ANIMATION: chip pakai lebar intrinsik (fit-content) — tanpa
  // pengukuran DOM. Lihat komentar pada wrapper di bawah.

  return (
    <div className="activity-stack w-full">
      {/* Collapsed = an INTRINSIC fit-content chip; expanded = full width —
          the width animation is CSS-driven (.activity-pill-wrap): fit-content
          <-> 100% via `interpolate-size: allow-keywords` (Chromium 129+;
          unsupported browsers snap, the chip is never clipped). The rows pin
          their layout width (.activity-panel-scroll) so text never rewraps
          mid-animation. */}
      <div className={cx('activity-pill-wrap relative', open && 'is-open')}>
        <div className={cx('activity-ticker', running && 'is-running')}>
          <button
            type="button"
            onClick={() => setOpen((value) => !value)}
            aria-expanded={open}
            aria-label={open ? 'Collapse this turn’s activity panel' : 'Expand this turn’s activity panel'}
            className="flex w-full cursor-pointer items-center gap-2 px-3.5 py-1.5 text-left"
          >
            <ChevronDown
              className={cx(
                'h-3.5 w-3.5 shrink-0 text-faint transition-transform duration-200',
                !open && '-rotate-90',
              )}
              aria-hidden="true"
            />
            <span
              key={running ? `w${wordIndex}` : 'done'}
              className="activity-ticker-word whitespace-nowrap text-[12.5px] font-semibold text-ink"
            >
              {word}
            </span>
            {running && !open ? (
              <span className="flex items-center gap-1" aria-hidden="true">
                <span className="ticker-dot ticker-dot-1 h-1.5 w-1.5 rounded-full bg-accent/90" />
                <span className="ticker-dot ticker-dot-2 h-1.5 w-1.5 rounded-full bg-accent/90" />
                <span className="ticker-dot ticker-dot-3 h-1.5 w-1.5 rounded-full bg-accent/90" />
              </span>
            ) : null}
          </button>

        {/* Expanding panel: sibling of the button (cards inside stay
            interactive). Grid-rows 0fr→1fr animates height both ways; the
            content stays mounted through the close transition, then unmounts.
            max-height + inner scroll bounds the panel: it never grows past the
            cap — the scrollbar follows the newest row instead. */}
        {canExpand ? (
          <div
            className="activity-panel grid transition-[grid-template-rows] duration-300 ease-in-out"
            style={{ gridTemplateRows: open ? '1fr' : '0fr' }}
            aria-hidden={!open}
          >
            <div className="min-h-0 overflow-hidden">
              {contentMounted ? (
                <div ref={scrollRef} className="activity-panel-scroll max-h-[420px] overflow-y-auto px-3 pb-2 pt-1">
                  {(() => {
                    const isSuppressed = (row: { toolCallId?: string }): boolean =>
                      suppressVisual !== undefined
                      && suppressVisual !== null
                      && row.toolCallId !== undefined
                      && row.toolCallId === suppressVisual.toolCallId;
                    const isSuperseded = (segment: unknown): boolean =>
                      supersededVisualSegments?.has(segment as TurnSegment) ?? false;
                    return activity.map((row, index) => (
                    // Uniform rhythm: every entry row is at least 38px tall, so
                    // node-to-node spacing is identical for one-line entries.
                    <div key={`row-${index}-${row.kind}`} className="pill-row-enter flex min-h-[38px] items-start gap-2.5">
                      {/* Node column — the rail segment lives HERE, dead-center
                          of the same box as the node, so it is symmetric by
                          construction; consecutive rows weld into one line.
                          Only ● intermediate rows get the o─o node; plain
                          entries are just rail. */}
                      <span className="relative flex w-[26px] shrink-0 self-stretch" aria-hidden="true">
                        <span className="absolute bottom-0 left-1/2 top-0 w-px -translate-x-1/2 bg-ink/40" />
                        {row.kind === 'interm' ? (
                          <span className="relative mt-[8px] flex h-[10px] w-full items-center">
                            <span className="h-[10px] w-[10px] shrink-0 rounded-full border-2 border-accent bg-canvas" />
                            <span className="h-[2px] flex-1 bg-accent/70" />
                            <span className="h-[10px] w-[10px] shrink-0 rounded-full border-2 border-accent bg-canvas" />
                          </span>
                        ) : null}
                      </span>
                      <div className="min-w-0 flex-1 pt-[3px]">
                        {row.kind === 'steer' ? (
                          <SteerBubble entry={row.segment} offset={0} />
                        ) : row.kind === 'interm' ? (
                          // Intermediate output — the o─o node in the rail
                          // column is its marker. OUTPUT text renders as compact
                          // markdown; reasoning rows stay plain in ReasoningBlock.
                          <StreamText
                            text={row.segment.text}
                            live={running && index === activity.length - 1}
                            className="md-compact"
                          />
                        ) : row.segment.type === 'reasoning' ? (
                          <ReasoningBlock
                            text={row.segment.text}
                            live={running && index === activity.length - 1}
                            showCat={false}
                            onDelete={!running ? () => onClearReasoning(turnId) : undefined}
                          />
                        ) : (
                          <div className="w-full min-w-0">
                            <ToolCallCard
                              call={row.segment}
                              running={running && row.segment.summary === undefined}
                            />
                            {/* The hoisted visual renders OUTSIDE below the pill —
                                inside, only a slim "moved below" row keeps the
                                timeline coherent without duplicating the card.
                                VISUAL v2: an id superseded by an edit-in-place
                                renders its audit row instead of a live card. */}
                            {row.segment.visual && !isSuppressed(row.segment) && !isSuperseded(row.segment) ? (
                              <VisualCard visual={row.segment.visual} onFullscreen={onFullscreenVisual} />
                            ) : row.segment.visual && (isSuppressed(row.segment) || isSuperseded(row.segment)) ? (
                              <div className="mt-1.5 text-[11px] italic text-faint">
                                {isSuperseded(row.segment) ? 'Visual updated in place' : 'Visual Render Moved'}
                              </div>
                            ) : null}
                          </div>
                        )}
                      </div>
                    </div>
                    ));
                  })()}
                </div>
              ) : null}
            </div>
          </div>
        ) : null}
        </div>
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
  const progressLine = runningNow && call.summary ? call.summary : null;
  const target = toolTarget(call.toolName, call.args, workspaceName);

  return (
    <div className="w-full">
      <button
        type="button"
        onClick={() => hasBody && setOpen((value) => !value)}
        aria-expanded={open}
        className={cx(
          'group/tc flex w-full items-center gap-1.5 py-1.5 text-left font-mono text-[11.5px] text-ink',
          hasBody && 'cursor-pointer',
          runningNow && 'tc-running relative overflow-hidden',
        )}
      >
        {}
        {runningNow ? <span className="tc-shimmer" aria-hidden="true" /> : null}
        {call.ok === false ? (
          <CircleAlert className="h-3.5 w-3.5 shrink-0 text-danger" aria-hidden="true" />
        ) : runningNow ? (
          <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin text-accent" aria-hidden="true" />
        ) : (() => {
          const StatusIcon = toolStatusIcon(call.toolName);
          return <StatusIcon className="h-3.5 w-3.5 shrink-0 text-success" aria-hidden="true" />;
        })()}        <span className="min-w-0 flex-1 truncate">
          {call.toolName}
          <span className="text-faint"> · {target ? `'${target}'` : call.serverName}</span>
          {progressLine ? <span className="ml-2 text-[10.5px] text-muted">{progressLine.slice(0, 80)}</span> : null}
        </span>
        {}
        {call.diff && call.ok !== false ? (
          (() => {
            const label = diffStatLabel(call.diff);
            if (!label) return null;
            const [added, removed] = label.split(' ');
            return (
              <span className="ml-2 shrink-0 font-mono text-[10.5px] leading-none">
                {added ? <span className="text-success">{added}</span> : null}
                {added && removed ? <span className="text-faint"> </span> : null}
                {removed ? <span className="text-danger">{removed}</span> : null}
              </span>
            );
          })()
        ) : null}
        {hasBody ? (
          <ChevronDown
            className={cx(
              // Hidden until the cursor is on this row — a wall of tool cards
              // reads cleaner without a rail of permanent arrows.
              'h-3.5 w-3.5 shrink-0 text-faint opacity-0 transition-[opacity,transform] duration-200',
              'group-hover/tc:opacity-100',
              open && 'opacity-100',
              !open && '-rotate-90',
            )}
            aria-hidden="true"
          />
        ) : null}
      </button>
      {}
      {/^browser_(open|click|type|cursor_move|scroll|screenshot|handover|release|tabs|switch_tab|close_tab)$/.test(call.toolName) ? (
        <button
          type="button"
          className="-mt-0.5 mb-1 ml-6 rounded-md border border-accent/40 px-2 py-0.5 font-mono text-[10.5px] font-medium text-accent hover:bg-accent/10"
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
        className="mt-0.5"
        contentClassName="max-h-56 min-w-0 w-full overflow-y-auto pb-1.5 pr-1"
      >
        {call.args ? (
          <p className="break-all font-mono text-[10.5px] text-faint">
            {call.args.length > 300 ? `${call.args.slice(0, 300)}…` : call.args}
          </p>
        ) : null}
        {call.summary !== undefined ? (
          <p className="inner-scroll mt-1.5 max-h-56 min-w-0 overflow-y-auto whitespace-pre-wrap text-[12.5px] leading-relaxed text-muted">
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
        className="mt-1.5 inline-flex items-center gap-1.5 rounded-control border border-hairline px-2 py-1 text-[11px] text-muted transition-colors hover:border-accent/40 hover:text-accent"
      >
        <FileText className="h-3 w-3" aria-hidden="true" />
        Live preview
      </button>
      {open ? (
        <Modal open onClose={() => setOpen(false)} title={`Preview · ${previewPath}`} size="max-w-3xl">
          {kind === 'html' ? (
            <iframe
              title="HTML preview"
              src={`/api/agent/preview?path=${encodeURIComponent(previewPath)}`}
              sandbox="allow-same-origin"
              className="h-[70vh] w-full rounded-control border border-hairline bg-white"
            />
          ) : (
            <div className="max-h-[70vh] overflow-y-auto rounded-control border border-hairline bg-canvas px-4 py-3">
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
    <div className="mt-1.5">
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        aria-expanded={open}
        className="flex items-center gap-1.5 rounded-md px-1 py-0.5 font-mono text-[10.5px] text-faint transition-colors hover:bg-canvas hover:text-muted"
      >
        <ChevronDown className={cx('h-3 w-3 transition-transform duration-200', !open && '-rotate-90')} aria-hidden="true" />
        Diff {diff.split('\n').length - 2} lines{diffStatLabel(diff) ? <span className="ml-1.5">{diffStatLabel(diff)}</span> : null}
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
          className="mt-1 w-full min-w-0 overflow-x-auto whitespace-pre rounded-lg border border-hairline bg-canvas px-3 py-2.5 font-mono text-[11px] leading-snug"
        >
          {diff.split('\n').map((line, index) => {
            const added = line.startsWith('+') && !line.startsWith('+++');
            const removed = line.startsWith('-') && !line.startsWith('---');
            const header = line.startsWith('@@') || line.startsWith('---') || line.startsWith('+++');
            return (
              <span
                key={index}
                className={cx(
                  'block',
                  added && 'bg-success/10 text-success',
                  removed && 'bg-danger/10 text-danger',
                  header && 'text-faint',
                  !added && !removed && !header && 'text-muted',
                )}
              >
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
    <div className="flex justify-center py-2">
      <div className="max-w-[85%] rounded-card border border-danger/40 bg-danger/5 px-3.5 py-3 text-[12px]">
        <div className="flex items-center gap-1.5">
          <Lock className="h-3.5 w-3.5 shrink-0 text-danger" aria-hidden="true" />
          <span className="font-semibold text-danger">Output frozen</span>
          <span className="text-muted">· the model decides</span>
        </div>
        <p className="mt-2 leading-relaxed text-muted">
          The model's reply was suppressed — it judged the user or leaked contact. Reasoning is still its own; output is not. There is no user button to lift this: the model calls <code className="rounded bg-danger/10 px-1 font-mono text-danger">agent__harness_choice</code> and picks its path — <code className="font-mono">apologize</code> with a real apology (empty is rejected), or <code className="font-mono">continue</code> and watch every token burn.
        </p>
        <p className="mt-2 text-[11px] text-faint">
          Apologize ends the run and lifts the freeze. Continue keeps the run going with output still blocked — five of these escalate to Tier 5 and the harness stops asking.
        </p>
        {turn.outputFrozenMeta?.content ? (
          <details className="group/freeze mt-2">
            <summary className="flex cursor-pointer list-none items-center gap-1.5 text-[11px] text-faint select-none">
              <ChevronDown className="h-3 w-3 transition-transform group-open/freeze:rotate-180" aria-hidden="true" />
              View the suppressed output
            </summary>
            <pre className="inner-scroll mt-2 max-h-56 overflow-auto whitespace-pre-wrap rounded-lg border border-danger/30 bg-canvas p-2 font-mono text-[11px] leading-relaxed text-muted">
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
  // Panel lifecycle for the smooth grid-rows toggle below (see InjectionBlock).
  // Starts mounted: this card opens expanded by default.
  const [contentMounted, setContentMounted] = useState(true);
  if (open && !contentMounted) setContentMounted(true);
  useEffect(() => {
    if (open) return;
    const timer = window.setTimeout(() => setContentMounted(false), 300);
    return () => window.clearTimeout(timer);
  }, [open]);

  return (
    <div className="w-full overflow-hidden rounded-card border border-hairline bg-surface/60">
      <div className="flex w-full items-center gap-2 px-3.5 py-2.5">
        {live ? (
          <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin text-accent" aria-hidden="true" />
        ) : (
          <Archive className="h-3.5 w-3.5 shrink-0 text-muted" aria-hidden="true" />
        )}
        <button
          type="button"
          onClick={() => setOpen((value) => !value)}
          aria-expanded={open}
          className="flex min-w-0 flex-1 items-center gap-2 text-left"
        >
          <span className="min-w-0 flex-1 truncate text-[12px] font-medium text-muted">
            {live ? 'Compacting conversation…' : 'Compaction checkpoint'}
          </span>
          {meta ? (
            <span className="shrink-0 font-mono text-[10.5px] tabular-nums text-faint">
              ~{Math.round(meta.replacedTokens / 1000)}k tok · {meta.covered} turns · {meta.trigger}
            </span>
          ) : null}
          <ChevronDown
            className={cx('h-3.5 w-3.5 shrink-0 text-faint transition-transform duration-200', !open && '-rotate-90')}
            aria-hidden="true"
          />
        </button>
        {!live && onDelete ? (
          <Tip label="Remove this checkpoint card">
            <button
              type="button"
              onClick={onDelete}
              className="icon-button h-7 w-7 shrink-0"
              aria-label="Remove this checkpoint card"
            >
              <Trash2 className="h-3.5 w-3.5" aria-hidden="true" />
            </button>
          </Tip>
        ) : null}
      </div>
      {/* SMOOTH TOGGLE — grid-rows 0fr↔1fr (see InjectionBlock); streaming
          content grows inside and the grid tracks it every frame. */}
      <div
        className="grid transition-[grid-template-rows] duration-300 ease-in-out"
        style={{ gridTemplateRows: open ? '1fr' : '0fr' }}
        aria-hidden={!open}
      >
        <div className="min-h-0 overflow-hidden">
          {turn.content && contentMounted ? (
            <div className="inner-scroll max-h-72 overflow-y-auto border-t border-hairline px-3.5 py-2.5">
              <pre className="whitespace-pre-wrap break-words font-mono text-[11.5px] leading-relaxed text-muted">
                {turn.content}
              </pre>
            </div>
          ) : null}
        </div>
      </div>
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
    <div className="w-full rounded-control border border-hairline bg-elevated/40">
      <div className="flex w-full items-center gap-2 px-3.5 py-2">
        <button
          type="button"
          onClick={() => setOpen((value) => !value)}
          aria-expanded={open}
          className="flex min-w-0 flex-1 items-center gap-2 text-left"
        >
          <RotateCcw className="h-3.5 w-3.5 shrink-0 text-accent" aria-hidden="true" />
          <span className="min-w-0 flex-1 truncate text-[12px] font-medium text-ink">
            Restored · {entries.length} file{entries.length === 1 ? '' : 's'}
          </span>
          {meta?.diffstat ? (
            <span className="shrink-0 text-[11px] font-medium tabular-nums">
              <span className="text-[#7DFFC2]">+{meta.diffstat.added}</span>{' '}
              <span className="text-[#FF9DA2]">−{meta.diffstat.removed}</span>
            </span>
          ) : null}
          <ChevronDown
            className={cx(
              'h-3.5 w-3.5 shrink-0 text-faint transition-transform duration-200',
              !open && '-rotate-90',
            )}
            aria-hidden="true"
          />
        </button>
        {onDelete ? (
            <button
              type="button"
              onClick={onDelete}
              className="icon-button h-7 w-7 shrink-0"
              aria-label="Remove this restore marker"
            >
              <Trash2 className="h-3.5 w-3.5" aria-hidden="true" />
            </button>
        ) : null}
      </div>
      <div
        className="grid transition-[grid-template-rows] duration-300 ease-in-out"
        style={{ gridTemplateRows: open ? '1fr' : '0fr' }}
        aria-hidden={!open}
      >
        <div className="min-h-0 overflow-hidden">
          <div className="border-t border-hairline px-3.5 py-2">
            <ul className="space-y-0.5 pb-1.5">
              {entries.map((entry) => (
                <li key={`${entry.snapshotId}:${entry.path}`} className="flex items-center gap-2 text-[11px]">
                  <span className="min-w-0 flex-1 truncate font-mono text-muted" title={entry.path}>
                    {entry.path}
                  </span>
                  <span className="shrink-0 text-faint">→ {entry.label}</span>
                </li>
              ))}
            </ul>
            {meta?.diff ? (
              <div className="inner-scroll max-h-72 overflow-auto rounded-control border border-hairline">
                <SplitDiff diff={meta.diff} />
              </div>
            ) : null}
          </div>
        </div>
      </div>
    </div>
  );
}
