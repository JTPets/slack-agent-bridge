/**
 * lib/llm-defaults.js
 *
 * The LLM layer's configuration, read from the environment when this module loads:
 * the default provider, the Claude binary, turn and timeout defaults, the fallback
 * chain defaults and the Ollama settings, plus normalizeThink.
 *
 * Moved unchanged out of lib/llm-runner.js on 2026-10-05 (WORK-TODO #10). lib/llm-runner.js
 * re-exports every name here, so callers are unchanged.
 */

'use strict';

// Default configuration
const DEFAULT_PROVIDER = 'claude';
// LOGIC CHANGE 2026-09-13: Default moved off the dead Raspberry Pi home path to the
// container path. Kept in step with lib/config.js - these two must not diverge.
const DEFAULT_CLAUDE_BIN = process.env.CLAUDE_BIN || '/usr/local/bin/claude';
// LOGIC CHANGE 2026-10-04 (WORK-TODO #20): no longer read from the MAX_TURNS env var.
// It is the fallback for a caller that passes no maxTurns, and no production caller
// does; it is the parser's DEFAULT_TURNS so a TASK: and a bare call cannot disagree.
const DEFAULT_MAX_TURNS = require('./task-parser').DEFAULT_TURNS;
const DEFAULT_TIMEOUT = parseInt(process.env.TASK_TIMEOUT_MS || '600000', 10);
// LOGIC CHANGE 2026-10-10 (WORK-TODO #59): the run watcher meant to replace the turn cap
// (lib/claude-stream-watch.js). `report` (default) alerts and lets the run continue;
// `enforce` stops it. Owner's rule: report until real runs show where the thresholds
// belong. 0 disables either rule.
const DEFAULT_STALL_MS = parseInt(process.env.TASK_STALL_MS || '600000', 10);
const DEFAULT_LOOP_REPEAT = parseInt(process.env.TASK_LOOP_REPEAT || '5', 10);
const DEFAULT_LIMITER_MODE = process.env.TASK_LIMITER_MODE === 'enforce' ? 'enforce' : 'report';

// LOGIC CHANGE 2026-04-01: Added fallback configuration for Claude → Gemini failover.
// When Claude hits rate limits, the system can automatically retry with Gemini.
const DEFAULT_FALLBACK_PROVIDER = 'gemini';
const FALLBACK_ENABLED = process.env.LLM_FALLBACK_ENABLED !== 'false'; // Default: enabled

// LOGIC CHANGE 2026-09-11: Per-primary default fallback chains. An agent whose
// primary is a local Ollama model degrades ollama -> gemini -> claude: local
// first for cost, hosted Gemini next for speed, Claude last as the most capable.
// Every other primary keeps the historical single-hop behaviour (-> gemini).
const DEFAULT_FALLBACK_CHAINS = {
  ollama: ['gemini', 'claude'],
};

// LOGIC CHANGE 2026-09-11: Ollama (local model server) configuration.
// Defaults are deliberately loopback-only: the Pi binds ollama to 127.0.0.1 so
// the model server is never reachable off-box. See CLAUDE.md for the systemd
// drop-in that enforces this along with the memory/parallelism fencing.
const DEFAULT_OLLAMA_BASE_URL = process.env.OLLAMA_BASE_URL || 'http://127.0.0.1:11434';
const DEFAULT_OLLAMA_KEEP_ALIVE = process.env.OLLAMA_KEEP_ALIVE || '5m';
const DEFAULT_OLLAMA_NUM_CTX = parseInt(process.env.OLLAMA_NUM_CTX || '8192', 10);
const DEFAULT_OLLAMA_TIMEOUT = parseInt(process.env.OLLAMA_TIMEOUT_MS || '120000', 10);

/**
 * LOGIC CHANGE 2026-09-11: Normalize the OLLAMA_THINK / options.think knob into
 * the value Ollama's native API actually accepts.
 *
 * INVESTIGATED, not assumed: Ollama's `think` field takes a boolean OR one of
 * "low" | "medium" | "high" | "max" (ollama/ollama docs/api.md, /api/chat
 * Parameters). There is no `enable_thinking` field anywhere in the Ollama API —
 * neither native nor OpenAI-compatible. See the adapter JSDoc for why this
 * adapter uses the native endpoint.
 *
 * @param {string|boolean|undefined} raw - Configured think value
 * @returns {boolean|string} A value Ollama's `think` field accepts
 */
function normalizeThink(raw) {
  const value = raw === undefined || raw === null ? process.env.OLLAMA_THINK : raw;
  if (value === undefined || value === null || value === '') return false; // Default: thinking OFF
  if (typeof value === 'boolean') return value;

  const lowered = String(value).toLowerCase();
  if (lowered === 'false' || lowered === 'off' || lowered === 'none' || lowered === '0') return false;
  if (lowered === 'true' || lowered === 'on' || lowered === '1') return true;
  if (['low', 'medium', 'high', 'max'].includes(lowered)) return lowered;

  // Unknown value: fail closed to thinking OFF rather than silently sending
  // something the server will 400 on.
  console.warn(`[llm-runner] Unrecognized OLLAMA_THINK value "${value}" - defaulting to false`);
  return false;
}

module.exports = {
  DEFAULT_PROVIDER,
  DEFAULT_CLAUDE_BIN,
  DEFAULT_MAX_TURNS,
  DEFAULT_TIMEOUT,
  DEFAULT_STALL_MS,
  DEFAULT_LOOP_REPEAT,
  DEFAULT_LIMITER_MODE,
  DEFAULT_FALLBACK_PROVIDER,
  FALLBACK_ENABLED,
  DEFAULT_FALLBACK_CHAINS,
  DEFAULT_OLLAMA_BASE_URL,
  DEFAULT_OLLAMA_KEEP_ALIVE,
  DEFAULT_OLLAMA_NUM_CTX,
  DEFAULT_OLLAMA_TIMEOUT,
  normalizeThink,
};
