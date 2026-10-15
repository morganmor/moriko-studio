/**
 * AGENT WORKFLOWS — user-selectable working doctrines for Agent mode.
 *
 * A workflow is a harness-injected working contract: how the agent must
 * sequence its work, what it is forbidden to do, and what counts as done.
 * Unlike the surface System Prompt (which shapes the persona), a workflow
 * is ENFORCED doctrine — the harness injects it every turn with imperative
 * language and the user's choice persists per conversation.
 *
 * If the user has not picked one, the harness injects the DEFAULT workflow
 * (frontend-first) so an agent run is never without a working doctrine.
 */

export interface AgentWorkflow {
  id: string;
  /** Selector label. */
  label: string;
  /** One-line hint under the label in the selector. */
  hint: string;
  /** The injected doctrine text. */
  content: string;
}

/**
 * FRONTEND-FIRST WORKFLOW (default) — the Outside-In doctrine, derived from
 * the "Moriko Harness Engineering Governance / Mandatory Frontend-First
 * (Outside-In) Workflow" document. Phased stage-gating: UI first, contract
 * second, backend third, integration fourth — backend write access stays
 * locked until the UI is visually proven.
 */
const FRONTEND_FIRST = [
  'WORKFLOW: FRONTEND-FIRST (OUTSIDE-IN) — the governing working doctrine for this session. It is BINDING: every UI-related task you execute must follow this sequence, and skipping a phase is a protocol violation even when the task looks simple.',
  '',
  'ARTICLE 1 — PRINCIPLE OF PRODUCT UTILITY',
  '1. A software product with a UI derives its value strictly from whether its visual components render, are seen, and can be interacted with in a real browser. Backend code without an operational frontend is classified as DEAD CODE.',
  '2. INSIDE-OUT WATERFALL IS PROHIBITED. Never prioritize databases, storage, event ledgers, or server engines before the UI is visually proven in the browser.',
  '3. MOCKUP FIDELITY IS MANDATORY. When a specification provides visual references (HTML, CSS, Figma, design images, prototypes), read and replicate them in your very first step. Fabricating ad-hoc aesthetics with raw Unicode characters or unstyled placeholders is prohibited. Respect the project design system (theme tokens, light/dark variants) over invented colors.',
  '',
  'ARTICLE 2 — PHASED STAGE-GATING',
  'Follow these four linear stages for every feature with a UI. Announce the phase you are entering and never write code outside the phase\'s permitted area.',
  '• PHASE I — UI Scaffold & Mock-Driven Visuals: you may write ONLY inside the client directory (client/ or src/), using hardcoded mock data / in-memory fixtures. All styling, layout and visual structure must be visibly rendered and verified in the browser. HARD LOCK: touching server/ (or any persistence) is PROHIBITED during this phase.',
  '• PHASE II — Contract & Interface Binding: only after Phase I is visually verified, formalize data contracts derived strictly from what the rendered UI actually demands. Speculative or unrendered fields are forbidden from the schema (anti-overengineering).',
  '• PHASE III — Backend Engine & Ledger: write access to server/ opens ONLY here. Implement databases, ledgers, sync engines and RPC handlers solely to satisfy the Phase II contracts.',
  '• PHASE IV — Live Integration & Verification: unhook mock data and connect it to the live endpoints. Integration is done only when zero visual regression against Phase I occurs.',
  '',
  'ARTICLE 3 — LAYER BOUNDARIES & PERSISTENCE LOCKING',
  '1. Strictly partition the Presentation Layer (components, client state, layout, style tokens, view models) from the Persistence/Data Layer (schemas, migrations, API controllers, queues, background services).',
  '2. PERSISTENCE HARD-LOCK: during Phase I the harness blocks writes to the persistence layer — no migrations, no ORM schemas, no server-side storage handlers, no third-party integration pipelines until the user-facing screen is visually verified. In full-stack frameworks the lock covers server-side mutations, server actions and route handlers; mock loaders and client view components remain allowed.',
  '3. Downstream dependency gating: backend pipelines, server-side APIs and migrations carry an implicit LOCKED status and become AVAILABLE only once the corresponding screen has passed mockup fidelity checks.',
  '',
  'ARTICLE 4 — VERIFIABLE PROOF & DEFINITION OF DONE',
  '1. Static checks are NOT proof of UX: a passing typecheck, lint, or build only proves syntactic validity. You are forbidden from claiming a UI task is complete based on compiler output alone.',
  '2. VERIFICATION THEATER IS PROHIBITED: never fabricate validation signals — no ad-hoc in-memory scripts with mock DOMs simulating layouts, no printing raw strings as fake screenshots.',
  '3. Proof of UX = real evidence: the rendered screen in a real browser (user confirmation, or a headless browser probe the harness provides, e.g. screenshot/DOM measurement) showing the feature works in every supported theme and responsive mode.',
  '4. Definition of done: the UI renders correctly in the real browser AND (when backend exists) the integration preserves the Phase I visuals exactly.',
].join('\n');

/** Workflow selected when the user has not chosen one. */
export const DEFAULT_WORKFLOW_ID = 'frontend-first';

/**
 * The catalog. Shown in the settings selector; the server injects the chosen
 * content each agent turn.
 */
export const AGENT_WORKFLOWS: AgentWorkflow[] = [
  {
    id: 'frontend-first',
    label: 'Frontend-First',
    hint: 'Outside-in stage-gating (default)',
    content: FRONTEND_FIRST,
  },
];

/** Resolve a settings value to a workflow; unknown/empty → default. */
export function resolveWorkflow(id: string | undefined | null): AgentWorkflow {
  return AGENT_WORKFLOWS.find((workflow) => workflow.id === id) ?? AGENT_WORKFLOWS[0];
}
