'use strict';

/**
 * tests/agent-llm-resolver.test.js
 *
 * Tests for lib/agent-llm-resolver.js — the single answer to "what is this agent
 * running on, and where did each value come from".
 *
 * The provenance assertions are the load-bearing half. A resolver that returns the
 * right provider with the wrong source is worse than one that returns no source at
 * all: it sends whoever is debugging to the wrong file.
 */

const {
    SOURCE,
    perAgentEnvKey,
    resolveAgentLlm,
    resolveAdapterInputs,
    resolveModelWithSource,
    formatResolution,
} = require('../lib/agent-llm-resolver');
const { resolveLlmProvider } = require('../lib/config');

describe('perAgentEnvKey', () => {
    test('matches the key lib/config.js builds', () => {
        expect(perAgentEnvKey('code-bridge')).toBe('LLM_PROVIDER_CODE_BRIDGE');
        expect(perAgentEnvKey('story-bot')).toBe('LLM_PROVIDER_STORY_BOT');
        expect(perAgentEnvKey('bridge')).toBe('LLM_PROVIDER_BRIDGE');
    });

    test('collapses a run of non-alphanumerics to ONE underscore, as config.js does', () => {
        expect(perAgentEnvKey('a--b')).toBe('LLM_PROVIDER_A_B');
    });

    // The two constructions are written out separately in two files. If they drift,
    // the resolver reports an override that the bridge does not actually apply.
    test('the key it names is the key resolveLlmProvider actually reads', () => {
        const key = perAgentEnvKey('social-media');
        const saved = process.env[key];
        try {
            process.env[key] = 'ollama';
            expect(resolveLlmProvider({ id: 'social-media', llm_provider: 'gemini' })).toBe('ollama');
        } finally {
            if (saved === undefined) delete process.env[key]; else process.env[key] = saved;
        }
    });
});

describe('provider precedence, with the source at every level', () => {
    const agent = { id: 'secretary', llm_provider: 'gemini' };

    test('1. the per-agent env override wins, and says so', () => {
        const r = resolveAgentLlm(agent, { env: { LLM_PROVIDER_SECRETARY: 'ollama', LLM_PROVIDER: 'claude' } });
        expect(r.provider).toBe('ollama');
        expect(r.provider_source).toBe(SOURCE.AGENT_ENV);
        expect(r.provider_env_key).toBe('LLM_PROVIDER_SECRETARY');
    });

    test('2. the registry wins over the global default, and says so', () => {
        const r = resolveAgentLlm(agent, { env: { LLM_PROVIDER: 'claude' } });
        expect(r.provider).toBe('gemini');
        expect(r.provider_source).toBe(SOURCE.REGISTRY);
    });

    test('3. the global default applies when the registry names none, and says so', () => {
        const r = resolveAgentLlm({ id: 'secretary' }, { env: { LLM_PROVIDER: 'ollama' } });
        expect(r.provider).toBe('ollama');
        expect(r.provider_source).toBe(SOURCE.GLOBAL_ENV);
    });

    test('4. the hard fallback is claude, and says so', () => {
        const r = resolveAgentLlm({ id: 'secretary' }, { env: {} });
        expect(r.provider).toBe('claude');
        expect(r.provider_source).toBe(SOURCE.DEFAULT);
    });

    test('a blank or whitespace-only override does not win — same as config.js', () => {
        const r = resolveAgentLlm(agent, { env: { LLM_PROVIDER_SECRETARY: '   ' } });
        expect(r.provider).toBe('gemini');
        expect(r.provider_source).toBe(SOURCE.REGISTRY);
    });

    test('a null agentConfig resolves against the explicit agentId', () => {
        const r = resolveAgentLlm(null, { agentId: 'jester', env: { LLM_PROVIDER_JESTER: 'gemini' } });
        expect(r.agent_id).toBe('jester');
        expect(r.provider).toBe('gemini');
        expect(r.provider_source).toBe(SOURCE.AGENT_ENV);
    });

    test('the injected env is restored — process.env is not left swapped', () => {
        const before = process.env;
        resolveAgentLlm(agent, { env: { LLM_PROVIDER: 'ollama' } });
        expect(process.env).toBe(before);
    });
});

describe('model precedence, with the source', () => {
    test('the registry llm_model wins for any provider', () => {
        const r = resolveAgentLlm({ id: 'a', llm_provider: 'ollama', llm_model: 'qwen2.5:7b' },
            { env: { OLLAMA_MODEL: 'llama3' } });
        expect(r.model).toBe('qwen2.5:7b');
        expect(r.model_source).toBe(SOURCE.REGISTRY);
    });

    test('ollama falls back to OLLAMA_MODEL', () => {
        const r = resolveModelWithSource({ id: 'a' }, 'ollama', { OLLAMA_MODEL: 'llama3' });
        expect(r).toEqual({ model: 'llama3', model_source: 'env:OLLAMA_MODEL' });
    });

    test('ollama with neither is UNSET, not a guessed model name', () => {
        const r = resolveModelWithSource({ id: 'a' }, 'ollama', {});
        expect(r.model).toBeNull();
        expect(r.model_source).toBe(SOURCE.UNSET);
    });

    test('gemini reports the adapter default it actually uses', () => {
        const r = resolveModelWithSource(null, 'gemini', {});
        expect(r.model).toBe('gemini-2.5-flash');
        expect(r.model_source).toBe(SOURCE.ADAPTER_DEFAULT);
    });

    test('claude names no model — the CLI chooses, and the report says that', () => {
        const r = resolveModelWithSource(null, 'claude', {});
        expect(r.model).toBeNull();
        expect(r.model_source).toMatch(/claude CLI/);
    });
});

