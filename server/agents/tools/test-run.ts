/**
 * agent__test_run — structured multi-runner test wrapper.
 *
 * F1.5: detects the project's test runner (vitest / jest / pytest / cargo / go)
 * from package.json scripts + devDeps and config files, falling back to
 * `node --import tsx --test`. Output is normalized to PASS/FAIL/SKIP counts
 * with per-failure names + messages. Requires terminal mode enabled.
 */
import { statSync, existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import type { HarnessToolResult, AgentToolContext } from './shared.js';
import { str, num, truncateOutput, globToRegExp, requireWorkspace, resolveWithPermission } from './shared.js';
import { runProcess } from '../exec.js';
import { auditToolCall } from '../audit.js';
import { walkFiles } from './list.js';

type RunnerKind = 'node' | 'vitest' | 'jest' | 'pytest' | 'cargo' | 'go';

interface TestFileResult {
  file: string;
  tests: number;
  pass: number;
  fail: number;
  skip: number;
  output: string;
}

function parseTapCounts(text: string): { tests: number; pass: number; fail: number; skip: number } {
  const n = (re: RegExp): number => {
    const m = text.match(re);
    return m ? Number(m[1]) : 0;
  };
  const tests = n(/^# tests (\d+)/m);
  const fail = n(/^# fail (\d+)/m);
  const skipped = n(/^# skipped (\d+)/m) + n(/^# skip (\d+)/m);
  const todo = n(/^# todo (\d+)/m);
  const cancelled = n(/^# cancelled (\d+)/m);
  return { tests, pass: Math.max(tests - fail - skipped - todo - cancelled, 0), fail, skip: skipped + todo + cancelled };
}

function parseTapFailures(text: string): Array<{ name: string; message: string }> {
  const failures: Array<{ name: string; message: string }> = [];
  const lines = text.split('\n');
  let currentName = '';
  let currentMessage: string[] = [];
  let inNotOk = false;
  let inYaml = false;

  for (const line of lines) {
    if (/^not ok \d+ - /.test(line)) {
      if (inNotOk && currentName) {
        failures.push({ name: currentName, message: currentMessage.join('\n').trim() });
      }
      inNotOk = true;
      inYaml = false;
      currentName = line.replace(/^not ok \d+ - /, '').trim();
      currentMessage = [];
    } else if (inNotOk && line.trim() === '---') {
      inYaml = true;
    } else if (inNotOk && line.trim() === '...') {
      inYaml = false;
    } else if (inNotOk && inYaml) {
      currentMessage.push(line);
    } else if (inNotOk && line.trim() === '' && currentName) {
      if (currentMessage.length > 0) {
        failures.push({ name: currentName, message: currentMessage.join('\n').trim() });
      }
      inNotOk = false;
      currentName = '';
      currentMessage = [];
    }
  }
  if (inNotOk && currentName) {
    failures.push({ name: currentName, message: currentMessage.join('\n').trim() });
  }
  return failures;
}

/** Jest/vitest JSON reporter → normalized failures. */
function parseJsonRunnerOutput(text: string): { tests: number; pass: number; fail: number; skip: number; output: string } {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start < 0 || end <= start) return { tests: 0, pass: 0, fail: 0, skip: 0, output: text.slice(0, 2000) };
  try {
    const json = JSON.parse(text.slice(start, end + 1)) as {
      numTotalTests?: number; numPassedTests?: number; numFailedTests?: number;
      numPendingTests?: number; testResults?: Array<{
        name: string; status: string; assertionResults?: Array<{ title: string; status: string; failureMessages?: string[] }>;
      }>;
    };
    let fail = 0;
    let skip = 0;
    const failureLines: string[] = [];
    for (const suite of json.testResults ?? []) {
      for (const t of suite.assertionResults ?? []) {
        if (t.status === 'failed') {
          fail += 1;
          failureLines.push(`not ok - ${suite.name.replace(/\\/g, '/')} › ${t.title}`);
          for (const msg of t.failureMessages ?? []) failureLines.push(`  ${msg.split('\n').slice(0, 4).join('\n  ')}`);
        } else if (t.status === 'pending' || t.status === 'skipped' || t.status === 'todo') skip += 1;
      }
    }
    const tests = json.numTotalTests ?? 0;
    return {
      tests,
      pass: Math.max(tests - fail - skip, 0),
      fail,
      skip,
      output: failureLines.join('\n').slice(0, 6000),
    };
  } catch {
    return { tests: 0, pass: 0, fail: 0, skip: 0, output: text.slice(0, 2000) };
  }
}

/** Pytest `-q -rA` summary. */
function parsePytestOutput(text: string): { tests: number; pass: number; fail: number; skip: number; output: string } {
  const summary = text.match(/(\d+) passed(?:, (\d+) failed)?(?:, (\d+) skipped)?/);
  const tests = summary ? Number(summary[1]) + (summary[2] ? Number(summary[2]) : 0) + (summary[3] ? Number(summary[3]) : 0) : 0;
  const fail = summary?.[2] ? Number(summary[2]) : 0;
  const skip = summary?.[3] ? Number(summary[3]) : 0;
  const failedLines = text.split('\n').filter((l) => /^FAILED /.test(l)).slice(0, 20);
  return { tests, pass: Number(summary?.[1] ?? 0), fail, skip, output: failedLines.join('\n') };
}

/** F1.5 — runner detection: explicit arg → package.json → config files. */
function detectRunner(args: Record<string, unknown>, cwd: string): RunnerKind {
  const explicit = str(args, 'runner').trim().toLowerCase();
  if (explicit === 'vitest' || explicit === 'jest' || explicit === 'pytest' || explicit === 'cargo' || explicit === 'go' || explicit === 'node') {
    return explicit;
  }
  try {
    const pkg = JSON.parse(readFileSync(path.join(cwd, 'package.json'), 'utf8')) as {
      scripts?: Record<string, string>;
      devDependencies?: Record<string, string>;
      dependencies?: Record<string, string>;
    };
    const allDeps = { ...(pkg.dependencies ?? {}), ...(pkg.devDependencies ?? {}) };
    if (allDeps['vitest']) return 'vitest';
    if (allDeps['jest']) return 'jest';
    const testScript = pkg.scripts?.test ?? '';
    if (testScript.includes('vitest')) return 'vitest';
    if (testScript.includes('jest')) return 'jest';
  } catch {  }
  if (existsSync(path.join(cwd, 'pytest.ini')) || existsSync(path.join(cwd, 'pyproject.toml'))) return 'pytest';
  if (existsSync(path.join(cwd, 'Cargo.toml'))) return 'cargo';
  if (existsSync(path.join(cwd, 'go.mod'))) return 'go';
  return 'node';
}

function runnerCommand(runner: RunnerKind, target: string | string[], cwd: string): { program: string; args: string[] } {
  switch (runner) {
    case 'vitest':
      return { program: 'npx.cmd', args: ['vitest', 'run', '--reporter=json', ...(Array.isArray(target) ? target : [target])] };
    case 'jest':
      return { program: 'npx.cmd', args: ['jest', '--json', ...(Array.isArray(target) ? target : [target])] };
    case 'pytest':
      return { program: 'python', args: ['-m', 'pytest', '-q', '-rA', ...(Array.isArray(target) ? target : [target])] };
    case 'cargo':
      return { program: 'cargo', args: ['test'] };
    case 'go':
      return { program: 'go', args: ['test', './...'] };
    default: {
      void cwd;
      return { program: 'node', args: ['--import', 'tsx', '--test', ...(Array.isArray(target) ? target : [target])] };
    }
  }
}

export async function testRunTool(args: Record<string, unknown>, ctx: AgentToolContext): Promise<HarnessToolResult> {
  const mode = ctx.terminalMode ?? 'auto';
  if (mode === 'off') {
    return {
      ok: false,
      isError: true,
      text:
        'Terminal execution is turned OFF in the harness settings. Ask the user to enable it ' +
        '(Tools → Terminal: Ask or Auto) if running tests is needed for the task.',
    };
  }

  const { root } = requireWorkspace(ctx);
  const cwdRaw = str(args, 'cwd').trim() || '.';
  const resolved = await resolveWithPermission('test_run', cwdRaw, ctx);
  if (!statSync(resolved.absolute).isDirectory()) {
    return { ok: false, isError: true, text: `cwd "${resolved.relative}" is not a directory.` };
  }

  const runner = detectRunner(args, resolved.absolute);
  const explicitFiles = Array.isArray(args.files)
    ? args.files.filter((f): f is string => typeof f === 'string' && f.trim().length > 0)
    : [];

  let testFiles: string[] = [];
  if (runner === 'cargo' || runner === 'go') {
    testFiles = [];
  } else if (explicitFiles.length > 0) {
    testFiles = explicitFiles;
  } else if (runner === 'pytest') {
    const pattern = str(args, 'pattern').trim() || '**/test_*.py';
    const globRe = globToRegExp(pattern);
    testFiles = walkFiles(resolved.absolute).files.filter((f) => globRe.test(f));
    if (testFiles.length === 0) {
      testFiles = walkFiles(resolved.absolute).files.filter((f) => globToRegExp('**/*_test.py').test(f));
    }
  } else {
    const pattern = str(args, 'pattern').trim() || '**/*.test.ts';
    const globRe = globToRegExp(pattern);
    testFiles = walkFiles(resolved.absolute).files.filter((f) => globRe.test(f));
  }

  if (runner === 'node' && testFiles.length === 0) {
    return { ok: true, isError: false, text: 'No test files found. Use "files" to specify test file paths.' };
  }

  const timeoutSec = Math.min(Math.max(num(args, 'timeoutSec') ?? 120, 10), 600);

  const results: TestFileResult[] = [];
  let totalTests = 0;
  let totalFail = 0;
  let totalSkip = 0;

  const runOne = async (target: string | string[], label: string): Promise<void> => {
    const cmd = runnerCommand(runner, target, resolved.absolute);
    const outcome = await runProcess(cmd.program, cmd.args, {
      cwd: resolved.absolute,
      timeoutMs: timeoutSec * 1000,
      signal: ctx.signal,
      sandbox: { workspaceRoot: root, policy: 'workspace-write' as const },
    });
    const fullText = `${outcome.stdout}\n${outcome.stderr}`;
    let counts: { tests: number; pass: number; fail: number; skip: number; output: string };
    if (runner === 'vitest' || runner === 'jest') {
      counts = parseJsonRunnerOutput(fullText);
    } else if (runner === 'pytest') {
      counts = parsePytestOutput(fullText);
    } else {
      const c = parseTapCounts(fullText);
      counts = { ...c, output: outcome.timedOut ? `[timed out after ${timeoutSec}s]` : outcome.exitCode !== 0 ? fullText.slice(0, 4000) : '' };
    }
    totalTests += counts.tests;
    totalFail += counts.fail;
    totalSkip += counts.skip;
    results.push({
      file: label,
      tests: counts.tests,
      pass: counts.pass,
      fail: counts.fail,
      skip: counts.skip,
      output: counts.output,
    });
    auditToolCall({
      session: ctx.sessionId ?? 'default',
      tool: 'test_run',
      ok: counts.fail === 0,
      durationMs: outcome.durationMs,
      args: `${label} · ${counts.tests} tests, ${counts.fail} fail`,
    });
  };

  if (runner === 'cargo' || runner === 'go' || runner === 'vitest' || runner === 'jest') {
    const label = runner === 'cargo' ? 'cargo test' : runner === 'go' ? 'go test ./...' : (testFiles.length > 0 ? testFiles.join(' ') : 'project');
    await runOne(testFiles.length > 0 ? testFiles : [], label);
  } else {
    for (const file of testFiles) {
      const filePath = path.isAbsolute(file) ? file : path.join(resolved.absolute, file.split('/').join(path.sep));
      if (!existsSync(filePath)) {
        results.push({ file, tests: 0, pass: 0, fail: 0, skip: 0, output: 'FILE NOT FOUND' });
        continue;
      }
      await runOne(filePath, file);
    }
  }

  const lines: string[] = [];
  lines.push(`runner: ${runner}`);
  lines.push(`${totalFail === 0 ? 'PASS' : 'FAIL'}  ${totalTests} tests · PASS ${totalTests - totalFail - totalSkip} · FAIL ${totalFail} · SKIP ${totalSkip} across ${results.length} run(s)`);
  lines.push('');

  for (const r of results) {
    const status = r.fail === 0 ? 'PASS' : 'FAIL';
    lines.push(`${status}  ${r.file}  (${r.tests} tests, ${r.fail} fail${r.skip > 0 ? `, ${r.skip} skip` : ''})`);
    if (r.fail > 0 && r.output) {
      const failures = runner === 'node' || runner === 'pytest'
        ? parseTapFailures(r.output).map((f) => ({ name: f.name, message: f.message }))
        : r.output.split('\n').filter((l) => l.startsWith('not ok - ') || l.startsWith('FAILED ')).map((l) => ({ name: l, message: '' }));
      for (const f of failures.slice(0, 5)) {
        lines.push(`    FAIL: ${f.name}`);
        if (f.message) {
          const msg = f.message.split('\n').slice(0, 8).join('\n      ');
          lines.push(`      ${msg}`);
        }
      }
      if (failures.length > 5) {
        lines.push(`    ... and ${failures.length - 5} more failure(s)`);
      }
    }
  }

  return {
    ok: totalFail === 0,
    isError: totalFail > 0,
    text: truncateOutput(lines.join('\n')),
  };
}
