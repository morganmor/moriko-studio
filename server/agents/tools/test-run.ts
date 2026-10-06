/**
 * agent__test_run — structured test runner wrapper.
 *
 * Runs test files via node --import tsx --test and parses the TAP output
 * into per-file pass/fail counts. For failures, extracts the failing test
 * names and error messages. Requires terminal mode enabled.
 */
import { statSync, existsSync } from 'node:fs';
import path from 'node:path';
import type { HarnessToolResult, AgentToolContext } from './shared.js';
import { str, num, truncateOutput, globToRegExp, requireWorkspace, resolveWithPermission } from './shared.js';
import { runProcess } from '../exec.js';
import { auditToolCall } from '../audit.js';
import { walkFiles } from './list.js';

interface TestFileResult {
  file: string;
  tests: number;
  pass: number;
  fail: number;
  output: string;
}

function parseTapCounts(text: string): { tests: number; pass: number; fail: number } {
  const testsMatch = text.match(/^# tests (\d+)/m);
  const passMatch = text.match(/^# pass (\d+)/m);
  const failMatch = text.match(/^# fail (\d+)/m);
  return {
    tests: testsMatch ? Number(testsMatch[1]) : 0,
    pass: passMatch ? Number(passMatch[1]) : 0,
    fail: failMatch ? Number(failMatch[1]) : 0,
  };
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

  let testFiles: string[] = [];
  const explicitFiles = Array.isArray(args.files)
    ? args.files.filter((f): f is string => typeof f === 'string' && f.trim().length > 0)
    : [];

  if (explicitFiles.length > 0) {
    testFiles = explicitFiles;
  } else {
    const pattern = str(args, 'pattern').trim() || '**/*.test.ts';
    const globRe = globToRegExp(pattern);
    const walk = walkFiles(resolved.absolute);
    testFiles = walk.files.filter((f) => globRe.test(f));
  }

  if (testFiles.length === 0) {
    return { ok: true, isError: false, text: 'No test files found. Use "files" to specify test file paths.' };
  }

  const timeoutSec = Math.min(Math.max(num(args, 'timeoutSec') ?? 120, 10), 600);

  const results: TestFileResult[] = [];
  let totalTests = 0;
  let totalFail = 0;

  for (const file of testFiles) {
    const filePath = path.isAbsolute(file) ? file : path.join(resolved.absolute, file.split('/').join(path.sep));
    if (!existsSync(filePath)) {
      results.push({ file, tests: 0, pass: 0, fail: 0, output: 'FILE NOT FOUND' });
      continue;
    }

    const outcome = await runProcess('node', ['--import', 'tsx', '--test', filePath], {
      cwd: resolved.absolute,
      timeoutMs: timeoutSec * 1000,
      signal: ctx.signal,
      sandbox: { workspaceRoot: root, policy: 'workspace-write' as const },
    });

    const fullText = `${outcome.stdout}\n${outcome.stderr}`;
    const counts = parseTapCounts(fullText);
    totalTests += counts.tests;
    totalFail += counts.fail;

    results.push({
      file,
      tests: counts.tests,
      pass: counts.tests - counts.fail,
      fail: counts.fail,
      output: outcome.timedOut ? `[timed out after ${timeoutSec}s]` : outcome.exitCode !== 0 ? fullText.slice(0, 4000) : '',
    });

    auditToolCall({
      session: ctx.sessionId ?? 'default',
      tool: 'test_run',
      ok: counts.fail === 0,
      durationMs: outcome.durationMs,
      args: `${file} · ${counts.tests} tests, ${counts.fail} fail`,
    });
  }

  const lines: string[] = [];
  lines.push(`${totalFail === 0 ? 'PASS' : 'FAIL'}  ${totalTests} tests, ${totalFail} failed across ${testFiles.length} file(s)`);
  lines.push('');

  for (const r of results) {
    const status = r.fail === 0 ? 'PASS' : 'FAIL';
    lines.push(`${status}  ${r.file}  (${r.tests} tests, ${r.fail} fail)`);
    if (r.fail > 0 && r.output) {
      const failures = parseTapFailures(r.output);
      for (const f of failures.slice(0, 5)) {
        lines.push(`    FAIL: ${f.name}`);
        if (f.message) {
          const msg = f.message.split('\n').slice(0, 3).join('\n      ');
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