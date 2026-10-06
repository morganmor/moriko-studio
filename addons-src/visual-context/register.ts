/**
 * visual-context — OpenGhost-style conversation visuals for Moriko.
 *
 * How it works (addon-only, no core edits):
 *  1. Registers ONE tool: agent__visual-context_visual_context (wire name is
 *     `agent__<addonId>_<name>` and this addon's id is "visual-context").
 *  2. The tool validates a small declarative spec (the "diagram DSL" - the same
 *     idea as OpenGhost's 43-kind drawing engine, simplified to 4 primitives
 *     that cover the reference screenshots: stat tiles, horizontal bars,
 *     timelines and glossaries).
 *  3. On success it returns a HarnessToolResult carrying `visual` - a complete
 *     standalone HTML document. The EXISTING Fase-D channel renders it:
 *     mcp/loop.ts picks result.visual up for ANY agent__ tool, turnMirror
 *     persists it on the segment, the client draws it in a sandboxed iframe
 *     (VisualCard) and hoists the newest card above the activity pill.
 *  4. $.context.provide() teaches every future session the DSL exists, so the
 *     model knows to call the tool - again, an addon hook, not a core prompt.
 *  5. on('tool.result') + $.bus.publish() re-broadcasts each visual over SSE so
 *     other connected browsers update live (addon bus, not a core channel).
 */
