# Moriko Studio — Architecture

Moriko Studio is a **local-first AI chat workspace**: a React SPA talking to a
small Express proxy that owns every secret. The browser never holds provider
API keys for server-side providers, and conversations live on the machine —
there is no backend service beyond the local proxy.

```
┌─────────────────────────────┐        ┌──────────────────────────────────┐
│  Browser SPA (Vite :5178)   │  /api  │  Express proxy (:8791)           │
│  React 18 + zustand         │──────▶ │  · /api/chat  (SSE stream)       │
│  src/                       │ proxy  │  · /api/providers…               │
│  components / hooks / lib   │        │  · /api/mcp…  · image endpoints  │
│  store (localStorage)       │        │  server/                         │
└─────────────────────────────┘        │  adapters → OpenAI-compatible /  │
                                       │  Anthropic / Gemini              │
                                       │  MCP manager → stdio / HTTP      │
                                       │  ~/.moriko/ (keys, providers)    │
                                       │  .data/    (chats, images)       │
                                       └──────────────────────────────────┘
```

The Vite dev server proxies `/api/*` to the proxy (`vite.config.ts`), so the
SPA only ever speaks same-origin HTTP. In production (`pnpm build && pnpm
start`) the proxy serves the built SPA itself.

## Top-level layout

| Path            | Purpose |
| --------------- | ------- |
| `src/`          | Browser application (React SPA). |
| `server/`       | Express proxy, provider adapters, MCP subsystem, server-side store. |
| `scripts/`      | Metadata sync jobs, mock providers, end-to-end smoke tests. |
| `tests/`        | Unit tests (e.g. image adapters). |
| `docs/`         | Design plans and post-implementation reports. |
| `public/`, `svg/` | Static assets and brand SVG sources. |
| `.data/`        | *Legacy only* — the old store location the boot migration reads from. Gitignored; empty after migration. |
| `~/.moriko-studio/` | **All app data** — providers, key vault, chats, images, gallery, agent state. Outside the repo; survives a fresh checkout. |

## On-disk data layout

Every persisted path is owned by `server/paths.ts` — ONE root, `~/.moriko-studio`
(`MORIKO_HOME`, also settable from Settings → Data; the pick is written to `.env`
and takes effect on the next harness reload). A boot-time migration
(`migrateLegacyLayout`) moves the pre-restructure stores (from the repo's legacy
`.data/`, named by `DATA_DIR`) into this layout (originals renamed to
`*.migrated`, never deleted). There is deliberately NO cross-home migration at
boot: the folder rename never touches data outside the chosen home.

```
~/.moriko-studio/                 everything the app persists
├── providers.json                provider DEFINITIONS (no secrets)
├── api-keys.json                 key vault: { apiKey, baseUrl } per provider
├── vision.json                   agent__vision provider/model
├── mcp.json                      registered MCP servers
├── agents.json                   agent workspace registry + settings
├── settings.json                 server settings (image retention, …)
├── reminders.json                scheduled reminders
├── audit/  jobs/  read-state/  vault/     agent harness state
├── runs/                          per-run SSE frame journals (see below)
├── conversation/
│   ├── index.json     chat summaries (list view)
│   ├── manifest.json  { nextSeq, order, folders: { id → dir } }
│   ├── chat-001-20260919/
│   │   ├── chat-data.json   full conversation record
│   │   └── goals-plan.json  this session's agent goals
│   └── detached/<session>.json   goals of chats with no folder
├── image-session/
│   ├── data.json      Image Studio sessions
│   ├── images/        generated files (+ sidecar meta JSON)
│   ├── task-state.json  in-flight provider tasks (restart-safe)
│   └── tasks.jsonl    append-only task lifecycle journal
└── gallery/data.json  user-curated permanent gallery
```

Syncing writes ONLY the chats a batch touched (plus manifest + index) —
no more rewriting one multi-megabyte `conversations.json` per sync.
API keys (custom AND built-in) never ride `providers.json` — they live in
the `api-keys.json` vault, each entry beside the endpoint it authenticates.

**In-flight turns sync incrementally.** A chat this tab is generating into
never re-uploads its whole record on the 1.5 s sync debounce — the trailing
turn (and any turns appended since the last full sync) ride the wire as
`turnPatches`, and the store replaces/inserts each by `turnId` inside the
record it already holds. The server's copy therefore stays *current* while a
run streams, so a reload in a browser whose localStorage predates the run —
or a second browser that never saw the stream — reads the live partial
straight from the store instead of the pre-run thread. A patch carries no
conversation-level `rev`: `deleteTurn` bumps rev without `updatedAt`, so
adopting the patch rev would tie the run-end full upsert and the turn-count
tiebreak would resurrect a mid-run deletion.

