/**
 * lib/llm-adapter-claude.js
 *
 * The Claude adapter: spawns the Claude Code CLI with the prompt on stdin, owns its own
 * deadline and the 80% deadline warning, and turns the exit into a result or a
 * labelled error. tests/llm-runner-prompt-size.test.js and
 * tests/llm-runner-deadline.test.js spawn it for real.
 *
 * Moved unchanged out of lib/llm-runner.js on 2026-10-05 (WORK-TODO #10). lib/llm-runner.js
 * re-exports every name here, so callers are unchanged.
 */

'use strict';

const { spawn } = require('child_process');
const os = require('os');
const { DEFAULT_MAX_TURNS, DEFAULT_TIMEOUT, DEFAULT_CLAUDE_BIN } = require('./llm-defaults');
const { isRateLimitError, RateLimitError, describeClaudeExit, signalFromExitCode } = require('./llm-errors');

// LOGIC CHANGE 2026-10-04 (WORK-TODO #7): when, as a fraction of the timeout, a running
// Claude task triggers its caller's deadline warning.
const WARN_AT_FRACTION = 0.8;

/**
 * Claude adapter - spawns Claude Code CLI with -p flag.
 * Contains all spawn logic previously in bridge-agent.js runClaudeCode function.
 *
 * @param {string} prompt - The prompt to send
 * @param {Object} options - Options for execution
 * @returns {Promise<{ output: string, hitMaxTurns: boolean }>}
 */
