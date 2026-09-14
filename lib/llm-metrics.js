/**
 * lib/llm-metrics.js
 *
 * LOGIC CHANGE 2026-09-11: Created llm-metrics.js to make LLM provider fallback
 * visible to the operator. Before this, a fallback was a single console.log line
 * with no durable record, so "what fraction of agent X's calls fell back this
 * week" could only be answered by grepping the process logs (which roll).
 *
 * This module is the counter surface. It does two things per LLM call:
 *   1. Emits ONE structured log line (`[llm-verdict] {json}`) so the verdict is
 *      greppable and machine-parseable in the container logs
 *      (`docker compose logs -f jt-agent`).
 *
 * LOGIC CHANGE 2026-09-14: both references above said "pm2 logs". There is no pm2
 * in this deployment, so that named a log destination that does not exist - a
 * reader following it would find nothing and conclude the metric was missing.
 *   2. Increments a day-bucketed counter persisted to JSON so the same question
 *      is answerable with getStats() instead of a log grep.
 *
 * Invisible-to-the-agent is the goal of fallback. Invisible-to-the-operator is
 * the defect this module exists to prevent.
 *
 * There was no pre-existing metrics surface in this repo (no statsd, no
 * prometheus, no metrics file). The counter therefore lands next to the other
 * durable agent state under agents/shared/, which is gitignored local state.
 */

'use strict';

const fs = require('fs');
const path = require('path');

// Default counter location: alongside the other agents/shared runtime state.
// Override with LLM_METRICS_FILE (used by tests to isolate into a temp dir).
const DEFAULT_METRICS_FILE = path.join(__dirname, '..', 'agents', 'shared', 'llm-metrics.json');

// Days of history to keep. Older day-buckets are pruned on write.
const DEFAULT_RETENTION_DAYS = parseInt(process.env.LLM_METRICS_RETENTION_DAYS || '30', 10);

// Counter file schema version. Bump if the shape below changes incompatibly.
const METRICS_VERSION = 1;

/**
 * Resolve the metrics file path at call time (not module load time) so tests
 * and operators can point LLM_METRICS_FILE somewhere else without a reload.
 *
 * @returns {string} Absolute path to the metrics JSON file
 */
function getMetricsFile() {
  return process.env.LLM_METRICS_FILE || DEFAULT_METRICS_FILE;
}

/**
 * Day bucket key for a timestamp. UTC, not America/Toronto — a stable key
 * matters more than local-midnight alignment for a 7-day ratio.
 *
 * @param {Date} [date=new Date()] - Timestamp to bucket
 * @returns {string} YYYY-MM-DD
 */
function dayKey(date = new Date()) {
  return date.toISOString().slice(0, 10);
}

/**
 * Read the counter file. A missing or corrupt file is not an error — it means
 * "no history yet" and we start a fresh structure rather than crashing a call.
 *
 * @returns {{ version: number, days: Object }}
 */
function readMetrics() {
  const file = getMetricsFile();
  try {
    const raw = fs.readFileSync(file, 'utf8');
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || typeof parsed.days !== 'object' || parsed.days === null) {
      return { version: METRICS_VERSION, days: {} };
    }
    return { version: parsed.version || METRICS_VERSION, days: parsed.days };
  } catch (err) {
    if (err.code !== 'ENOENT') {
      // Surface it — a corrupt counter file that silently resets is exactly the
      // kind of invisible failure this module exists to prevent.
      console.error(`[llm-metrics] Could not read ${file}: ${err.message} (starting fresh)`);
    }
    return { version: METRICS_VERSION, days: {} };
  }
}

/**
 * Write the counter file, pruning day-buckets past the retention window.
 * A write failure is logged, never thrown — metrics must not break an LLM call.
 *
 * @param {{ version: number, days: Object }} metrics - Metrics structure to persist
 * @returns {boolean} True if the write succeeded
 */
function writeMetrics(metrics) {
  const file = getMetricsFile();
  try {
    const retention = DEFAULT_RETENTION_DAYS;
    const cutoff = dayKey(new Date(Date.now() - retention * 24 * 60 * 60 * 1000));
    for (const day of Object.keys(metrics.days)) {
      if (day < cutoff) delete metrics.days[day];
    }

    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(metrics, null, 2), 'utf8');
    return true;
  } catch (err) {
    console.error(`[llm-metrics] Could not write ${file}: ${err.message}`);
    return false;
  }
}

/**
 * Record the verdict for one logical LLM call.
 *
 * Every call through runLLM/runWithFallback records exactly one verdict, whether
 * or not a fallback happened. fallbackReason is null when the requested provider
 * served the call — that null is the point: it distinguishes "no fallback" from
 * "we never looked".
 *
 * @param {Object} verdict - The call verdict
 * @param {string} verdict.provider_requested - Provider the caller asked for
 * @param {string} [verdict.provider_used] - Provider that actually served it (null on total failure)
 * @param {string|null} [verdict.fallback_reason] - Why we fell back, or null if we did not
 * @param {number} [verdict.latency_ms] - Wall-clock duration of the logical call
 * @param {string} [verdict.model] - Model name, when the provider has one
 * @param {string} [verdict.agent_id] - Agent the call was made on behalf of
 * @param {boolean} [verdict.ok] - Whether the logical call ultimately succeeded
 * @returns {Object} The normalized verdict that was recorded
 */
