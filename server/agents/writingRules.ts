/**
 * MID-TURN WRITING-RULES REMINDER (keluhan #3).
 *
 * Classifier that watches a run's outgoing text/reasoning for the pattern the
 * Working Style forbids: the model starting to write its own E2E / manual
 * test code without the user's explicit request. When it fires, the harness
 * STEERS a system reminder into the model's context at the next round
 * boundary (the same mechanism as a user steer — mid-token injection is
 * impossible, SSE is one-way).
 *
 * One reminder per run per category; detection is cheap (word-boundary regex
 * over a bounded rolling buffer) so it can ride every text/reasoning event.
 */

/** Matches "e2e", "end-to-end", "end to end" near test-writing intent. */
const E2E_PATTERNS: RegExp[] = [
  /\be2e\b[^.]{0,80}\b(write|creat|generat|implement|build|scaffold|spin up)\b/i,
  /\b(write|creat|generat|implement|build|scaffold)\b[^.]{0,80}\be2e\b/i,
  /\bend[- ]to[- ]end\b[^.]{0,80}\b(test|spec)\b[^.]{0,80}\b(write|creat|generat|implement|build)\b/i,
  /\b(write|creat|generat|implement|build)\b[^.]{0,80}\bend[- ]to[- ]end\b[^.]{0,40}\b(test|spec)\b/i,
  /\btest\.create|node:test|describe\(|it\(.*expect\(/i,
];

const REMINDER_BODY = [
  'SYSTEM REMINDER — Writing Rules.',
  '',
  'You were about to write your own E2E / manual test code. That is forbidden:',
  'Proper End-to-End (E2E) testing is done by using DEDICATED TOOLS, never by',
  'writing manual testing code based on your own implementation. Also: only',
  'perform verifications and additional testing if the user EXPLICITLY asked.',
  '',
  'Stop the test-writing path now. Continue the actual task instead; if the',
  'user truly wants E2E verification, ask them to confirm first.',
].join('\n');

/**
 * Single source of truth for preset reminder texts — shared by the automatic
 * classifier watch AND the manual "Send Reminder" button (the steer endpoint
 * accepts `preset: "writingRules"` and injects this verbatim, so the client
 * never duplicates the copy).
 */
export const SYSTEM_RULES_PRESETS: Record<string, string> = {
  writingRules: `SYSTEM REMINDER — Writing Rules (sent by the user).

The user is reminding you of the rules you must follow while working in this
workspace:

- Proper End-to-End (E2E) testing is done by using DEDICATED TOOLS, never by
  writing manual testing code based on your own implementation.
- Only perform verifications and additional testing if the user explicitly
  asked for them.
- Report all errors honestly and in a structured manner — never make excuses
  to avoid or run away from the problem.
- Do not ignore or underestimate warnings that appear in the runtime,
  terminal, or devtools.

Acknowledge briefly and adjust your current work accordingly.`,
};

export interface WritingRulesWatch {
  /** Feed every outgoing text/reasoning delta here. */
  observe: (delta: string) => void;
  /** True once the reminder for this run has been produced. */
  consumed: boolean;
}

/** Rolling window cap — the classifier only needs recent intent. */
const BUFFER_CAP = 4000;

/**
 * Starts a watch for one run. `onTriggered` receives the reminder text exactly
 * once; the caller pushes it through the steer channel.
 */
export function watchWritingRules(onTriggered: (reminder: string) => void): WritingRulesWatch {
  let buffer = '';
  let fired = false;
  return {
    get consumed() {
      return fired;
    },
    observe(delta: string) {
      if (fired || !delta) return;
      buffer = (buffer + delta).slice(-BUFFER_CAP);
      for (const pattern of E2E_PATTERNS) {
        if (pattern.test(buffer)) {
          fired = true;
          onTriggered(REMINDER_BODY);
          return;
        }
      }
    },
  };
}
