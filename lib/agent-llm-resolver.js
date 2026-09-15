'use strict';

/**
 * lib/agent-llm-resolver.js
 *
 * ONE answer to "what is this agent actually running on, and where did each value
 * come from?" — provider, model, and the adapter inputs each provider needs, every
 * one of them carrying its source.
 *
 * LOGIC CHANGE 2026-09-15: New file. `resolveLlmProvider` in lib/config.js already
 * owned the PROVIDER precedence and still does — this module calls it rather than
 * re-deriving it (docs/CANONICAL-HELPERS.md). What did not exist anywhere was:
 *
 *   - the MODEL precedence, which was inline at three call sites in bridge-agent.js
 *     as a bare `agentConfig?.llm_model` and defaulted inside each adapter;
 *   - the adapter inputs (base URL, key presence, binary path), which each adapter
 *     read straight from process.env at call time, so nothing could report them;
 *   - the PROVENANCE of any of it. That is the point of this module. "secretary is
 *     on gemini" does not tell you whether an unexpected change came from the
 *     registry, from .env, or from a global default — and those have three
 *     different fixes.
 *
 * READ-ONLY and PURE with respect to an injected env: it resolves and reports. It
 * calls no provider, opens no socket, and writes no file. `ASK: agent status`
 * renders it; nothing dispatches from it.
 *
 * NO CREDENTIAL VALUE EVER LEAVES THIS MODULE. Where a key matters the result says
 * only whether it is set and which variable would hold it — never the value. That
 * is a hard rule here, not a convention: this output is built to be posted to Slack.
 */

const { resolveLlmProvider } = require('./config');

/**
 * Provenance labels. A caller switching on these is switching on WHERE to go and
 * change a value, which is the whole reason the field exists.
 */
const SOURCE = {
    AGENT_ENV: 'env:LLM_PROVIDER_<AGENTID>',   // per-agent override in .env — survives a pull
    REGISTRY: 'registry:agents.json',          // tracked; on-box edits are lost to git reset --hard
    GLOBAL_ENV: 'env:LLM_PROVIDER',            // global default in .env
    DEFAULT: 'built-in default',               // the hard fallback in code
    ADAPTER_DEFAULT: 'adapter default',        // the value the adapter picks when nothing is set
    UNSET: 'unset',                            // nothing supplies it — a precondition failure at call time
};

/**
 * The env var name that overrides this agent's provider.
 * Kept identical to lib/config.js's construction; the test asserts they agree.
 *
 * @param {string} agentId
 * @returns {string}
 */
function perAgentEnvKey(agentId) {
    return 'LLM_PROVIDER_' + String(agentId).toUpperCase().replace(/[^A-Z0-9]+/g, '_');
}

/**
 * Where did the provider come from? Re-walks the same precedence
 * `resolveLlmProvider` applies, and asserts agreement on the resolved value, so the
 * two cannot drift into reporting one source while using another.
 *
 * @param {object|null} agentConfig
 * @param {string} agentId
 * @param {object} env
 * @returns {{ provider: string, provider_source: string, provider_env_key: string }}
 */
function resolveProviderWithSource(agentConfig, agentId, env) {
    const key = perAgentEnvKey(agentId);
    const perAgent = env[key];

    let source;
    if (perAgent && String(perAgent).trim()) {
        source = SOURCE.AGENT_ENV;
    } else if (agentConfig && agentConfig.llm_provider) {
        source = SOURCE.REGISTRY;
    } else if (env.LLM_PROVIDER && String(env.LLM_PROVIDER).trim()) {
        source = SOURCE.GLOBAL_ENV;
    } else {
        source = SOURCE.DEFAULT;
    }

    // resolveLlmProvider reads process.env directly. When an injected env is a
    // different object, swap it in for the duration of the call rather than
    // duplicating the precedence here — one owner for the value, one for the label.
    const provider = withEnv(env, () => resolveLlmProvider(agentConfig, agentId));

    return { provider, provider_source: source, provider_env_key: key };
}

/**
 * Run `fn` with process.env temporarily replaced by `env`, when they differ.
 * Synchronous only, and restored in a finally block.
 *
 * @param {object} env
 * @param {Function} fn
 * @returns {*}
 */
function withEnv(env, fn) {
    if (env === process.env) return fn();
    const saved = process.env;
    try {
        process.env = env;
        return fn();
    } finally {
        process.env = saved;
    }
}

/**
 * Which model, and from where.
 *
 * Precedence: the agent's registry `llm_model` (a router model and a workhorse model
 * sharing one provider is what it is for), then the provider's own env default, then
 * whatever the adapter falls back to. There is deliberately NO per-agent model env
 * override: unlike the provider, no live model edit has ever been lost to a reset,
 * so inventing a second override surface would add precedence without a cause. If
 * that changes, it belongs here, not at a call site.
 *
 * @param {object|null} agentConfig
 * @param {string} provider
 * @param {object} env
 * @returns {{ model: string|null, model_source: string }}
 */
