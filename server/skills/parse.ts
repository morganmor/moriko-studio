/**
 * SKILL.md parser — the open Agent Skills spec (agentskills.io): a skill is a
 * folder whose SKILL.md starts with YAML frontmatter (`name` + `description`
 * required) followed by Markdown instructions. This parser is deliberately
 * minimal: it covers the spec's field set (flat scalars, one nested `metadata`
 * map, `|`/`>` block scalars) without pulling in a YAML dependency.
 */

export interface SkillFrontmatter {
  /** Spec: 1-64 chars, lowercase alnum + hyphens, no leading/trailing/double hyphen. */
  name: string;
  /** Spec: 1-1024 chars — what the skill does + when to use it. */
  description: string;
  license?: string;
  compatibility?: string;
  /** Experimental space-separated pre-approved tool list, kept verbatim. */
  allowedTools?: string;
  metadata?: Record<string, string>;
}

export interface ParsedSkill {
  frontmatter: SkillFrontmatter | null;
  /** Markdown body AFTER the frontmatter (what the agent actually follows). */
  body: string;
  valid: boolean;
  problem?: string;
}

/** Spec name rule: lowercase alnum segments joined by single hyphens. */
const NAME_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/** Parses one `key: value` line; returns null for blank/comment lines. */
function scalarLine(line: string): { key: string; value: string; indent: number } | null {
  if (!line.trim() || line.trim().startsWith('#')) return null;
  const match = /^(\s*)([A-Za-z][\w-]*)\s*:\s*([\s\S]*)$/.exec(line);
  if (!match) return null;
  return { key: match[2], indent: match[1].length, value: match[3].trim() };
}

/**
 * Collects a block scalar (`|`, `|-`, `>`, `>-`) — the indented lines that
 * follow. Joined with newlines for `|`, spaces for `>`.
 */
function collectBlock(lines: string[], from: number, folded: boolean): { text: string; next: number } {
  const collected: string[] = [];
  let i = from;
  while (i < lines.length) {
    const line = lines[i];
    if (line.trim() === '') {
      collected.push('');
      i += 1;
      continue;
    }
    if (!/^\s/.test(line)) break;
    collected.push(line.trim());
    i += 1;
  }
  while (collected.length > 0 && collected[collected.length - 1] === '') collected.pop();
  return { text: folded ? collected.join(' ') : collected.join('\n'), next: i };
}

export function parseSkillMd(raw: string): ParsedSkill {
  const text = raw.replace(/\r\n/g, '\n');
  if (!text.startsWith('---')) {
    return { frontmatter: null, body: text.trim(), valid: false, problem: 'missing YAML frontmatter' };
  }
  const lines = text.split('\n');
  let close = -1;
  for (let i = 1; i < lines.length; i += 1) {
    if (lines[i].trim() === '---') {
      close = i;
      break;
    }
  }
  if (close < 0) {
    return { frontmatter: null, body: text.trim(), valid: false, problem: 'unterminated YAML frontmatter' };
  }

  const fmLines = lines.slice(1, close);
  const values: Record<string, string> = {};
  const metadata: Record<string, string> = {};
  for (let i = 0; i < fmLines.length; i += 1) {
    const line = scalarLine(fmLines[i]);
    if (!line) continue;
    if ((line.value === '|' || line.value === '|-' || line.value === '>' || line.value === '>-') && line.indent === 0) {
      const block = collectBlock(fmLines, i + 1, line.value.startsWith('>'));
      i = block.next - 1;
      if (line.key === 'metadata') continue; // block metadata is not supported — ignore
      values[line.key] = block.text;
      continue;
    }
    if (line.indent > 0 && metadata.__open) {
      metadata[line.key] = line.value;
      continue;
    }
    if (line.indent === 0) {
      if (line.key === 'metadata') {
        metadata.__open = '1';
        continue;
      }
      metadata.__open = '';
      values[line.key] = line.value;
    }
  }

  const name = values.name ?? '';
  const description = values.description ?? '';
  const frontmatter: SkillFrontmatter = {
    name,
    description,
    ...(values.license ? { license: values.license } : {}),
    ...(values.compatibility ? { compatibility: values.compatibility } : {}),
    ...(values['allowed-tools'] ? { allowedTools: values['allowed-tools'] } : {}),
  };
  const entries = Object.entries(metadata).filter(([key]) => key !== '__open');
  if (entries.length > 0) frontmatter.metadata = Object.fromEntries(entries);

  let problem: string | undefined;
  if (!NAME_RE.test(name)) problem = `"${name || '(empty)'}" is not a valid skill name (spec: lowercase alnum + hyphens)`;
  else if (name.length > 64) problem = 'name exceeds 64 characters';
  else if (!description.trim()) problem = 'missing description';
  else if (description.length > 1024) problem = 'description exceeds 1024 characters';

  return {
    frontmatter,
    body: lines.slice(close + 1).join('\n').trim(),
    valid: !problem,
    problem,
  };
}