function recordVerdict(verdict = {}) {
  const record = {
    provider_requested: verdict.provider_requested || 'unknown',
    provider_used: verdict.provider_used || null,
    fallback_reason: verdict.fallback_reason || null,
    latency_ms: typeof verdict.latency_ms === 'number' ? verdict.latency_ms : null,
    model: verdict.model || null,
    agent_id: verdict.agent_id || 'unknown',
    ok: verdict.ok !== false,
    ts: new Date().toISOString(),
  };

  // 1. One structured log line per call. Single line, JSON payload, stable prefix.
  console.log(`[llm-verdict] ${JSON.stringify(record)}`);

  // 2. Durable counter. Never let a counter problem fail the caller's LLM call.
  try {
    const metrics = readMetrics();
    const day = dayKey();
    if (!metrics.days[day]) metrics.days[day] = {};

    const agentKey = record.agent_id;
    if (!metrics.days[day][agentKey]) {
      metrics.days[day][agentKey] = {
        calls: 0,
        fallbacks: 0,
        failures: 0,
        requested: {},
        used: {},
        reasons: {},
      };
    }

    const bucket = metrics.days[day][agentKey];
    bucket.calls += 1;
    if (record.fallback_reason) {
      bucket.fallbacks += 1;
      bucket.reasons[record.fallback_reason] = (bucket.reasons[record.fallback_reason] || 0) + 1;
    }
    if (!record.ok) bucket.failures += 1;
    bucket.requested[record.provider_requested] = (bucket.requested[record.provider_requested] || 0) + 1;
    if (record.provider_used) {
      bucket.used[record.provider_used] = (bucket.used[record.provider_used] || 0) + 1;
    }

    writeMetrics(metrics);
  } catch (err) {
    console.error(`[llm-metrics] recordVerdict counter update failed: ${err.message}`);
  }

  return record;
}

/**
 * Summarize the counter over a trailing window.
 *
 * This is the answer to "what fraction of agent X's calls fell back this week"
 * without grepping logs:
 *   getStats({ agentId: 'secretary', days: 7 }).fallbackRate
 *
 * @param {Object} [opts={}] - Query options
 * @param {number} [opts.days=7] - Size of the trailing window in days (inclusive of today)
 * @param {string} [opts.agentId] - Restrict to one agent; omit for all agents
 * @returns {Object} Aggregate totals plus a per-agent breakdown
 */
function getStats(opts = {}) {
  const days = opts.days || 7;
  const agentId = opts.agentId;

  const metrics = readMetrics();
  const from = dayKey(new Date(Date.now() - (days - 1) * 24 * 60 * 60 * 1000));
  const to = dayKey();

  const totals = { calls: 0, fallbacks: 0, failures: 0, requested: {}, used: {}, reasons: {} };
  const perAgent = {};

  for (const [day, agents] of Object.entries(metrics.days)) {
    if (day < from || day > to) continue;

    for (const [agent, bucket] of Object.entries(agents)) {
      if (agentId && agent !== agentId) continue;

      if (!perAgent[agent]) {
        perAgent[agent] = { calls: 0, fallbacks: 0, failures: 0, requested: {}, used: {}, reasons: {} };
      }

      for (const target of [totals, perAgent[agent]]) {
        target.calls += bucket.calls || 0;
        target.fallbacks += bucket.fallbacks || 0;
        target.failures += bucket.failures || 0;
        for (const [k, v] of Object.entries(bucket.requested || {})) {
          target.requested[k] = (target.requested[k] || 0) + v;
        }
        for (const [k, v] of Object.entries(bucket.used || {})) {
          target.used[k] = (target.used[k] || 0) + v;
        }
        for (const [k, v] of Object.entries(bucket.reasons || {})) {
          target.reasons[k] = (target.reasons[k] || 0) + v;
        }
      }
    }
  }

  for (const agent of Object.keys(perAgent)) {
    perAgent[agent].fallbackRate = perAgent[agent].calls > 0
      ? perAgent[agent].fallbacks / perAgent[agent].calls
      : 0;
  }

  return {
    windowDays: days,
    from,
    to,
    agentId: agentId || null,
    calls: totals.calls,
    fallbacks: totals.fallbacks,
    failures: totals.failures,
    fallbackRate: totals.calls > 0 ? totals.fallbacks / totals.calls : 0,
    requested: totals.requested,
    used: totals.used,
    reasons: totals.reasons,
    agents: perAgent,
  };
}

/**
 * Delete the counter file. Exported for tests and for an operator who wants a
 * clean window; not called anywhere in the running agent.
 *
 * @returns {void}
 */
function resetStats() {
  try {
    fs.unlinkSync(getMetricsFile());
  } catch (err) {
    if (err.code !== 'ENOENT') {
      console.error(`[llm-metrics] resetStats failed: ${err.message}`);
    }
  }
}

module.exports = {
  recordVerdict,
  getStats,
  resetStats,
  getMetricsFile,
  dayKey,
  readMetrics,
  writeMetrics,
  DEFAULT_METRICS_FILE,
  DEFAULT_RETENTION_DAYS,
  METRICS_VERSION,
};