**The server also writes the run's own turn.** The patch channel above is fed
by the STREAMING TAB; if that tab freezes, closes, or exhausts its re-attach
budget, nobody pushed the run's output anywhere durable — the proxy finished
the work while every reader saw the pre-run thread (the reported "proxy sudah
selesai, browser beku" bug). `/api/chat` therefore folds the same StreamEvents
it publishes into a turn mirror (`server/turnMirror.ts`): a cadence flush
(~1.5 s) plus a terminal flush in the run's `finally`. The terminal guard runs
on EVERY flush — a store turn that already carries `usage`/`finishReason`/
`error` was written by the client's richer flush, and the mirror stands down
instead of clobbering it. One-shot helpers (compaction, auto-titling) open no
mirror.

**Turn ids are owned by the run, not by the tab.** The client mints
`assistantTurnId` before POSTing; the server adopts it and echoes it on the
`stream_id` frame — which rides the replay buffer, so a reload re-attach or a
second browser's live-loop re-attach adopts the SAME id and paints into the
same turn. Before this contract each consumer minted its own `uid('turn')` and
the shared record grew one duplicate assistant reply per consumer.

**A stalled run ends honestly.** The registry stamps `lastFrameAt` on every
published frame; a periodic sweep (30 s) aborts a run whose last frame is older
than `STALL_TIMEOUT_MS` (240 s — clear of the 180 s subscriber grace), and
`GET /api/chat/live` exposes `lastFrameAt` so a badge can tell "working" from
"wedged". Previously a silently-stalled upstream (FREEZE-RESILIENCE class F1)
stayed `live` forever: the badge spun for hours over a frozen thread.

**Merge order is timestamp-first, on both sides.** `rev` is a per-CLIENT
monotonic counter (the streaming tab bumps it on every token), so cross-tab
rev comparison is meaningless; the server merge gate reads `updatedAt` first
and only falls to `rev` at a strict tie, and the client's fold
(`localIsNewer`/`keepLocalBody` in `useStore`) mirrors that exact order. A
rename is user activity and bumps BOTH — it lands strictly newer and wins on
the server merge, then every tab's fold pulls it in (the reported "sesi
dinamai acak" bug).

**A run survives a proxy crash.** The registry's in-memory buffer dies with
the process, so every frame is ALSO journaled to `runs/<streamId>.jsonl` as
it is published (one JSON-encoded record per line — the exact SSE strings
already buffered, so the in-memory and disk shapes are identical). A run
that reaches its natural end writes a terminal `end` record; at boot,
`rehydrateRuns()` scans the directory and resurrects every journal whose run
never terminated as an ENDED, replayable corpse: probes answer `done`, a
reload replays its frames exactly like a finished run's retained buffer, and
the partial reply is rebuilt instead of evaporating. Terminated and
overflowed journals are dropped (the completed run's content already lives in
the conversation store; an overflowed one is not replayable). Journaling is
best-effort throughout — a disk failure never breaks a generation.

## Client (`src/`)

### State — `store/useStore.ts`

A single zustand store, persisted to `localStorage` (`nova.conversations.v1`,
debounced 600 ms). Key slices:

- `conversations` — each with its own `settings` (system instruction, thinking
  level, sampling, tool toggles, context-management fields), `turns`, optional
  `compaction`, and per-conversation provider/model binding.
- `providers` / `providerId` / `model` — the active chat route.
- `genRunning` — per-conversation generation lock (one stream per chat,
  different chats may stream in parallel).
- Mutations used by the thread UI: `appendTurn`, `updateTurn`,
  `replaceConversations`, `branchFromTurn` (fork a chat up to a turn),
  `deleteTurn` (a user turn takes its assistant reply along),
  `setCompaction`.

### Turn model — `types.ts`

A `Turn` is one chat row:

- `role: 'user' | 'assistant'`, `content`, optional `reasoning`,
  optional `attachments`, `usage` (token totals), `error`.
- `segments?: TurnSegment[]` — ordered `text | tool` blocks so multi-round MCP
  replies render as *text → tool card → text → …* instead of one blob.
  `content` stays a joined plain string for copy/edit/branch.

### Chat controller — `hooks/useChatController.ts`

One hook owns every generation path: `send`, `stop`, `regenerate`,
`continueChat` (reply to the trailing user message without adding one —
`send(…, { continueOnly: true })`), and `compactNow`. Notable internals:

- **Shared abort registry.** The hook is instantiated by more than one
  component (App, Thread), so the `AbortController` map lives at module
  scope — every instance sees the same controllers, and Stop always works
  regardless of which path started the stream.
- **Coalesced writes.** Token deltas arrive far faster than the eye needs;
  store writes are flushed on a 50 ms trailing timer (`flushNow` /
  `scheduleFlush`), with tool-call state transitions painted immediately.
- **Wire history.** Compaction summary (if any) rides as a tagged leading
  user message, then every turn not covered by it (attachments translated
  via `toWireContent`).

### Thread rendering — `components/Thread.tsx`

- `MessageRow` is `memo`-wrapped; App passes `useCallback`-stable handlers so
  streaming re-renders only the growing row.
- `ReasoningBlock` — collapsible reasoning strip; the brand cat is the live
  indicator (animated while thinking, static mark once output starts).
- `ToolCallCard` — one card per MCP round with running/result state.
- Markdown (GFM, math via KaTeX) for assistant output **and** user input;
  copying always uses the raw source text.
- Scroll follow uses scroll-direction intent (not an IntersectionObserver
  sentinel) plus a "Latest" jump pill.

### Context management — `lib/compaction.ts`

- `estimateTokens` (chars/4) drives the `Σused / limit` chip in the composer.
- `effectiveContextLimit` = user override ?? model metadata context ?? none —
  **no hard-coded default**.
- Auto-compaction triggers (`threshold`, `context-limit`, or manual) run
  **before** a new exchange lands: older turns (keeping the most recent N
  pairs) are condensed by the chat model into a summary stored on the
  conversation (`compaction.coveredTurnIds` marks what it replaces).

## Server (`server/`)

### HTTP surface — `index.ts`

- `POST /api/chat` — SSE stream of `StreamEvent`s, owned by the stream
  registry: frames are buffered so a page reload can re-attach via
  `HEAD/GET /api/chat/resume/:id`; the upstream is aborted only when the
  grace window expires with nobody attached, or on
  `POST /api/chat/stream/:id/abort` (the Stop button) — so a stopped
  generation still stops costing tokens.
- `GET/POST/DELETE /api/providers…`, `PUT /api/providers/builtins/:id/key` —
  provider CRUD, built-in credentials, user-added model ids, and
  **live model lists** (`setModels` — a fetch of the provider's own `/models`
  replaces the aging curated defaults; stored in `~/.moriko`).
- `GET /api/providers/:id/models` — proxy that lists models straight from the
  provider (OpenAI-compatible, Anthropic, Gemini variants).
- `GET /api/model-metadata` — context windows / capabilities snapshot
  (refreshed by `pnpm sync:models`).
- MCP server management + image-generation endpoints (see below).

### Adapters — `adapters/`

One streaming adapter per wire format: `openai.ts` (covers every
OpenAI-compatible vendor: OpenAI, Bitdeer, Modelscope, Groq, …),
`anthropic.ts`, `gemini.ts`. Each streams text, reasoning, and tool calls as
normalized `StreamEvent`s and implements the MCP tool loop:

```
stream → tool_call events → executeCalls → tool results into history →
next stream round … until the model ends its turn OR the LoopGuard trips
```

Termination is round-independent (`mcp/loop.ts` `createLoopGuard`), never a
silent count; the guard folds when either of two containment tracks observes
`STALL_REPEATS` (3) consecutive rounds:

- **exact-signature stall** — the same set of call signatures
  (`wire name` + key-sorted args JSON, see `toolCallSignature`) repeated
  verbatim;
- **failure-class fold** — every round failed with the SAME
  `(tool, errorCode)` failure class even while the calls' arguments morphed
  between rounds. This exists because the edits[] incident measured a spin
  the signature track could not see: the provider re-sent the same broken
  call shape (a double-encoded JSON string) round after round, sometimes
  trivially varied, so the shapes never matched. Successful outcomes map to
  nothing — three rounds of success NEVER look like a repeated failure.

Both tracks feed the same `record(signatures, usage, addedTokens, outcomes)`
call in every adapter; `outcomes` carries each executed result's
`wireName` + stable `errorCode`. The hard cap (`MAX_TOOL_ITERATIONS = 40`,
safety valve only) and the **context budget** (last round's prompt > 85% of
the model's models.dev window) remain unchanged. When the guard trips, the
tools are NOT quietly stripped — the next request omits them AND carries an
explicit wrap-up instruction (`wrapUpInstruction`); the model closes with a
summary and the `done` event reports the real reason
(`context_budget` | `stalled` | `tool_iteration_cap`), which the client
renders as a visible note on the turn.

**Audit fidelity**: every harness call lands in the per-session JSONL
(`~/.moriko/audit/`) with `argsLen` + `argsTruncated` (explicit, non-silent
truncation markers), so a short `args` digest is never mistaken for a
provider-truncated payload, plus the stable `errorCode` that feeds the
failure-fold track. `errorCode` is also surfaced on `HarnessToolResult` for
every denial and thrown error in the tool pipeline (`schema_error` /
`tool_exception`).

Every adapter checks the abort signal between rounds, and `executeCalls`
skips remaining calls once aborted — Stop never waits on a long MCP
round-trip. System prompts are assembled per adapter
(`buildSystemInstruction`): persona + tool guidance + fetch-web hint.

### MCP subsystem — `mcp/`

- `client.ts` — talks to MCP servers over **stdio** (spawned local processes)
  or **Streamable HTTP** (remote servers); JSON-RPC initialize/tools-list/
  tools-call.
- `manager.ts` — owns configured servers, exposes the merged wire-tool list
  (per-server `disabledTools` filtered out), and routes calls to the right
  client with timeouts.
- `config.ts` / `store.ts` — server configs and credentials persisted under
  `~/.moriko/`.
- `loop.ts` — `prepareTools` (defs for the current provider format),
  `executeCalls` (individual tool failures become `isError` results the model
  can recover from), `createLoopGuard` (exact-signature stall + failure-class
  fold + hard cap + context budget + the wrap-up instruction),
  `MAX_TOOL_ITERATIONS`.

### Built-in Agents — `agents/`

Agent mode (`settings.agentMode`) merges three harness tools into the SAME
tool loop as MCP (`agent__grep`, `agent__read_file`, `agent__edit_file`),
dispatched by wire-name prefix inside `executeCalls`. `workspace.ts` keeps
the registry of user-picked directories (`~/.moriko/agents.json`), resolves
every tool path against the ACTIVE root (escape attempts are refused), and
emits the system-prompt hint the adapters append. `routes.ts` serves
`/api/agent/*`: registry CRUD, the read-only `browse` listing behind the
file-explorer picker, and a debug `/call` used by `scripts/test-agent-e2e.mjs`.

Self-edit resilience: when the active workspace is Moriko's own source
(`selfHosted`, auto-detected), the agent can modify the harness safely —
protected paths are refused, and changes go live only through the
typecheck-gated, stream-draining supervisor reload. See
[SELF-EDIT-RESILIENCE.md](./archive/SELF-EDIT-RESILIENCE.md).

### Provider registry — `providers.ts` + `store.ts`

- Built-ins: **OpenAI** (chat) and **Civitai** (image, Orchestration API).
- Custom providers: any OpenAI-compatible base URL + key. Definitions live in
  `~/.moriko/providers.json`; EVERY key — custom and built-in — lives in the
  `~/.moriko/api-keys.json` vault beside its endpoint, together with
  user-added and live-fetched model lists.
- `resolveCredentials` prefers env keys (headless setups) over vault keys.

### Image side

Image Studio routes through image adapters (`adapters/images/`, e.g.
`civitai-orchestration`), with per-provider `imageCapabilities` deciding what
the UI exposes; generated output lands in the gallery (`/api/gallery`).

## Security model

- Provider keys live **server-side only** (the `~/.moriko/api-keys.json`
  vault, or env). The proxy injects them upstream; the browser receives
  stream text, never credentials.
- `.env` / `.data/` are gitignored, and `~/.moriko/` sits outside the repo;
  `.env.example` documents the shape. The harness additionally refuses any
  path under `~/.moriko` even when a workspace or allowlist would cover it.
- CORS is pinned to the local dev origins; the proxy binds locally.
- User-supplied keys (custom providers) travel per-request only, over
  same-origin HTTP to the local proxy.

## Commands

```bash
pnpm dev          # server (tsx watch, :8791) + web (vite, :5178)
pnpm typecheck    # tsc -b over app + node tsconfigs
pnpm build        # typecheck + vite build → dist/
pnpm start        # production: proxy serves the built SPA
pnpm sync         # refresh model metadata snapshots (models/diffusion/civitai)
node scripts/test-mcp-e2e.mjs     # MCP end-to-end smoke test
node scripts/test-fetchweb-e2e.mjs
node scripts/test-agent-e2e.mjs   # Agent harness smoke test (no API key)
```

## Testing notes

`scripts/` hosts standalone e2e scripts (real MCP servers, fetch-web, Bitdeer
tools) and mock OpenAI-image providers for adapter tests in `tests/`. They are
plain Node scripts — no test runner required.