export function register(on, $) {
  const SPEC_LIMITS = {
    tiles: { max: 12 },
    bars: { max: 24 },
    timeline: { max: 24 },
    glossary: { max: 40 },
  };

  const colors = {
    blue: '#3b82f6', orange: '#f97316', teal: '#14b8a6', red: '#ef4444',
    lilac: '#8b5cf6', green: '#22c55e', yellow: '#eab308', pink: '#ec4899',
  };
  const pick = (name) => colors[name] || colors.blue;

  /** Escape untrusted strings before they enter the HTML document. */
  function esc(value) {
    return String(value)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  // ── type coercion helpers (the pipeline schema validator is depth-bounded) ──
  function asString(v, fallback = '') {
    return typeof v === 'string' ? v : typeof v === 'number' || typeof v === 'boolean' ? String(v) : fallback;
  }
  function asNumber(v, fallback = null) {
    if (typeof v === 'number' && Number.isFinite(v)) return v;
    if (typeof v === 'string' && v.trim() !== '') {
      const n = Number(v);
      if (Number.isFinite(n)) return n;
    }
    return fallback;
  }
  function asArray(v) {
    return Array.isArray(v) ? v : [];
  }

  // ── section builders (return HTML strings; all text goes through esc) ──

  function renderTiles(tiles) {
    const items = asArray(tiles).slice(0, SPEC_LIMITS.tiles.max);
    if (items.length === 0) return '';
    const cells = items.map((t) => {
      const label = esc(asString(t && t.label, ''));
      const value = esc(asString(t && t.value, ''));
      const unit = esc(asString(t && t.unit, ''));
      const color = pick(asString(t && t.color, 'blue'));
      const accent = asString(t && t.accent) === 'dot';
      return (
        '<div class="tile">' +
        (accent ? `<span class="dot" style="background:${color}"></span>` : '') +
        `<div class="tile-label">${label}</div>` +
        `<div class="tile-value">${value}${unit ? `<span class="tile-unit">${unit}</span>` : ''}</div>` +
        '</div>'
      );
    });
    return `<div class="tiles">${cells.join('')}</div>`;
  }

  function renderBars(bars) {
    const items = asArray(bars).slice(0, SPEC_LIMITS.bars.max);
    if (items.length === 0) return '';
    const rows = items.map((b) => {
      const label = esc(asString(b && b.label, ''));
      const unit = esc(asString(b && b.unit, ''));
      const value = asNumber(b && b.value, 0);
      const max = asNumber(b && b.max, null);
      const pct = max && max > 0 ? Math.max(0, Math.min(100, (value / max) * 100)) : null;
      const color = pick(asString(b && b.color, 'blue'));
      return (
        '<div class="bar-row">' +
        `<span class="bar-label">${label}</span>` +
        (pct !== null
          ? `<div class="bar-track"><div class="bar-fill" style="width:${pct.toFixed(1)}%;background:${color}"></div></div>` +
            `<span class="bar-pct">${pct.toFixed(0)}%</span>`
          : `<span class="bar-value">${esc(String(value))}${unit ? ` ${unit}` : ''}</span>`),
      ) + '</div>';
    });
    return `<div class="bars">${rows.join('')}</div>`;
  }

  function renderTimeline(steps) {
    const items = asArray(steps).slice(0, SPEC_LIMITS.timeline.max);
    if (items.length === 0) return '';
    const rows = items.map((s, i) => {
      const last = i === items.length - 1;
      const title = esc(asString(s && s.title, ''));
      const detail = esc(asString(s && s.detail, ''));
      const badge = esc(asString(s && s.badge, ''));
      const color = pick(asString(s && s.color, 'green'));
      return (
        '<div class="tl-row">' +
        `<span class="tl-marker" style="${last ? 'background:transparent;border:2px solid ' + color : 'background:' + color}"></span>` +
        '<div class="tl-body">' +
        `<div class="tl-head"><span class="tl-title">${title}</span>${badge ? `<span class="tl-badge">${badge}</span>` : ''}</div>` +
        (detail ? `<div class="tl-detail">${detail}</div>` : '') +
        (last ? '' : `<div class="tl-leg" style="background:${color}"></div>`) +
        '</div></div>'
      );
    });
    return `<div class="timeline">${rows.join('')}</div>`;
  }

  function renderGlossary(entries) {
    const items = asArray(entries).slice(0, SPEC_LIMITS.glossary.max);
    if (items.length === 0) return '';
    const rows = items.map((e) => {
      const term = esc(asString(e && e.term, ''));
      const pron = esc(asString(e && e.pron, ''));
      const meaning = esc(asString(e && e.meaning, ''));
      const example = esc(asString(e && e.example, ''));
      const kind = esc(asString(e && e.kind, ''));
      return (
        '<div class="gl-row">' +
        '<div class="gl-term-cell"><span class="gl-term">' + term + '</span>' +
        (pron ? `<span class="gl-pron">[${pron}]</span>` : '') +
        '</div>' +
        '<div class="gl-meaning-cell">' +
        `<div class="gl-meaning">${meaning}</div>` +
        (example ? `<div class="gl-example">${example}</div>` : '') +
        '</div>' +
        (kind ? `<span class="gl-kind">${kind}</span>` : '<span class="gl-kind"></span>') +
        '</div>'
      );
    });
    return `<div class="glossary">${rows.join('')}</div>`;
  }

  // ── document template (inline CSS only - the iframe CSP blocks everything else) ──

  function buildDocument(spec) {
    const accent = pick(asString(spec.accent, 'blue'));
    const sections = [
      renderTiles(asArray(spec.tiles)),
      renderBars(asArray(spec.bars)),
      renderTimeline(asArray(spec.timeline)),
      renderGlossary(asArray(spec.glossary)),
    ].filter(Boolean);
    if (sections.length === 0) return null;

    return `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<style>
  :root { --accent:${accent}; }
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body {
    font-family: 'Segoe UI', system-ui, -apple-system, sans-serif;
    background: #17171b; color: #e7e7ea; padding: 20px 24px;
    font-size: 14px; line-height: 1.45;
  }
  .vc-title { font-size: 13px; font-weight: 700; letter-spacing: .02em;
    text-transform: uppercase; color: #9a9aa3; margin-bottom: 14px; }
  .vc-title b { color: var(--accent); }
  .vc-note { font-size: 13px; color: #b9b9c0; margin-bottom: 16px; max-width: 70ch; }

  .tiles { display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); gap: 12px; margin-bottom: 18px; }
  .tile { background: #1f1f26; border: 1px solid #2a2a33; border-radius: 12px; padding: 12px 14px; position: relative; }
  .tile-label { font-size: 11px; font-weight: 600; text-transform: uppercase; letter-spacing: .04em; color: #9a9aa3; margin-bottom: 4px; }
  .tile-value { font-size: 24px; font-weight: 700; color: #f4f4f6; }
  .tile-unit { font-size: 12px; font-weight: 500; color: #8a8a94; margin-left: 4px; }
  .dot { position: absolute; top: 12px; right: 12px; width: 7px; height: 7px; border-radius: 50%; }

  .bars { display: flex; flex-direction: column; gap: 10px; margin-bottom: 18px; }
  .bar-row { display: grid; grid-template-columns: 110px 1fr 48px; align-items: center; gap: 10px; }
  .bar-label { font-size: 12px; font-weight: 600; color: #c9c9d1; text-align: right; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .bar-track { height: 8px; background: #24242c; border-radius: 4px; overflow: hidden; }
  .bar-fill { height: 100%; border-radius: 4px; }
  .bar-pct, .bar-value { font-size: 12px; color: #9a9aa3; text-align: right; }

  .timeline { display: flex; flex-direction: column; }
  .tl-row { display: grid; grid-template-columns: 18px 1fr; gap: 12px; }
  .tl-marker { width: 10px; height: 10px; border-radius: 50%; margin-top: 5px; justify-self: center; }
  .tl-body { padding-bottom: 14px; position: relative; }
  .tl-leg { position: absolute; left: -7px; top: 15px; bottom: 0; width: 2px; border-radius: 1px; opacity: .55; }
  .tl-head { display: flex; align-items: baseline; gap: 8px; }
  .tl-title { font-size: 14px; font-weight: 700; color: #f0f0f3; }
  .tl-badge { font-size: 11px; color: #9a9aa3; margin-left: auto; white-space: nowrap; }
  .tl-detail { font-size: 13px; color: #a8a8b0; margin-top: 2px; }
  .tl-row:last-child .tl-body { padding-bottom: 2px; }

  .glossary { border-top: 1px solid #2a2a33; }
  .gl-row { display: grid; grid-template-columns: 200px 1fr 56px; gap: 14px; padding: 10px 0; border-bottom: 1px solid #232329; }
  .gl-term { font-weight: 700; color: #f0f0f3; }
  .gl-pron { font-size: 12px; color: #8a8a94; margin-left: 6px; }
  .gl-meaning { color: #d4d4da; }
  .gl-example { font-size: 12.5px; color: #8a8a94; margin-top: 2px; font-style: italic; }
  .gl-kind { font-size: 11px; color: #7a7a84; text-align: right; align-self: start; padding-top: 3px; }
</style>
</head>
<body>
${sections.join('\n')}
</body>
</html>`;
  }

  // ── the tool ──

  $.tool.register({
    name: 'visual_context',
    description:
      'Render OpenGhost-style conversation visuals inline in the thread: stat tiles, horizontal bars, ' +
      'vertical timelines and glossary tables. Pass at least one of tiles/bars/timeline/glossary. ' +
      'Returns a rendered card for the user; the text summary is what the model sees.',
    inputSchema: {
      type: 'object',
      properties: {
        title: { type: 'string', description: 'Short card heading, e.g. "Today against the goal".' },
        note: { type: 'string', description: 'One-line takeaway shown under the title.' },
        accent: { type: 'string', description: 'Accent color name: blue, orange, teal, red, lilac, green, yellow, pink.' },
        tiles: {
          type: 'array',
          description: 'Stat tiles: { label, value, unit?, color?, accent? } - accent:"dot" shows a colored status dot.',
          maxItems: SPEC_LIMITS.tiles.max,
        },
        bars: {
          type: 'array',
          description: 'Horizontal bars: { label, value, max?, unit?, color? }. With max, a percent bar is drawn.',
          maxItems: SPEC_LIMITS.bars.max,
        },
        timeline: {
          type: 'array',
          description: 'Vertical timeline: { title, detail?, badge?, color? } in order.',
          maxItems: SPEC_LIMITS.timeline.max,
        },
        glossary: {
          type: 'array',
          description: 'Two-column reference rows: { term, pron?, meaning, example?, kind? }.',
          maxItems: SPEC_LIMITS.glossary.max,
        },
      },
    },
    execute: async (args) => {
      const spec = args || {};
      const title = asString(spec.title, '').trim().slice(0, 120);
      const note = asString(spec.note, '').trim().slice(0, 300);
      const html = buildDocument({ ...spec, title, note });

      if (!html) {
        return {
          ok: false,
          isError: true,
          errorCode: 'schema_error',
          text:
            'visual_context needs at least one of: tiles[], bars[], timeline[], glossary[]. ' +
            'Example: { "title": "Today", "tiles": [{ "label": "kcal", "value": "1,850" }], ' +
            '"bars": [{ "label": "Protein", "value": 132, "max": 150, "unit": "g" }] }',
        };
      }

      const header =
        (title ? `<div class="vc-title">${esc(title)}</div>` : '') +
        (note ? `<div class="vc-note">${esc(note)}</div>` : '');

      // Inject the header inside <body>, before the first section.
      const doc = html.replace('<body>', `<body>\n${header}`);

      const size = Buffer.byteLength(doc, 'utf8');
      if (size > 200 * 1024) {
        return { ok: false, isError: true, text: 'Visual payload too large - reduce the number of sections.' };
      }

      const sectionsUsed = [
        asArray(spec.tiles).length ? 'tiles' : null,
        asArray(spec.bars).length ? 'bars' : null,
        asArray(spec.timeline).length ? 'timeline' : null,
        asArray(spec.glossary).length ? 'glossary' : null,
      ].filter(Boolean);

      return {
        ok: true,
        isError: false,
        text:
          `Visual rendered: "${title || 'Visual'}" (${sectionsUsed.join(' + ') || 'no sections'}). ` +
          'The user sees it inline as a visual card. To update it, call the tool again - ' +
          'the previous card stays in history.',
        visual: {
          id: `vc_${Date.now().toString(36)}`,
          html: doc,
          title: title || 'Visual context',
          height: 360,
        },
      };
    },
  });

  // ── teach every session the DSL exists (addon context provider) ──

  $.context.provide('Visual Context addon', [
    '- agent__visual-context_visual_context: render OpenGhost-style visuals inline in chat.',
    '  Sections (pass one or more): tiles [{label,value,unit,color,accent:"dot"}], bars [{label,value,max,unit,color}],',
    '  timeline [{title,detail,badge,color}] (order = top to bottom), glossary [{term,pron,meaning,example,kind}].',
    '  Colors: blue orange teal red lilac green yellow pink. Optional title, note, accent.',
    '  Use it when an answer is mostly structured: nutrition, schedules, routes, vocab, KPIs, plans.',
  ]);

  // ── live re-broadcast over the addon bus (other browsers update via SSE) ──

  on(
    'tool.result',
    { tool: 'agent__visual-context_visual_context' },
    async ($bus, e) => {
      if (e.result && e.result.ok && e.result.visual) {
        await $bus.bus.publish('visual-context:rendered', {
          title: e.result.visual.title,
          visualId: e.result.visual.id,
        });
      }
      return {};
    },
  );

  $.ui.log('visual-context addon ready');
}
