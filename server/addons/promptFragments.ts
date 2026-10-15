/**
 * Prompt fragments (Addon v2, A3/A4) — the per-session successor of the
 * global context providers (A-09). Addons register a fragment builder; the
 * system prompt asks for fragments FOR ONE SESSION, in order, each within a
 * character budget. Empty fragments never render.
 */

export interface PromptFragmentCtx {
  sessionId?: string;
  workspacePath?: string;
}

export interface RegisteredFragment {
  addonId: string;
  id: string;
  order: number;
  budgetChars: number;
  build: (ctx: PromptFragmentCtx) => string[] | Promise<string[]>;
  when?: (ctx: PromptFragmentCtx) => boolean;
}

const fragments = new Map<string, RegisteredFragment>(); // key: addonId\0id

export function registerPromptFragment(fragment: RegisteredFragment): () => void {
  const key = `${fragment.addonId}\u0000${fragment.id}`;
  fragments.set(key, fragment);
  return () => fragments.delete(key);
}

export function listPromptFragments(): RegisteredFragment[] {
  return [...fragments.values()].sort((a, b) => a.order - b.order);
}

export function clearPromptFragmentsFor(addonId: string): void {
  for (const key of [...fragments.keys()]) {
    if (key.startsWith(`${addonId}\u0000`)) fragments.delete(key);
  }
}

export interface BuiltFragment {
  addonId: string;
  id: string;
  lines: string[];
  truncated: boolean;
}

/** Build every applicable fragment for one session, each under its budget. */
export async function buildPromptFragments(ctx: PromptFragmentCtx): Promise<BuiltFragment[]> {
  const out: BuiltFragment[] = [];
  for (const fragment of listPromptFragments()) {
    try {
      if (fragment.when && !fragment.when(ctx)) continue;
      const lines = await fragment.build(ctx);
      const flat: string[] = [];
      let budget = fragment.budgetChars;
      let truncated = false;
      for (const line of lines) {
        if (budget <= 0) {
          truncated = true;
          break;
        }
        if (line.length > budget) {
          flat.push(line.slice(0, budget));
          truncated = true;
          budget = 0;
          break;
        }
        flat.push(line);
        budget -= line.length + 1;
      }
      if (flat.length > 0) out.push({ addonId: fragment.addonId, id: fragment.id, lines: flat, truncated });
    } catch (error) {
      console.error(`[addons] prompt fragment ${fragment.addonId}/${fragment.id} failed:`, error);
    }
  }
  return out;
}