describe('adapter inputs', () => {
    test('claude reports the binary path and where it came from', () => {
        expect(resolveAdapterInputs('claude', {}).inputs.binary).toBe('/usr/local/bin/claude');
        expect(resolveAdapterInputs('claude', {}).inputs.binary_source).toBe(SOURCE.DEFAULT);
        expect(resolveAdapterInputs('claude', { CLAUDE_BIN: '/x' }).inputs.binary_source).toBe('env:CLAUDE_BIN');
    });

    test('gemini reports whether the key is set and names the variable — never the value', () => {
        const r = resolveAdapterInputs('gemini', { GEMINI_API_KEY: 'AIzaSy-SECRET-VALUE' });
        expect(r.inputs).toEqual({ key_env: 'GEMINI_API_KEY', key_set: true });
        expect(r.ready).toBe(true);
        expect(JSON.stringify(r)).not.toContain('SECRET');
    });

    test('gemini with no key is not ready, and says what is missing', () => {
        const r = resolveAdapterInputs('gemini', {});
        expect(r.ready).toBe(false);
        expect(r.blocked_on).toMatch(/GEMINI_API_KEY/);
    });

    test('ollama reports the four defaults the adapter actually uses', () => {
        const r = resolveAdapterInputs('ollama', { OLLAMA_MODEL: 'llama3' });
        expect(r.inputs.base_url).toBe('http://127.0.0.1:11434');
        expect(r.inputs.keep_alive).toBe('5m');
        expect(r.inputs.num_ctx).toBe(8192);
        expect(r.inputs.timeout_ms).toBe(120000);
        expect(r.ready).toBe(true);
    });

    test('an ollama agent is ready on a registry model even with OLLAMA_MODEL unset', () => {
        const r = resolveAgentLlm({ id: 'a', llm_provider: 'ollama', llm_model: 'qwen2.5:7b' }, { env: {} });
        expect(r.ready).toBe(true);
        expect(r.blocked_on).toBeNull();
    });

    test('an unknown provider is a configuration defect, not a fallback trigger', () => {
        const r = resolveAgentLlm({ id: 'a', llm_provider: 'not-a-provider' }, { env: {} });
        expect(r.ready).toBe(false);
        expect(r.blocked_on).toMatch(/configuration defect/);
    });
});

describe('no credential value ever leaves the resolver', () => {
    // This is the rule the module header states as hard, so it is asserted rather
    // than trusted. Every sensitive variable is given a recognisable value and the
    // whole serialised result — and the rendered Slack lines — are searched for it.
    const POISON = 'ZZZ-CREDENTIAL-VALUE-ZZZ';
    const env = {
        GEMINI_API_KEY: POISON,
        SLACK_BOT_TOKEN: POISON,
        GOOGLE_CLIENT_SECRET: POISON,
        GOOGLE_REFRESH_TOKEN: POISON,
        SQUARE_ACCESS_TOKEN: POISON,
        HTTPSMS_API_KEY: POISON,
        OLLAMA_MODEL: 'llama3',
    };

    for (const provider of ['claude', 'gemini', 'ollama']) {
        test(`${provider}: neither the object nor the rendered lines carry it`, () => {
            const r = resolveAgentLlm({ id: 'a', llm_provider: provider }, { env });
            expect(JSON.stringify(r)).not.toContain(POISON);
            expect(formatResolution(r).join('\n')).not.toContain(POISON);
        });
    }

    test('the control: the poison value IS present in the env being resolved against', () => {
        // Without this, the three tests above would pass against an empty env and
        // prove nothing.
        expect(env.GEMINI_API_KEY).toBe(POISON);
    });
});

describe('formatResolution', () => {
    test('renders provider and model each with their source', () => {
        const lines = formatResolution(resolveAgentLlm({ id: 'secretary', llm_provider: 'gemini' }, { env: { GEMINI_API_KEY: 'k' } }));
        expect(lines[0]).toBe('secretary');
        expect(lines[1]).toMatch(/provider: gemini\s+\(registry:agent\.md\)/);
        expect(lines[2]).toMatch(/model:\s+gemini-2\.5-flash\s+\(adapter default\)/);
    });

    test('a blocked resolution says what it is blocked on', () => {
        const lines = formatResolution(resolveAgentLlm({ id: 'x', llm_provider: 'gemini' }, { env: {} }));
        expect(lines.join('\n')).toMatch(/BLOCKED:.*GEMINI_API_KEY/);
    });
});
