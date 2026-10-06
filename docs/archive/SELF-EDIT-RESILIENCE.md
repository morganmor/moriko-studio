# Harness Self-Edit Resilience

How the built-in Moriko agent can safely **edit Moriko Studio's own source
code** — including the server it is running on — without killing its own
conversation, and how broken changes are kept from ever going live.

Status: implemented and verified live (2026-09-17). Scope: Fase 1 + 2 of the
self-edit plan (safe editing + no stream interruption). Fase 3 (durable job
journal, watchdog) and Fase 4 (modular tool registry, MCP self-serve) build on
this base.

---

## The problem

The agent's model stream flows **through the very server the agent edits**.
Under the previous setup (`tsx watch`), editing any file under `server/`
instantly restarted the proxy and tore apart every in-flight SSE stream — the
agent killed its own conversation by doing its job. Three hazards had to be
solved:

1. **Self-destruction by restart** — edits restart the proxy mid-stream.
2. **Self-destruction by content** — the harness could read/write its own
   secrets (`.env`), state (`.data/`), or break the build and reload it.
3. **Silent breakage** — nothing stopped broken code from going live.

## The design in one sentence

> The agent edits files freely inside the workspace; changes go live only
> through a **typecheck-gated, stream-draining, supervisor-executed reload**,
> and nothing can ever touch secrets, app state, dependencies, or VCS
> internals.

## Data flow

```
agent edits source (edit_file, vault snapshot per mutation)
        │
        ▼
agent__harness_reload
        │
        ├─ 1. APPLY GATE: `tsc -b` (tsconfig.app + tsconfig.node)
        │       fail → 409 + compiler output returned to the model,
        │              reload REFUSED, running server untouched
        │       pass → reload marked pending
        ▼
stream drain: the exit fires only when activeStreams === 0
        │  (running replies finish untouched)
        ▼
process.exit(75)
        │
        ▼
supervisor sees 75 → respawns IMMEDIATELY (fresh server)
   any other exit   → respawns with backoff 1s → 10s (reset after 30s uptime)
```

## Components

### 1. Supervisor — `scripts/dev-server.mjs`

`pnpm dev:server` runs the proxy under a small supervisor instead of
`tsx watch`. Contract:

| Child exit | Supervisor behaviour |
| --- | --- |
| `75` | graceful reload → restart immediately |
| anything else | crash → restart with backoff 1s → 2s → 4s → 8s → 10s cap; backoff resets after 30s of healthy uptime |

File changes deliberately do **not** restart the server anymore. Restarting is
an explicit, gated act (`agent__harness_reload`), never a side effect of
saving a file. `pnpm dev:server:watch` (plain `tsx watch`) remains available
for human-only sessions.

### 2. Reload machinery — `server/agents/reload.ts`

- `beginStream()` / `endStream()` — every `/api/chat` request holds one slot
  for its **entire** lifetime (taken before validation, released by the
  response `close` event, which fires on normal completion, error responses,
  and client disconnects alike — no leak paths).
- `harnessReloadNow()` — the apply gate. Runs `tsc -b tsconfig.app.json
  tsconfig.node.json` **directly via node** (resolving
  `typescript/bin/tsc`), *not* `pnpm typecheck`: a package-manager wrapper
  carries pre-run hooks (dependency verification / installs) that turn a
  plain compile into an environment-sensitive side effect. Timeout 300 s.
- On pass: reload goes pending; when `activeStreams === 0` an exit timer
  (600 ms) fires `process.exit(75)`.

### 3. Agent tool — `agent__harness_reload`

Registered in `listAgentToolDefs` and dispatched in `callAgentTool`
(`server/agents/tools.ts`). The model calls it **after finishing a batch of
edits**. The refusal path returns the compiler output *to the model*, so it
can fix its own code and retry — the self-healing loop.

HTTP twin: `POST /api/agent/harness-reload` → `200` `{ ok, text }` on pass,
`409` with the compiler output on refusal.

### 4. Self-host guard — `server/agents/workspace.ts`

A workspace whose `package.json` has `name: "moriko-studio"` is flagged
`selfHosted` (auto-detected at registration; legacy entries are detected
lazily). `assertSelfHostAccess(absolute, intent)` runs inside **every** path
resolution (`resolveWithPermission` / `resolveManyWithPermission`) — so the
guard holds on all routes into
the filesystem: active workspace, user-whitelisted folders, and even
user-approved outside targets.

