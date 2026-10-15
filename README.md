# Moriko Studio

## Preview

<p align="center">
  <img src="./docs/preview1.PNG" alt="Main Preview" width="100%"/>
</p>

<details>
  <summary><b>🔍 See more screenshots (Preview 2 - 5)</b></summary>
  <br>

  | Preview 2 | Preview 3 |
  | :---: | :---: |
  | <img src="./docs/preview2.PNG" width="100%"/> | <img src="./docs/preview3.PNG" width="100%"/> |

  | Preview 4 | Preview 5 |
  | :---: | :---: |
  | <img src="./docs/preview4.PNG" width="100%"/> | <img src="./docs/preview5.PNG" width="100%"/> |
</details>

---

## Quick start

```bash
npm install
npm run dev
```

---

## What's inside

| Area | What it does |
| --- | --- |
| **Playground** | Streaming multi-turn chat with markdown, GFM tables, KaTeX math, and copyable code blocks. |
| **System prompt** | Free-text system prompt with six presets, plus your own saved prompts. |
| **Thinking level** | Off / Low / Medium / High, mapped onto each provider's own reasoning control. |
| **Tools** | Structured outputs, code execution, function calling, URL context. |
| **Text size** | Small / Default / Large / Extra large, applied to the chat thread and composer. |
| **Image Studio** | Text-to-image testing against async generation APIs (ModelScope style). Pick any provider and model in Run settings — the panel adapts to the view. Optional output-size override: explicit pixels (sent as `size` + `width`/`height`) or an aspect-ratio preset (sent as `aspect_ratio`), forwarded untouched so you can see what each provider accepts. |
| **Gallery** | Persisted image collection: save Image Studio results one by one or all at once, reorder, and remove. |
| **Providers** | One built-in (OpenAI) plus unlimited custom providers (label, base URL, API format, models, key). |
| **History** | Threads saved in `localStorage`, grouped by day and searchable. |
| **Export / import** | One JSON bundle for conversations and browser-saved keys, validated on import. |
| **Themes** | Dark (default) and light, with AA-checked contrast in both. |

### System Prompt Harness :
- You can customize your harness system prompt injection by looking at file :
```
server/agents/systemPrompt.ts
```

- For harness tools catalogue, you can modify it in :
```
server/agents/tools/catalogue.ts
```

---

### Updating model support

The app keeps local snapshots of what each model can do — reasoning support,
image input, context window — plus a catalogue of community image
models, so the UI can offer the right controls for every model.

Refreshing is only about model support; nothing else depends on it:

```bash
pnpm sync
```

`pnpm dev` refreshes snapshots older than 24 hours on its own before starting,
and when you are offline it keeps the current snapshot and starts anyway.

---

### Configuration
**You can change proxy port at :**
- vite.config.ts — Line  6: const proxyTarget = process.env.PROXY_TARGET ?? 'http://127.0.0.1:8826'
- server/index.ts — Line  123: const PORT = Number(process.env.PORT ?? 8826)

**For webdev port :**

- vite.config.ts — Line 15: port: 5588

---

### Where your data lives

One root, overridable with `MORIKO_HOME` (also from **Settings → Data**, persisted in
`.env` — takes effect on the next harness reload) — nothing is stored inside the
source tree:

```
~/.moriko-studi(or you custom location)/                 
├── providers.json                
├── api-keys.json                 
├── vision.json                   
├── mcp.json                      
├── agents.json                   
├── settings.json                 
├── reminders.json                
├── audit/ jobs/ read-state/ vault/   
├── conversation/
│   ├── index.json                
│   ├── manifest.json             
│   ├── chat-001-20260919/
│   │   ├── chat-data.json        
│   │   └── goals-plan.json       
│   └── detached/<session>.json   
├── image-session/
│   ├── data.json                 
│   ├── images/                   
│   ├── task-state.json · 
│   └── tasks.jsonl
└── gallery/
    └── data.json                 
```

---

## MCP (Use MCP)

Moriko speaks the [Model Context Protocol](https://modelcontextprotocol.io) —
register tool servers in **Settings → MCP servers** and turn on **Use MCP**
(Sidebar Configuration → Tools), so the model can call their tools mid-conversation.

Two transports:

- **Local command (stdio)** — the proxy spawns the server and speaks JSON-RPC
  over stdio. Example: the reference filesystem server

  ```
  name:    Filesystem
  command: npx
  args:    -y @modelcontextprotocol/server-filesystem C:/path/to/allow
  ```

- **Remote URL (Streamable HTTP)** — connect to a hosted MCP endpoint and send
  auth headers. Example: `https://mcp.deepwiki.com/mcp` with
  `Authorization: Bearer …` headers when required.


Notes:

- There is no fixed round limit: the loop keeps going while the model keeps
  making useful calls, with spin-guards that catch a model repeating itself. A
  single tool call times out after 90 s, and tool output is truncated before it
  re-enters the model context.
- Server configs live in `~/.moriko-studio/mcp.json` header/env secrets never leave
  the server (the settings UI only ever sees masked values).

---

## Scripts

| Command | Description |
| --- | --- |
| `npm run dev` | Proxy + Vite dev server together. |
| `npm run dev:web` | Vite only |
| `npm run dev:server` | Proxy only, reloading on change. |
| `npm run build` | Typecheck, then build to `dist/`. |
| `npm start` | Serve the built app from the proxy (production). |
| `npm run typecheck` | Types only, no emit. |
| `pnpm sync` | Refresh the model-support snapshots. |

---

## Security notes

- **Keys never reach the browser** for built-in providers, the client sends a
  provider id, the server attaches the credential.
- **Imports are validated.** Every field of an imported bundle is coerced and
  clamped; malformed conversations are dropped rather than trusted.
- **The proxy binds to localhost.** It is a development tool — put real auth in
  front of it before exposing it to a network.

---

## Known limitations

- "Share this chat" copies a link containing the conversation id; that id is not
  resolvable by anyone else, since threads live in `localStorage`.
- Code execution and function calling are passed to the model as instructions,
  not executed locally.
- For Vault, the agent currently does not read the full code, so for now Vault will only restore files rather than the selected code areas.
