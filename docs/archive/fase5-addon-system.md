# Fase 5 — Sistem Addon (Arsitektur Baru)

## Pemahaman dari sistem yang dipelajari

### Claude Code Mods
- **`register(on)`** entry point — `on(eventName, matcher?, handler)` mendaftarkan event handler
- **Middleware chain**: `async ($, e, next) => {}` — observe (`return next(e)`), rewrite (`return next({...e, text: newText})`), answer (`return { deny: 'reason' }` tanpa `next`)
- **API surface** (`$`): `$.ui` (draw/invalidate/toast/status/log/ask), `$.command` (register/run), `$.tool` (register/call), `$.model` (complete), `$.session` (messages/send), `$.fs` (read/write), `$.process` (run), `$.http` (fetch), `$.store` (KV), `$.clock` (every/after/sleep)
- **Hot-reload**: file watcher → reload on save → `register()` runs again. **Tidak pernah restart server.**
- **Render sites**: Pane (sidebar), AbovePrompt (band), Spinner, ToolUse, ToolResult, UserMessage, AssistantMessage — addon bisa **menggambar ulang** UI yang sudah ada
- **Matchers**: `{ tool: 'Bash' }`, `{ tool: ['Edit', 'Write'] }`, `{ tool: /^mcp__github__/ }` — filter sebelum handler
- **Elements**: Box, Text, Button, Input, Select, Code, Markdown
- **Error handling**: `.catch(handler)` per registration — hook gagal di-skip, next handler jalan

### Deepseek Harness
- **`defineTool(options)`**: typed tool dengan `name, description, parameters` (schema spec), `output` (schema + render), `execute(args, exec)`, `presentCall(args)`, `presentResult(args, result)`, `isConcurrencySafe(args)`, `timeoutMs`
- **`ctx.tools.register(defineTool({...}))`** — dynamic registration dari dalam context
- **Pipeline**: `tools/pre-execute` (waterfall, allow/deny) → `tools/execute` (around, timeout/retry) → `tools/post-execute` (accept/replace/block) → `tools/result` (emit, observe). Setiap stage waterfall dengan `next()`.
- **Live profiles**: "Live profiles apply changes immediately; startup profiles require restart" — hot-reload untuk live profiles
- **Presentation**: `ToolCallView` / `ToolResultView` dengan typed views (generic, terminal, diff, search, web, read)

### Moriko saat ini
- **`AgentToolDef`**: `{ wireName, description, inputSchema }` — flat JSON Schema, tidak ada output schema atau presentation
- **`listAgentToolDefs()`**: hardcoded array 80+ tools, sudah merge addon defs
- **`callAgentTool`**: giant switch-case, default cek addon registry
- **`runPipeline`**: hook chain `schemaValidator` → `spatialGate` → `auditHook`. Hook interface: `{ name, preExecute, transform?, postExecute }`
- **`prepareTools`** di loop.ts: panggil `listAgentToolDefs()` setiap request, filter, build provider-native defs
- **Thread**: `visibleTurns.map(turn => <div key={turn.id}><MessageRow/></div>)` — flat list, tidak ada render site slot
- **Right dock**: `rightPanelMode === 'tree' ? Tree : Settings` — dua tab hardcoded
- **PipelineCall**: `{ wireName, name, args, ctx, durationMs?, gateBefore? }` — context sederhana

## Arsitektur addon Moriko (redesain)

### Prinsip desain (diadopsi dari Claude Code Mods + Deepseek Harness)
1. **`register(on)` entry point** — addon mengekspor `register(on)` yang mendaftarkan hooks
2. **Event bus + middleware chain** — `on(event, matcher?, handler)` → `async ($, e, next) => {}` dengan observe/rewrite/answer
3. **API surface** (`$`) — konteks yang diterima handler: `$.tool.register`, `$.ui.draw`, `$.command.register`, `$.store`, `$.http`, `$.fs`, `$.clock`
4. **Hot-reload tanpa restart** — file watcher → unload addon → `register()` jalan lagi. Server tidak pernah restart untuk addon baru.
5. **Render sites** — addon bisa gambar di: `thread-sidebar`, `composer-band`, `right-dock`, `floating`, `tool-row`, `spinner`. Bisa override UI yang sudah ada.
6. **Matcher** — `{ tool: 'agent__run' }` filter event sebelum handler
7. **`.catch(handler)`** — error handler per registration, fail-closed
8. **Dynamic tool registration** — `$.tool.register({ name, description, inputSchema, execute })` dari dalam hook, bukan hanya deklarasi statis di manifest

### Struktur addon
```
~/.moriko-studio/addons/<id>/
├── addon.json           # manifest (metadata only)
├── register.ts          # entry point: export function register(on, $)
└── client/
    └── index.tsx        # widget component (React, lazy-loaded by host)
```

### Manifest: `addon.json` (metadata only — tools/hooks daftar via register())
```typescript
interface AddonManifest {
  id: string;
  name: string;
  version: string;
  description: string;
  author?: string;
  enabled?: boolean;  // default true
}
```

### Entry point: `register.ts`
```typescript
export function register(on: AddonEventRegistrar, api: AddonApi): void | Promise<void> {
  // Register a tool dynamically
  api.tool.register({
    name: 'custom_lookup',
    description: 'Look up a ticket by id',
    inputSchema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
    execute: async (args) => ({ ok: true, text: `Ticket ${args.id}: ...`, isError: false }),
  });

  // Observe every tool call
  on('tool.call', async ($, e, next) => {
    $.ui.log(`Tool ${e.tool} called`);
    return next(e);
  });

  // Guard: deny dangerous commands
  on('tool.call', { tool: 'agent__run' }, async ($, e) => {
    if (String(e.args?.command ?? '').includes('rm -rf')) {
      return { deny: 'rm -rf is blocked by addon policy' };
    }
    return next(e);
  });

  // Draw a widget in thread-sidebar
  on('ui.render', { site: 'thread-sidebar' }, async ($, e) => {
    return { element: { type: 'widget', component: './client/index.tsx' } };
  });

  // Register a command
  api.command.register({ name: 'standup', description: 'Daily summary' });
  on('command.run', { command: 'standup' }, async ($, e) => {
    return { text: 'Summary: ...' };
  });
}
```

### Event system
```typescript
type AddonEvent =
  | 'tool.call'          // before tool executes (observe/rewrite/answer)
  | 'tool.result'        // after tool executes (observe)
  | 'turn.start'         // assistant turn begins
  | 'turn.end'           // assistant turn ends
  | 'session.open'       // conversation opened
  | 'command.run'        // user runs /command
  | 'ui.render';         // render site about to draw
```

### Render sites
| Site | Lokasi | Kapan di-fired |
|---|---|---|
| `thread-sidebar` | Panel samping thread | Saat thread render |
| `composer-band` | Band di atas composer | Saat composer render |
| `right-dock` | Tab tambahan di dock kanan | Saat dock render |
| `floating` | Overlay floating (fixed position) | Selalu |
| `tool-row` | Override tampilan tool call | Saat ToolCallCard render |
| `spinner` | Override activity pill | Saat ActivityTicker render |

### Hot-reload (tanpa restart server)
1. File watcher di `~/.moriko-studio/addons/` (recursive, 500ms debounce)
2. Saat file berubah: `unloadAddon(id)` → `clearAddonTools(id)` → `loadAddon(id)` → `register(on, $)` jalan lagi
3. Tool/widget baru langsung tersedia di request berikutnya — `listAgentToolDefs()` dan `prepareTools()` baca registry real-time
4. Server tetap berjalan. Klien tidak perlu reload (widget list di-fetch on-demand)
