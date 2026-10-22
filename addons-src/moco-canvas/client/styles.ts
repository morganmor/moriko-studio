/**
 * Moco Canvas — studio panel styles (P0). Injected as a string (RSAT pattern).
 * Addon-owned: every selector is scoped under .mcv. Three themes, zero native title attributes.
 * Full Canvas Workspace: full-height canvas viewport, collapsible bottom readout tray,
 * right inspector dock, and live drag-drop overlays.
 */
export const MCV_CSS = `
.mcv{
  --mcv-canvas: oklch(97.5% 0.008 85);
  --mcv-surface: oklch(99% 0.005 85);
  --mcv-ink: oklch(24% 0.02 60);
  --mcv-muted: oklch(48% 0.02 60);
  --mcv-hairline: oklch(87% 0.01 85);
  --mcv-accent: oklch(52% 0.16 40);
  --mcv-accent-soft: oklch(94% 0.03 40);
  --mcv-crit: oklch(52% 0.18 25);
  --mcv-warn: oklch(62% 0.13 75);
  --mcv-ok: oklch(52% 0.12 155);
  --mcv-display: "Fraunces","Playfair Display",Georgia,serif;
  --mcv-body: "Newsreader",Georgia,serif;
  --mcv-mono: ui-monospace,"Cascadia Code",Consolas,monospace;
  --mcv-s1:4px; --mcv-s2:8px; --mcv-s3:12px; --mcv-s4:16px; --mcv-s5:24px; --mcv-s6:32px; --mcv-s8:48px;

  display:flex; flex-direction:column;
  width:100%; height:100%; overflow:hidden;
  background:var(--mcv-canvas); color:var(--mcv-ink);
  font-family:var(--mcv-mono); font-size:11.5px; line-height:1.5;
}
.dark .mcv{
  --mcv-canvas: oklch(17% 0.008 70);
  --mcv-surface: oklch(21% 0.01 70);
  --mcv-ink: oklch(91% 0.008 70);
  --mcv-muted: oklch(66% 0.01 70);
  --mcv-hairline: oklch(31% 0.012 70);
  --mcv-accent: oklch(76% 0.13 45);
  --mcv-accent-soft: oklch(27% 0.04 45);
  --mcv-crit: oklch(68% 0.17 25);
  --mcv-warn: oklch(78% 0.12 80);
  --mcv-ok: oklch(72% 0.11 155);
}
.mocha .mcv{
  --mcv-canvas: oklch(22% 0.018 45);
  --mcv-surface: oklch(26% 0.02 45);
  --mcv-ink: oklch(92% 0.012 70);
  --mcv-muted: oklch(68% 0.02 55);
  --mcv-hairline: oklch(35% 0.02 45);
  --mcv-accent: oklch(74% 0.13 55);
  --mcv-accent-soft: oklch(31% 0.04 50);
  --mcv-crit: oklch(70% 0.16 28);
  --mcv-warn: oklch(80% 0.11 82);
  --mcv-ok: oklch(74% 0.1 150);
}

.mcv *{box-sizing:border-box}

/* Top Toolbar */
.mcv-topbar{
  display:flex; align-items:center; justify-content:space-between; gap:var(--mcv-s3);
  height:42px; min-height:42px; border-bottom:1px solid var(--mcv-hairline);
  background:var(--mcv-surface); padding:0 var(--mcv-s3); z-index:20; flex-shrink:0;
}
.mcv-brand{display:flex; align-items:baseline; gap:var(--mcv-s2)}
.mcv-title{font-family:var(--mcv-display); font-size:16px; font-weight:600; letter-spacing:-0.01em; margin:0}
.mcv-chip{font-size:10px; letter-spacing:.08em; text-transform:uppercase; color:var(--mcv-muted)}
.mcv-chip b{color:var(--mcv-ink); font-variant-numeric:tabular-nums; font-weight:600}

.mcv-toolbar-group{display:flex; align-items:center; gap:var(--mcv-s1)}
.mcv-seg{
  border:1px solid var(--mcv-hairline); background:transparent; color:var(--mcv-muted);
  font:inherit; font-size:10.5px; padding:3px 9px; cursor:pointer; letter-spacing:.03em;
  transition:all .1s ease;
}
.mcv-seg+.mcv-seg{border-left:0}
.mcv-seg:first-child{border-radius:3px 0 0 3px}
.mcv-seg:last-child{border-radius:0 3px 3px 0}
.mcv-seg[data-on="1"]{background:var(--mcv-accent); border-color:var(--mcv-accent); color:var(--mcv-canvas); font-weight:600}

.mcv-btn{
  border:1px solid var(--mcv-hairline); background:transparent; color:var(--mcv-ink);
  font:inherit; font-size:10.5px; padding:3px 8px; cursor:pointer; border-radius:3px;
  display:inline-flex; align-items:center; gap:4px; transition:all .12s ease;
}
.mcv-btn:hover{border-color:var(--mcv-accent); color:var(--mcv-accent)}
.mcv-btn:disabled{opacity:.4; cursor:not-allowed}
.mcv-btn[data-active="1"]{background:var(--mcv-accent-soft); border-color:var(--mcv-accent); color:var(--mcv-accent)}
.mcv-btn.mcv-btn-accent{background:var(--mcv-accent); border-color:var(--mcv-accent); color:var(--mcv-canvas)}

/* Workspace Stage */
.mcv-workspace{
  flex:1; min-height:0; display:flex; overflow:hidden; position:relative;
}

/* Canvas Area */
.mcv-canvas-area{
  flex:1; min-width:0; height:100%; display:flex; flex-direction:column; overflow:hidden; position:relative;
}

/* Scrollable Canvas Viewport */
.mcv-stage-viewport{
  flex:1; min-height:0; overflow:auto; display:flex; justify-content:center; align-items:flex-start;
  padding:var(--mcv-s5); position:relative;
  background-color:var(--mcv-canvas);
  background-image:radial-gradient(color-mix(in oklch, var(--mcv-ink) 12%, transparent) 1px, transparent 1px);
  background-size:16px 16px;
}

/* Artboard Frame */
.mcv-artboard{
  background:#fff; border-radius:4px;
  box-shadow:0 12px 36px -6px rgba(0,0,0,0.18), 0 0 0 1px var(--mcv-hairline);
  position:relative; flex-shrink:0; transition:width .2s ease;
  width:min(100%, var(--mcv-vp, 1440px));
}
.mcv-artboard[data-vp="sm"]{--mcv-vp:390px}
.mcv-artboard[data-vp="md"]{--mcv-vp:768px}
.mcv-artboard[data-vp="lg"]{--mcv-vp:1440px}

.mcv-artboard iframe{
  display:block; width:100%; height:760px; border:0; background:#fff; margin:0 auto;
}

/* Floating HUD on Canvas */
.mcv-hud{
  position:absolute; bottom:var(--mcv-s3); left:var(--mcv-s3); z-index:15;
  background:var(--mcv-surface); border:1px solid var(--mcv-hairline); border-radius:4px;
  box-shadow:0 6px 20px rgba(0,0,0,0.14); padding:4px 10px;
  display:flex; align-items:center; gap:var(--mcv-s2); font-size:10.5px;
  pointer-events:auto;
}
.mcv-hud-badge{font-weight:600; color:var(--mcv-accent); font-variant-numeric:tabular-nums}
.mcv-hud-info{color:var(--mcv-muted)}

/* Collapsible Bottom Drawer */
.mcv-drawer{
  border-top:1px solid var(--mcv-hairline); background:var(--mcv-surface);
  display:flex; flex-direction:column; z-index:18; flex-shrink:0; transition:height .2s cubic-bezier(.2,0,0,1);
}
.mcv-drawer[data-open="0"]{height:28px}
.mcv-drawer[data-open="1"]{height:220px}

.mcv-drawer-bar{
  height:28px; min-height:28px; display:flex; align-items:center; justify-content:space-between;
  padding:0 var(--mcv-s3); cursor:pointer; user-select:none; font-size:10.5px; color:var(--mcv-muted);
}
.mcv-drawer-bar:hover{color:var(--mcv-ink); background:var(--mcv-accent-soft)}
.mcv-drawer-bar b{color:var(--mcv-ink)}
.mcv-drawer-content{
  flex:1; min-height:0; display:grid; grid-template-columns:1fr 340px; overflow:hidden;
  border-top:1px solid var(--mcv-hairline);
}
.mcv-drawer-map{
  overflow:auto; padding:var(--mcv-s2) var(--mcv-s3); margin:0;
  font-family:var(--mcv-mono); font-size:10px; line-height:1.35; white-space:pre;
  color:var(--mcv-ink); background:var(--mcv-surface);
}
.mcv-drawer-side{
  border-left:1px solid var(--mcv-hairline); overflow-y:auto; padding:var(--mcv-s2) var(--mcv-s3);
  display:flex; flex-direction:column; gap:var(--mcv-s3);
}

/* Right Rail Inspector */
.mcv-rail{
  width:290px; flex-shrink:0; height:100%; border-left:1px solid var(--mcv-hairline);
  background:var(--mcv-surface); overflow-y:auto; display:flex; flex-direction:column;
  gap:var(--mcv-s4); padding:var(--mcv-s3); z-index:16;
}
.mcv-rail[data-open="0"]{display:none}

.mcv-h{
  font-size:10px; letter-spacing:.09em; text-transform:uppercase; color:var(--mcv-muted);
  margin:0 0 var(--mcv-s1) 0; display:flex; justify-content:space-between; align-items:baseline;
}

/* Inspector Box */
.mcv-insp{
  border:1px solid var(--mcv-hairline); border-radius:3px; padding:var(--mcv-s2) var(--mcv-s3);
  display:flex; flex-direction:column; gap:var(--mcv-s2); background:var(--mcv-canvas);
}
.mcv-insp-head{display:flex; justify-content:space-between; align-items:baseline}
.mcv-insp-id{font-weight:600; font-size:11px; color:var(--mcv-ink); overflow:hidden; text-overflow:ellipsis}
.mcv-insp-at{color:var(--mcv-accent); font-variant-numeric:tabular-nums; font-weight:600; font-size:10.5px}
.mcv-insp-row{display:flex; gap:4px; flex-wrap:wrap; align-items:center}
.mcv-insp-label{font-size:9.5px; color:var(--mcv-muted); text-transform:uppercase; letter-spacing:.06em; margin-bottom:2px}

/* Node Tree */
.mcv-tree{list-style:none; margin:0; padding:0; border-top:1px solid var(--mcv-hairline)}
.mcv-tree li{
  display:grid; grid-template-columns:1fr auto; gap:var(--mcv-s2); align-items:baseline;
  padding:4px 4px; border-bottom:1px solid var(--mcv-hairline); cursor:pointer; border-radius:2px;
}
.mcv-tree li:hover{background:var(--mcv-accent-soft)}
.mcv-tree li[data-sel="1"]{background:var(--mcv-accent-soft); box-shadow:inset 2.5px 0 0 var(--mcv-accent)}
.mcv-tree .id{font-size:11px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap}
.mcv-tree .at{font-variant-numeric:tabular-nums; color:var(--mcv-muted); font-size:10.5px}
.mcv-tree .kind{color:var(--mcv-muted); font-size:9.5px; letter-spacing:.06em; text-transform:uppercase; margin-left:4px}

/* Facts & Lint */
.mcv-facts{list-style:none; margin:0; padding:0; display:flex; flex-direction:column; gap:2px}
.mcv-facts li{font-size:10px; white-space:pre-wrap; word-break:break-word}
.mcv-facts li b{color:var(--mcv-muted); font-weight:600}

.mcv-lint{display:flex; flex-direction:column; gap:4px}
.mcv-lint-row{display:grid; grid-template-columns:auto 1fr; gap:var(--mcv-s2); align-items:baseline; font-size:10px}
.mcv-sev{font-size:9px; letter-spacing:.08em; text-transform:uppercase; padding:1px 4px; border-radius:2px; border:1px solid currentColor}
.mcv-sev[data-s="critical"]{color:var(--mcv-crit)}
.mcv-sev[data-s="warn"]{color:var(--mcv-warn)}
.mcv-sev[data-s="info"]{color:var(--mcv-muted)}

/* Op Log */
.mcv-log{list-style:none; margin:0; padding:0; display:flex; flex-direction:column; gap:3px; font-size:10px; color:var(--mcv-muted); font-variant-numeric:tabular-nums}
.mcv-log li::before{content:attr(data-rev) " "; color:var(--mcv-accent); font-weight:600}
.mcv-log li[data-rejected="1"]{color:var(--mcv-crit)}
.mcv-log li[data-rejected="1"]::before{content:attr(data-rev) " ⊘ "; color:var(--mcv-crit)}

.mcv-empty{color:var(--mcv-muted); font-size:10.5px; margin:0}

/* P1: boot / empty state, doc picker, notice toast, log kinds */
.mcv-boot{display:flex; align-items:center; justify-content:center; padding:var(--mcv-s6)}
.mcv-boot-card{
  max-width:420px; width:100%; display:flex; flex-direction:column; gap:var(--mcv-s3);
  border:1px solid var(--mcv-hairline); border-radius:4px; background:var(--mcv-surface); padding:var(--mcv-s4);
}
.mcv-select{
  font:inherit; font-size:10.5px; color:var(--mcv-ink); background:var(--mcv-surface);
  border:1px solid var(--mcv-hairline); border-radius:3px; padding:3px 6px; max-width:190px;
}
.mcv-select:hover{border-color:var(--mcv-accent)}
.mcv-newbar{
  display:flex; align-items:center; gap:var(--mcv-s2); flex-wrap:wrap;
  padding:6px var(--mcv-s3); border-bottom:1px solid var(--mcv-hairline);
  background:var(--mcv-accent-soft); flex-shrink:0;
}
.mcv-newbar-hint{font-size:9.5px; color:var(--mcv-muted)}
.mcv-toast{
  position:absolute; top:var(--mcv-s3); right:var(--mcv-s3); z-index:30; max-width:min(420px, 60%);
  border:1px solid var(--mcv-hairline); border-left:3px solid var(--mcv-ok); border-radius:3px;
  background:var(--mcv-surface); color:var(--mcv-ink); padding:6px 10px; font-size:10.5px;
  box-shadow:0 8px 24px rgba(0,0,0,.16); white-space:pre-wrap;
}
.mcv-toast[data-kind="error"]{border-left-color:var(--mcv-crit); color:var(--mcv-crit)}
.mcv-notice{font-size:10.5px; color:var(--mcv-muted); margin:0}
.mcv-notice[data-kind="error"]{color:var(--mcv-crit)}
.mcv-log-kind{
  font-size:9px; letter-spacing:.06em; text-transform:uppercase; color:var(--mcv-muted);
  border:1px solid var(--mcv-hairline); border-radius:2px; padding:0 3px; margin-right:3px;
}
.mcv-log li[data-actor="user"] .mcv-log-kind{color:var(--mcv-accent); border-color:var(--mcv-accent)}

/* Responsive: the panel adapts to its CONTAINER (right dock vs full page),
   not the window — container queries keep the canvas usable at any width. */
.mcv{container-type:inline-size}
@container (max-width: 1020px){
  .mcv-rail{width:240px}
  .mcv-drawer-content{grid-template-columns:1fr 280px}
}
@container (max-width: 800px){
  .mcv-rail{width:200px}
  .mcv-drawer-content{grid-template-columns:1fr}
  .mcv-drawer-side{display:none}
  .mcv-topbar{height:auto; min-height:42px; flex-wrap:wrap; padding:4px var(--mcv-s3)}
}
@container (max-width: 620px){
  .mcv-rail{position:absolute; right:0; top:0; bottom:0; z-index:22;
    box-shadow:-8px 0 24px rgba(0,0,0,.18); width:230px}
}
`;