| Level | Paths | Effect |
| --- | --- | --- |
| `no-access` | `.env`, `.env.*`, `.data/` | blocked for **reads too** — file content would leak into the model context |
| `no-write` | `node_modules/`, `.git/` | reads fine; mutations go through the `run` / `git` tools instead |

### 5. Undo — vault snapshots (pre-existing, verified)

Every destructive tool already snapshots before mutating: `edit_file`,
`delete` (file and tree), `download` (overwrite). Creation needs no snapshot. Restore: `POST
/api/agent/vault/restore`; listing: `GET /api/agent/vault?session=…`.

### 6. Client resilience — `src/hooks/useChatController.ts`

Transient connection loss (proxy restarting under the user, crash, network
blip) is detected by signature (`Cannot reach the local Moriko proxy`,
`Failed to fetch`, `socket hang up`, `ECONN*`, …). On the first loss:

1. the partial turn is **not** marked as an error and running goals are not
   paused,
2. the client polls `/api/health` for up to 45 s,
3. then re-enters the conversation with a `continueOnly` send — the model
   continues from the full history, partial reply included.

The resume budget is one per conversation and is restored only by a stream
that ends **without** a connection loss, so retries never chain. Provider
rejections and user Stops never trigger it.

## Live verification record (2026-09-17)

End-to-end trial: the agent was asked to create a brand-new tool
(`agent__hash` — SHA-256 of `{ text }`) in `server/agents/tools.ts`.

| Step | Result |
| --- | --- |
| Model read code, made 3 edits | ✅ each edit vault-snapshotted |
| Model applied while `hashTool` was still missing | ✅ gate **refused**: HTTP 409, `TS2304: Cannot find name 'hashTool'`, `TS6133: 'createHash' is declared but its value is never read`; server untouched (uptime kept climbing) |
| Model told the compiler errors → fixed its own code | ✅ edit applied |
| Model called `agent__harness_reload` | ✅ `Typecheck passed (14.0s)` → stream finished → `exit(75)` → supervisor respawned |
| Fresh server | ✅ health uptime reset (18.4 s) |
| New tool verified | ✅ `agent__hash("moriko-self-edit-test")` = `e558de5441c444476ff6b11ccf73502c06741191af0b6fad829a8717b860a9f2` — exact match with an independently computed SHA-256 |

Guard probes (live, via `POST /api/agent/call`):

| Probe | Result |
| --- | --- |
| `read_file .env` | refused (`no-access`) |
| `read_file .data/agents.json` | refused (`no-access`) |
| `edit_file node_modules/.guard-test` | refused (`no-write`) |
| `edit_file .git/config` | refused (`no-write`) |
| `list .` | works (normal operations unaffected) |

Supervisor crash-recovery was also exercised (a sandboxed child failing to
boot produced the documented 1 s → 2 s → 4 s → 8 s → 10 s restart ladder), and
the full reload cycle was exercised on a throwaway instance
(`PORT=8792 DATA_DIR=.data-test node scripts/dev-server.mjs`).

## Operating notes

- **One-time switch**: `dev:server` now runs the supervisor. Restart
  `pnpm dev` (or `npm run dev`) once to leave plain `tsx watch` behind.
- **Manual reload**: `curl -X POST http://127.0.0.1:8791/api/agent/harness-reload`
  — same gate, same drain.
- **Throwaway instance for experiments**: `PORT=8792 DATA_DIR=.data-test
  node scripts/dev-server.mjs` (separate store, separate port).
- **pnpm build-scripts approval**: `pnpm-workspace.yaml` carries
  `allowBuilds: { esbuild: true }`. pnpm 11 writes a *placeholder* into that
  file the first time a build script is blocked; an unanswered placeholder
  makes every pnpm command fail with `ERR_PNPM_IGNORED_BUILDS`. Keep it
  answered.

## Known limitations / next steps

- **Provider flakiness is the remaining failure mode.** During the live trial
  the model twice received empty completions mid-task and once stopped after
  announcing a plan. The harness contained every failure cleanly (honest turn
  errors, snapshots intact, guards held) and the task resumed from nudges.
  Planned: one-shot auto-retry on *empty provider responses* (the client
  auto-resume currently covers connection loss only) and a durable job
  journal so long agent tasks survive restarts (Fase 3).
- The model's first tool call in a turn occasionally uses a bare tool name
  (`read_file`) and fails with `Unknown tool`, then retries correctly — a
  tool-naming emphasis fix in the harness injection is a cheap follow-up.
- The gate compiles; it does not run tests. A `pnpm test` stage can be added
  to `harnessReloadNow` when the project grows a test suite.
