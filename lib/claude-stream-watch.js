/**
 * lib/claude-stream-watch.js
 *
 * Reads the Claude CLI's `--output-format stream-json` events as they arrive and decides
 * when a run has stopped making progress. Built for WORK-TODO #59: the turn cap was the
 * only brake on a run that never finishes, and a turn count measures neither time nor
 * tokens. This watches the run itself.
 *
 * REPORT FIRST (owner, 2026-10-10): tasks have legitimately run over an hour, so nothing
 * is cut off until real runs show where the thresholds belong. The adapter decides what an
 * alert does (lib/llm-adapter-claude.js, TASK_LIMITER_MODE); by default it only reports.
 * Every run also ends with stats (longest quiet gap, longest repeat, turns, cost) so the
 * thresholds can be set from data.
 *
 * Two rules, both reported with a reason a person can act on:
 *   - stall: no event at all for `stallMs`. A run that is thinking or running a tool
 *     still emits events between steps; silence this long is a hung step.
 *   - loop: the same tool call (same tool, same input) `loopRepeat` times in a row. The
 *     run is repeating itself and will not finish on its own.
 *
 * It also extracts what the adapter needs from the stream: the final result text, whether
 * the run ended at its turn limit, and the CLI's own error message. Output that is not
 * stream-json (an older CLI, or a test stub) is passed through as plain text, so nothing
 * that worked before depends on the new format.
 *
 * Pure apart from the one timer it owns (unref'd, cleared by dispose). It never kills
 * anything: it calls `onAlert(reason, detail)` and the adapter decides. A stall alert
 * fires once per quiet spell, a loop alert once per run of identical calls.
 */

'use strict';

/**
 * @param {object} opts
 * @param {number} opts.stallMs - Stop after this long with no event. 0 disables.
 * @param {number} opts.loopRepeat - Stop after this many identical tool calls in a row. 0 disables.
 * @param {(reason: 'stall'|'loop', detail: string) => void} opts.onAlert
 * @param {() => number} [opts.now] - Clock, for tests.
 */
function createStreamWatch({ stallMs, loopRepeat, onAlert, now = Date.now }) {
  let buffer = '';
  let raw = '';
  let sawEvent = false;
  let resultEvent = null;
  const texts = [];
  let lastSignature = null;
  let repeatCount = 0;
  let loopAlerted = false;
  let disposed = false;
  const startedAt = now();
  let lastActivity = startedAt;
  let timer = null;
  const stats = { events: 0, toolCalls: 0, maxQuietMs: 0, maxRepeat: 0, alerts: [] };

  const alert = (reason, detail) => {
    stats.alerts.push(reason);
    try { onAlert(reason, detail); } catch (err) { console.error(`[claude-stream-watch] alert handler threw: ${err.message}`); }
  };

  const markActivity = () => {
    const t = now();
    stats.maxQuietMs = Math.max(stats.maxQuietMs, t - lastActivity);
    lastActivity = t;
    armStallTimer();
  };

  function clearStallTimer() {
    if (timer) clearTimeout(timer);
    timer = null;
  }

  function armStallTimer() {
    clearStallTimer();
    if (!stallMs || disposed) return;
    timer = setTimeout(() => {
      timer = null;
      const quietMs = now() - lastActivity;
      alert('stall', `no output from the run for ${Math.round(quietMs / 60000)} min (threshold ${Math.round(stallMs / 60000)} min, TASK_STALL_MS)`);
    }, stallMs);
    if (timer.unref) timer.unref();
  }

  function onToolUse(block) {
    let input;
    try { input = JSON.stringify(block.input ?? null); } catch { input = String(block.input); }
    stats.toolCalls += 1;
    const signature = `${block.name}:${input}`;
    if (signature === lastSignature) {
      repeatCount += 1;
    } else {
      lastSignature = signature;
      repeatCount = 1;
      loopAlerted = false;
    }
    stats.maxRepeat = Math.max(stats.maxRepeat, repeatCount);
    if (loopRepeat && repeatCount >= loopRepeat && !loopAlerted) {
      loopAlerted = true;
      const shown = input.length > 120 ? `${input.slice(0, 120)}…` : input;
      alert('loop', `the same tool call ${repeatCount} times in a row: ${block.name} ${shown} (threshold ${loopRepeat}, TASK_LOOP_REPEAT)`);
    }
  }

  function onEvent(event) {
    sawEvent = true;
    stats.events += 1;
    if (event.type === 'result') {
      resultEvent = event;
      return;
    }
    const content = event.message && Array.isArray(event.message.content) ? event.message.content : [];
    if (event.type === 'assistant') {
      for (const block of content) {
        if (block.type === 'tool_use') onToolUse(block);
        if (block.type === 'text' && typeof block.text === 'string') texts.push(block.text);
      }
    }
  }

  function onLine(line) {
    const trimmed = line.trim();
    if (!trimmed) return;
    if (trimmed[0] === '{') {
      try {
        onEvent(JSON.parse(trimmed));
        return;
      } catch {
        // not an event; kept as plain text below
      }
    }
  }

  armStallTimer();

  return {
    /** Feed a stdout chunk. Every chunk counts as activity. */
    feed(chunk) {
      const text = String(chunk);
      raw += text;
      markActivity();
      buffer += text;
      let nl;
      while ((nl = buffer.indexOf('\n')) !== -1) {
        onLine(buffer.slice(0, nl));
        buffer = buffer.slice(nl + 1);
      }
    },

    /** Stderr counts as activity too. */
    touch() {
      markActivity();
    },

    /**
     * What the run produced, once it has exited.
     * @returns {{ output: string, hitMaxTurns: boolean, message: string, structured: boolean, stats: object }}
     *   `message` is the CLI's own result or error text (for diagnostics); `structured`
     *   says whether stream-json events were seen at all; `stats` is what the run looked
     *   like (durationMs, events, toolCalls, maxQuietMs, maxRepeat, numTurns, costUsd, alerts).
     */
    finish() {
      if (buffer) { onLine(buffer); buffer = ''; }
      disposed = true;
      clearStallTimer();
      const t = now();
      stats.maxQuietMs = Math.max(stats.maxQuietMs, t - lastActivity);
      const runStats = {
        ...stats,
        durationMs: t - startedAt,
        numTurns: resultEvent && Number.isFinite(resultEvent.num_turns) ? resultEvent.num_turns : null,
        costUsd: resultEvent && Number.isFinite(resultEvent.total_cost_usd) ? resultEvent.total_cost_usd : null,
      };
      if (!sawEvent) {
        const output = raw.trim();
        return { output, hitMaxTurns: output.includes('Reached max turns'), message: output, structured: false, stats: runStats };
      }
      const resultText = resultEvent && typeof resultEvent.result === 'string' ? resultEvent.result.trim() : '';
      const output = resultText || texts.join('\n').trim();
      const hitMaxTurns = Boolean(resultEvent && resultEvent.subtype === 'error_max_turns') ||
        output.includes('Reached max turns');
      return { output, hitMaxTurns, message: resultText || output, structured: true, stats: runStats };
    },

    dispose() {
      disposed = true;
      clearStallTimer();
    },
  };
}

module.exports = { createStreamWatch };