function runClaudeAdapter(prompt, options = {}) {
  return new Promise((resolve, reject) => {
    const maxTurns = options.maxTurns || DEFAULT_MAX_TURNS;
    const timeout = options.timeout || DEFAULT_TIMEOUT;
    const cwd = options.cwd || process.cwd();
    const claudeBin = options.claudeBin || DEFAULT_CLAUDE_BIN;

    // LOGIC CHANGE 2026-09-20: The prompt is written to the child's STDIN instead
    // of being passed as the `-p` argv entry. Linux caps a SINGLE argv entry at
    // MAX_ARG_STRLEN (32 * PAGE_SIZE = 131072 bytes) independently of the much
    // larger total argv/environ limit, so a long prompt failed at execve with
    // `spawn E2BIG` before any work was attempted. Measured on this platform: the
    // largest prompt that could exec was 131071 bytes. That ceiling was already
    // being reached in normal use - buildPrompt() embeds the cloned repo's
    // CLAUDE.md verbatim, and this repo's CLAUDE.md is ~127 KB on its own, so an
    // ordinary dispatch sat within ~2.5 KB of a hard exec failure.
    //
    // `claude --print` reads its prompt from stdin when no positional prompt is
    // given (`--input-format text` is the default, and is documented as applying
    // to --print). Stdin was previously 'ignore'; it is now 'pipe'. Stdin is used
    // rather than a temp file deliberately: a prompt can carry sensitive context,
    // and a pipe has no on-disk lifetime, no file mode to get wrong, and no
    // cleanup path that can be missed on a failure branch.
    const args = [
      '-p',
      '--output-format', 'text',
      '--max-turns', String(maxTurns),
      '--dangerously-skip-permissions',
    ];

    const promptText = typeof prompt === 'string' ? prompt : String(prompt ?? '');

    console.log(
      `[llm-runner] Spawning Claude in ${cwd} ` +
      `(max-turns=${maxTurns}, prompt=${Buffer.byteLength(promptText)} bytes via stdin)`
    );

    // LOGIC CHANGE 2026-10-04 (WORK-TODO #58): the deadline is owned here, not by spawn's
    // `timeout` option. Node arms that option's kill-timer at spawn and clears it only on
    // 'exit'; a spawn that fails emits 'error' and never 'exit', so a wrong CLAUDE_BIN
    // (ENOENT) left a referenced timer holding the event loop for the full timeout, ten
    // minutes at the default. Same kill (SIGTERM, which reaches the interrupted path in
    // the close handler), but the timers are unref'd and cleared on 'close' AND 'error'.
    //
    // LOGIC CHANGE 2026-10-04 (WORK-TODO #7): the kill used to arrive with no warning.
    // `options.onDeadlineWarning`, when given, is called once at WARN_AT_FRACTION of the
    // timeout with { elapsedMs, remainingMs, timeoutMs }, so the caller can say so in
    // Slack before the task is killed. The kill itself is unchanged. A throwing callback
    // is logged and cannot affect the task.
    const timers = [];
    const clearTimers = () => { while (timers.length) clearTimeout(timers.pop()); };
    const arm = (ms, fn) => { const t = setTimeout(fn, ms); if (t.unref) t.unref(); timers.push(t); };

    let child;
    try {
      child = spawn(claudeBin, args, {
        cwd,
        env: { ...process.env, HOME: os.homedir() },
        stdio: ['pipe', 'pipe', 'pipe'],
      });
    } catch (err) {
      // LOGIC CHANGE 2026-09-20: spawn() can throw SYNCHRONOUSLY (E2BIG did, which
      // is why the observed failure never reached the 'error' handler below).
      // Normalise it to the same rejection shape as the async failure instead of
      // letting a raw throw escape with a different message.
      reject(new Error(`Spawn failed: ${err.message}`));
      return;
    }

    arm(timeout, () => {
      console.error(`[llm-runner] Claude exceeded its ${timeout}ms deadline; sending SIGTERM`);
      child.kill('SIGTERM');
    });
    if (typeof options.onDeadlineWarning === 'function') {
      const warnAt = Math.floor(timeout * WARN_AT_FRACTION);
      arm(warnAt, () => {
        Promise.resolve()
          .then(() => options.onDeadlineWarning({ elapsedMs: warnAt, remainingMs: timeout - warnAt, timeoutMs: timeout }))
          .catch((err) => console.error(`[llm-runner] Deadline warning callback failed: ${err.message}`));
      });
    }

    // LOGIC CHANGE 2026-09-20: Deliver the prompt over stdin. A child that exits
    // before draining the pipe makes this write fail with EPIPE/ERR_STREAM_*; that
    // is not itself the task's failure - the close handler below reports the real
    // exit cause - so it is logged and swallowed rather than thrown, which would
    // otherwise surface as an unhandled 'error' on the stream and crash the bridge.
    child.stdin.on('error', (err) => {
      console.error(`[llm-runner] Failed writing prompt to Claude stdin: ${err.message}`);
    });
    child.stdin.end(promptText);

    let stdout = '';
    let stderr = '';

    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString();
    });

    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
    });

    // LOGIC CHANGE 2026-09-13: Take the `signal` arg Node passes to close. A
    // signal kill reports code=null + signal set; without capturing signal that
    // information was lost and the interrupted path threw stderr away entirely.
    child.on('close', (code, signal) => {
      clearTimers();
      const output = stdout.trim();
      const trimmedErr = stderr.trim();

      // LOGIC CHANGE 2026-03-26: Detect if output indicates max turns was reached.
      // This allows callers to handle partial completions appropriately.
      const hitMaxTurns = output.includes('Reached max turns');

      // LOGIC CHANGE 2026-03-27: Exit code null means the process was killed
      // (e.g., container restart, SIGTERM). Treat as interrupted, not failed.
      // LOGIC CHANGE 2026-09-13: Carry the signal and any stderr through instead
      // of discarding them, and log what stderr the process managed to emit
      // before dying so an interruption with a real cause is not silent.
      if (code === null) {
        if (trimmedErr) {
          console.error(
            `[llm-runner] Claude killed by ${signal || 'unknown signal'}; stderr before exit:\n` +
            trimmedErr.slice(0, 2000)
          );
        } else {
          console.error(`[llm-runner] Claude killed by ${signal || 'unknown signal'} (no stderr output)`);
        }
        resolve({
          output: output || '',
          hitMaxTurns: false,
          interrupted: true,
          signal: signal || null,
          stderr: trimmedErr,
        });
        return;
      }

      // LOGIC CHANGE 2026-04-01: Check for rate limit errors in stderr to enable
      // Claude → Gemini fallback. This detection only throws RateLimitError,
      // it does NOT pause the entire bot (that behavior was disabled in 2026-03-27).
      if (code !== 0 && isRateLimitError(stderr)) {
        reject(new RateLimitError(`Claude rate limit detected: ${stderr.slice(0, 500)}`));
        return;
      }

      if (code === 0) {
        resolve({ output, hitMaxTurns });
      } else {
        // LOGIC CHANGE 2026-09-13: Surface the real cause. describeClaudeExit keeps
        // the "Exit code N" prefix callers/tests match on, decodes a 128+N code
        // (e.g. 143 -> SIGTERM) and states explicitly when there was no stderr,
        // so a failed task no longer reports a bare, undiagnosable number.
        const err = new Error(describeClaudeExit(code, signal, stderr));
        err.exitCode = code;
        err.signal = signal || signalFromExitCode(code) || null;
        err.stderr = trimmedErr;
        reject(err);
      }
    });

    child.on('error', (err) => {
      clearTimers();
      reject(new Error(`Spawn failed: ${err.message}`));
    });
  });
}

module.exports = {
  WARN_AT_FRACTION,
  runClaudeAdapter,
};
