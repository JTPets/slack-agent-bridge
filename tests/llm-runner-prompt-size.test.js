/**
 * Regression test for the 2026-09-20 `spawn E2BIG` dispatch failure.
 *
 * THE DEFECT: runClaudeAdapter passed the assembled prompt as the `-p` argv
 * entry. Linux caps a SINGLE argv entry at MAX_ARG_STRLEN (32 * PAGE_SIZE =
 * 131072 bytes) independently of the much larger total argv/environ limit, so a
 * long prompt failed at execve with E2BIG in ~2 seconds, before any work was
 * attempted. That ceiling was already being reached in ordinary use:
 * code-review-pipeline.buildPrompt() embeds the cloned repo's CLAUDE.md verbatim
 * and this repo's CLAUDE.md is ~127 KB on its own.
 *
 * WHY THIS TEST SPAWNS FOR REAL. E2BIG is raised by execve, so it cannot be
 * produced by a mocked child_process - a mock will happily "pass" an argv entry
 * of any size. Every other suite in this repo mocks spawn, which is exactly why
 * none of them caught this. These tests run against a real stub binary.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

// The measured limit on this platform. Asserted, not assumed - see
// 'the platform limit this fix exists for is real' below.
const MAX_ARG_STRLEN = 32 * 4096; // 131072

let tmpDir;
let stubBin;

beforeAll(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'llm-runner-size-'));
  stubBin = path.join(tmpDir, 'claude-stub');
  // A stand-in for the claude CLI: ignores its argv, drains stdin, reports the
  // byte count it actually received. That count is the proof the whole prompt
  // was delivered, not merely that exec succeeded.
  fs.writeFileSync(
    stubBin,
    `#!${process.execPath}\n` +
    `let n = 0;\n` +
    `process.stdin.on('data', (c) => { n += c.length; });\n` +
    `process.stdin.on('end', () => { process.stdout.write('BYTES:' + n); });\n`,
    { mode: 0o755 }
  );
});

afterAll(() => {
  if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
});

/** Spawn with the prompt as a single argv entry - the shape that used to ship. */
function spawnWithPromptInArgv(byteLength) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(stubBin, ['-p', 'x'.repeat(byteLength), '--output-format', 'text'],
        { stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (err) {
      // E2BIG arrives as a SYNCHRONOUS throw, never on the 'error' event. That
      // is why the production failure bypassed the adapter's error handler.
      return resolve({ ok: false, code: err.code, synchronous: true });
    }
    child.on('error', (err) => resolve({ ok: false, code: err.code, synchronous: false }));
    child.on('close', () => resolve({ ok: true }));
  });
}

describe('the platform limit this fix exists for is real', () => {
  test('a single argv entry at MAX_ARG_STRLEN fails with a synchronous E2BIG', async () => {
    const result = await spawnWithPromptInArgv(MAX_ARG_STRLEN);
    expect(result.ok).toBe(false);
    expect(result.code).toBe('E2BIG');
    // The throw is synchronous - a child.on('error') handler never sees it.
    expect(result.synchronous).toBe(true);
  });

  test('one byte under the limit still execs, so the boundary is exactly where claimed', async () => {
    const result = await spawnWithPromptInArgv(MAX_ARG_STRLEN - 1);
    expect(result.ok).toBe(true);
  });
});

describe('runClaudeAdapter delivers a prompt larger than MAX_ARG_STRLEN', () => {
  // Each of these RED without the fix: they throw `spawn E2BIG` at exec.

  test('the exact size that failed in production now runs end to end', async () => {
    const { runClaudeAdapter } = require('../lib/llm-runner');
    const prompt = 'x'.repeat(MAX_ARG_STRLEN); // 131072 - the first failing size
    const result = await runClaudeAdapter(prompt, { claudeBin: stubBin, cwd: tmpDir });
    expect(result.output).toBe(`BYTES:${MAX_ARG_STRLEN}`);
  });

  test('a prompt an order of magnitude larger runs, with every byte delivered', async () => {
    const { runClaudeAdapter } = require('../lib/llm-runner');
    const size = MAX_ARG_STRLEN * 10; // 1310720 bytes = 1.25 MiB
    const result = await runClaudeAdapter('y'.repeat(size), { claudeBin: stubBin, cwd: tmpDir });
    expect(result.output).toBe(`BYTES:${size}`);
  });

  test('a realistic assembled prompt - this repo CLAUDE.md verbatim - runs', async () => {
    const { runClaudeAdapter } = require('../lib/llm-runner');
    // The real trigger: buildPrompt() embeds the cloned repo's CLAUDE.md in full.
    const claudeMd = fs.readFileSync(path.join(__dirname, '..', 'CLAUDE.md'), 'utf8');
    const commandments = fs.readFileSync(path.join(__dirname, '..', 'COMMANDMENTS.md'), 'utf8');
    const prompt = `# COMMANDMENTS\n${commandments}\n\n# PROJECT RULES (CLAUDE.md)\n${claudeMd}\n\n# TASK\nfix a typo`;
    // Guard the premise: if CLAUDE.md ever shrinks well below the limit this test
    // stops proving anything, and should be told so rather than passing quietly.
    expect(Buffer.byteLength(claudeMd)).toBeGreaterThan(100 * 1024);
    const result = await runClaudeAdapter(prompt, { claudeBin: stubBin, cwd: tmpDir });
    expect(result.output).toBe(`BYTES:${Buffer.byteLength(prompt)}`);
  });

  test('a small prompt is unaffected - the ordinary path still works', async () => {
    const { runClaudeAdapter } = require('../lib/llm-runner');
    const result = await runClaudeAdapter('hello', { claudeBin: stubBin, cwd: tmpDir });
    expect(result.output).toBe('BYTES:5');
  });

  test('the prompt is not in argv at all any more', async () => {
    // A stub that reports its argv rather than its stdin.
    const argvStub = path.join(tmpDir, 'argv-stub');
    fs.writeFileSync(
      argvStub,
      `#!${process.execPath}\n` +
      `process.stdin.resume();\n` +
      `process.stdin.on('end', () => process.stdout.write(JSON.stringify(process.argv.slice(2))));\n`,
      { mode: 0o755 }
    );
    const { runClaudeAdapter } = require('../lib/llm-runner');
    const result = await runClaudeAdapter('SENTINEL-PROMPT-TEXT', { claudeBin: argvStub, cwd: tmpDir });
    expect(result.output).not.toContain('SENTINEL-PROMPT-TEXT');
    expect(JSON.parse(result.output)).toEqual([
      '-p', '--output-format', 'text', '--max-turns', '50', '--dangerously-skip-permissions',
    ]);
  });
});

describe('a spawn failure is still reported, not swallowed', () => {
  test('a missing binary rejects with a Spawn failed message', async () => {
    const { runClaudeAdapter } = require('../lib/llm-runner');
    // NOTE on the explicit short `timeout`: it is not about this assertion, which
    // rejects in single-digit milliseconds. Node arms the spawn `timeout` option's
    // internal kill-timer at spawn and only clears it on 'exit'; a spawn that fails
    // with 'error' (ENOENT here) never clears it, so the event loop stays alive for
    // the full timeout - 10 minutes at this adapter's default. That behaviour is
    // PRE-EXISTING (reproduced against origin/main, unrelated to the stdin change)
    // and is filed as WORK-TODO #58. Without this override the suite would hang.
    await expect(
      runClaudeAdapter('prompt', {
        claudeBin: path.join(tmpDir, 'does-not-exist'),
        cwd: tmpDir,
        timeout: 500,
      })
    ).rejects.toThrow(/Spawn failed/);
  });
});
