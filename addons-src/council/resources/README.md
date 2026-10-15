# Council Agent — Sub-Session Councils

One conversation, many agent sessions. **Council Agent** turns a chat into a
*council*: a **Main Session** (the one visible sidebar row) containing N
**Sub Sessions** — one per RSA/T agent — each with its own context, model and
turns. Sub sessions are hidden from the sidebar and history; you switch
between them from a transparent dropdown below the chat title in the TopBar
(a non-council chat shows a "Turn into council" affordance in the same spot —
no panel detour needed).

This keeps "one RSA/T project" to a **single sidebar row** no matter how many
agents are working it, and every agent keeps an isolated context.

## How it fits Moriko + RSA/T

- **Host (harness)** owns the conversation model: `Conversation.councilId`,
  `councilRole` (`'main' | 'sub'`) and `councilAgentId` group the records. Sub
  sessions are real conversations (own turns, compaction, provider/model) —
  they stream, sync and hydrate like any other chat; they are simply filtered
  out of the sidebar Recent Chat, the workspace groups and the History view.
- **RSA/T dispatch** is council-aware: dispatching an agent from a council
  container creates (or reuses) a Sub Session bound to that agent, instead of
  a new top-level chat. Re-dispatching the same agent reuses its existing sub
  session (no session bloat). COUNCIL dispatch is INJECTION-ONLY: the agent's
  first directive is queued server-side and rides the council prompt fragment
  at the sub session's first fetch — no fake user message, no auto-started
  round; the agent `council_ack`s it once absorbed. (The RSAT board's own
  quest dispatch keeps its auto-send semantics.)
- **Council Agent addon** owns the *policy*: the council panel (sidebar view
  `addon:council/panel`), the shared **brief** every member reads, the
  per-session prompt fragment (council identity + roster + brief + directive),
  and the agent tools `council_status` / `council_broadcast` / `council_brief`
  / `council_ack`.

## Data

The grouping rides the host's conversation records (synced as opaque JSON).
Only the **shared brief** lives in addon-owned files:

```
<workspace>/.moriko/council/
├── .gitignore     (* — git ignores it entirely, like RSA/T)
└── councils.json  { rev, councils: { <id>: { brief, updatedAt } },
                      directives: { <sessionId>: { councilId, text, at } } }
```

## Agent tools

| Tool | | |
| --- | --- | --- |
| `council_status` | read-only | list the council's members + shared brief |
| `council_broadcast` | | post a short notice to the OTHER members (delivered at their next round boundary) |
| `council_brief` | read-only | read the shared brief |
| `council_ack` | | acknowledge + clear your dispatch directive from context |
| `council_roster` | read-only, orchestrator | list dispatchable RSAT agents + which already own a sub session |
| `council_send` | orchestrator | send a task to a sub-session: a RUNNING target gets it injected at its next round boundary, an IDLE target is woken and starts immediately |
| `council_stop` | orchestrator | halt a sub-agent's running response (by agent id, or `all`) |

### Idle sub-sessions (the "message never arrives" fix)

`sessions.inject` only delivers to a RUNNING session (the adapter drains it at
the next round boundary). An idle sub-session has no adapter, so a queued
message would sit forever. `council_send` (and the panel's dispatch/message)
therefore checks `sessions.get()`: a running target is injected; an IDLE target
publishes `council:wake` on the bus and the always-mounted host bridge starts a
run with the instruction as its next turn — so the agent actually wakes up.

## Commands

- `/council` — open the Council panel.