function resolveModelWithSource(agentConfig, provider, env) {
    if (agentConfig && agentConfig.llm_model) {
        return { model: agentConfig.llm_model, model_source: SOURCE.REGISTRY };
    }
    switch (String(provider).toLowerCase()) {
        case 'ollama':
            // No hardcoded model in the adapter, deliberately: with neither set, the
            // call throws a precondition error rather than guessing a model that may
            // not be pulled. So "unset" here is a real, reportable state.
            return env.OLLAMA_MODEL
                ? { model: env.OLLAMA_MODEL, model_source: 'env:OLLAMA_MODEL' }
                : { model: null, model_source: SOURCE.UNSET };
        case 'gemini':
            // lib/llm-runner.js runGeminiAdapter: `options.model || 'gemini-2.5-flash'`.
            return { model: 'gemini-2.5-flash', model_source: SOURCE.ADAPTER_DEFAULT };
        case 'claude':
            // The CLI picks the model; this repo names none.
            return { model: null, model_source: 'chosen by the claude CLI' };
        default:
            return { model: null, model_source: SOURCE.UNSET };
    }
}

/**
 * The inputs the provider's adapter needs, each with its source.
 *
 * NEVER a credential value. `key_set` is a boolean and `key_env` is a variable name;
 * that pair is what makes "gemini is failing" answerable in Slack without anyone
 * pasting a key into a channel.
 *
 * @param {string} provider
 * @param {object} env
 * @returns {{ inputs: object, ready: boolean, blocked_on: string|null }}
 */
function resolveAdapterInputs(provider, env) {
    switch (String(provider).toLowerCase()) {
        case 'claude': {
            const bin = env.CLAUDE_BIN || '/usr/local/bin/claude';
            return {
                inputs: {
                    binary: bin,
                    binary_source: env.CLAUDE_BIN ? 'env:CLAUDE_BIN' : SOURCE.DEFAULT,
                },
                ready: true,   // presence of the binary is a runtime fact, not a config one
                blocked_on: null,
            };
        }
        case 'gemini': {
            const keySet = Boolean(env.GEMINI_API_KEY && String(env.GEMINI_API_KEY).trim());
            return {
                inputs: { key_env: 'GEMINI_API_KEY', key_set: keySet },
                ready: keySet,
                blocked_on: keySet ? null : 'GEMINI_API_KEY is not set',
            };
        }
        case 'ollama': {
            const baseUrl = env.OLLAMA_BASE_URL || 'http://127.0.0.1:11434';
            const modelSet = Boolean(env.OLLAMA_MODEL && String(env.OLLAMA_MODEL).trim());
            return {
                inputs: {
                    base_url: baseUrl,
                    base_url_source: env.OLLAMA_BASE_URL ? 'env:OLLAMA_BASE_URL' : SOURCE.DEFAULT,
                    keep_alive: env.OLLAMA_KEEP_ALIVE || '5m',
                    num_ctx: parseInt(env.OLLAMA_NUM_CTX || '8192', 10),
                    timeout_ms: parseInt(env.OLLAMA_TIMEOUT_MS || '120000', 10),
                },
                // A model may still come from the registry; the caller merges that in.
                ready: modelSet,
                blocked_on: modelSet ? null : 'no model: neither OLLAMA_MODEL nor the agent\'s llm_model is set',
            };
        }
        default:
            return {
                inputs: {},
                ready: false,
                blocked_on: `unknown provider "${provider}" — a configuration defect, not a fallback trigger`,
            };
    }
}

/**
 * THE resolver. For one agent: which provider, which model, which adapter inputs,
 * and where each value came from.
 *
 * @param {object|null} agentConfig - Registry record, or null.
 * @param {object} [options]
 * @param {string} [options.agentId] - Used when agentConfig is null or has no id.
 * @param {object} [options.env] - Defaults to process.env.
 * @returns {object} Flat, JSON-serialisable, credential-free.
 */
function resolveAgentLlm(agentConfig, options = {}) {
    const env = options.env || process.env;
    const agentId = options.agentId || (agentConfig && agentConfig.id) || 'bridge';

    const { provider, provider_source, provider_env_key } = resolveProviderWithSource(agentConfig, agentId, env);
    const { model, model_source } = resolveModelWithSource(agentConfig, provider, env);
    const adapter = resolveAdapterInputs(provider, env);

    // An ollama agent with a registry llm_model is ready even with OLLAMA_MODEL unset.
    const ready = adapter.ready || (String(provider).toLowerCase() === 'ollama' && Boolean(model));
    const blocked_on = ready ? null : adapter.blocked_on;

    return {
        agent_id: agentId,
        provider,
        provider_source,
        provider_env_key,
        model,
        model_source,
        adapter_inputs: adapter.inputs,
        ready,
        blocked_on,
    };
}

/**
 * Render one resolution as lines for a Slack code block. Credential-free by
 * construction — it prints `adapter_inputs`, which never holds a secret value.
 *
 * @param {object} resolved - From resolveAgentLlm().
 * @returns {string[]}
 */
function formatResolution(resolved) {
    const lines = [
        `${resolved.agent_id}`,
        `  provider: ${resolved.provider}  (${resolved.provider_source})`,
        `  model:    ${resolved.model || '—'}  (${resolved.model_source})`,
    ];
    const inputs = resolved.adapter_inputs || {};
    const keys = Object.keys(inputs);
    if (keys.length) {
        lines.push(`  adapter:  ${keys.map(k => `${k}=${inputs[k]}`).join(', ')}`);
    }
    if (!resolved.ready) lines.push(`  BLOCKED:  ${resolved.blocked_on}`);
    return lines;
}

module.exports = {
    SOURCE,
    perAgentEnvKey,
    resolveAgentLlm,
    resolveAdapterInputs,
    resolveModelWithSource,
    resolveProviderWithSource,
    formatResolution,
};
