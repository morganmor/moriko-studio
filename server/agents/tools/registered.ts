/**
 * Side-effect import list: every tool module that calls defineTool() must be
 * imported here ONCE so the registry is populated before listAgentToolDefs()
 * or the dispatcher run. (F0)
 */
import './read-symbol.js';
import './context-pack.js';
import './diagnostics.js';
import './lint.js';
import './format.js';
import './refactor.js';
import './metrics.js';
import './dead-code.js';
import './review-diff.js';
import './verify.js';
import './arch-map.js';
import './arch-rules.js';
import './adr.js';
import './scaffold.js';
import './game-probe.js';
import './shader-check.js';
import './asset-inspect.js';
import './sub-agent.js';
export {};
