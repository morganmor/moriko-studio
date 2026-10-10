/**
 * Side-effect import list: every tool module that calls defineTool() must be
 * imported here ONCE so the registry is populated before listAgentToolDefs()
 * or the dispatcher run. (F0)
 */
// F2
import './read-symbol.js';
import './context-pack.js';
// F3
import './diagnostics.js';
import './lint.js';
import './format.js';
import './refactor.js';
import './metrics.js';
import './dead-code.js';
import './review-diff.js';
import './verify.js';
// F4
import './arch-map.js';
import './arch-rules.js';
import './adr.js';
import './scaffold.js';
// F5
import './game-probe.js';
import './shader-check.js';
import './asset-inspect.js';
export {};
