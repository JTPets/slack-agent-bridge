'use strict';

/**
 * tests/task-agent-identity.test.js
 *
 * THE guard for WORK-TODO #38: a `TASK:` message executes as the agent it was
 * addressed to, not always as the bridge.
 *
 * The defect: `agentConfig` is bound ONCE at module scope to `getAgent('bridge')`
 * (`bridge-agent.js`) and never rebound. `processConversation` has taken the
 * channel's agent as a parameter since 2026-03-27; `processTask` did not, and read
 * the module-scope record directly. So a scheduled agent's own cron job, posting a
 * `TASK:` message into that agent's own channel, ran with the BRIDGE's persona,
 * provider, model and metrics identity.
 *
 * WHY THIS FILE READS SOURCE RATHER THAN CALLING processTask: `processTask` is not
 * exported, and calling it needs a Slack client, a clone, an LLM and a lock. The
 * repository's established answer to that is `tests/task-queue-lifecycle.test.js` —
 * EXTRACT the decision from `bridge-agent.js`'s source at the site production runs,
 * then replay it against real inputs. A hand-written `resolve(storyBot)` would prove
 * only that a fallback expression works, which is not the claim; the claim is that
 * the live path performs it.
 *
 * Every assertion carries a negative control, because several are of the form
 * "this list is empty" and such a test passes just as well when its own scan is
 * broken.
 */

const fs = require('fs');
const path = require('path');

const REPO_ROOT = path.join(__dirname, '..');
const source = fs.readFileSync(path.join(REPO_ROOT, 'bridge-agent.js'), 'utf8');

const { loadAgents, getAgent } = require('../lib/agent-registry');
const { activeChannels } = require('../lib/agent-surface');

/** Strip // line comments and block comments, leaving strings intact. */
function stripComments(src) {
    return src
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/(^|[^:])\/\/[^\n]*/g, '$1');
}

/** The body of a top-level `async function <name>(` up to the next top-level `}`. */
function functionBody(src, name) {
    const start = src.indexOf(`async function ${name}(`);
    if (start === -1) return null;
    let i = src.indexOf('{', start);
    let depth = 0;
    for (; i < src.length; i++) {
        if (src[i] === '{') depth++;
        else if (src[i] === '}') {
            depth--;
            if (depth === 0) return src.slice(start, i + 1);
        }
    }
    return null;
}

describe('a TASK: executes as the agent it was addressed to (WORK-TODO #38)', () => {

    describe('the guard itself detects what it claims to', () => {
        it('functionBody finds a function and stops at its end', () => {
            const fixture = 'async function a(x) { if (x) { return 1; } }\nasync function b() { return 2; }';
            expect(functionBody(fixture, 'a')).toBe('async function a(x) { if (x) { return 1; } }');
            expect(functionBody(fixture, 'zzz')).toBeNull();
        });

        it('stripComments removes comments but keeps string contents', () => {
            expect(stripComments("const a = 1; // agentConfig")).not.toMatch(/agentConfig/);
            expect(stripComments("/* agentConfig */ const b = 2;")).not.toMatch(/agentConfig/);
            expect(stripComments("const c = 'bridge';")).toMatch(/'bridge'/);
        });

        it('the extracted resolution expression would fail if it stopped existing', () => {
            expect(extractResolution('const currentAgent = nothing;')).toBeNull();
        });
    });

    /** Pull the two resolution lines out of processTask's source. */
    // eslint-disable-next-line no-inner-declarations
    function extractResolution(src) {
        const agent = src && src.match(/const currentAgent = (handlingAgent \|\| agentConfig);/);
        const id = src && src.match(/const currentAgentId = (currentAgent\?\.id \|\| 'bridge');/);
        if (!agent || !id) return null;
        return { agentExpr: agent[1], idExpr: id[1] };
    }

    const taskBody = functionBody(source, 'processTask');
    const convBody = functionBody(source, 'processConversation');

    /**
     * Compile the resolution expressions found in processTask's source and run them.
     * Throws a NAMED error when processTask carries no resolution, so the failure
     * reads as "processTask does not resolve an agent" instead of a destructure crash.
     */
    function resolve(handlingAgent, agentConfig) {
        const extracted = extractResolution(taskBody);
        if (!extracted) {
            throw new Error(
                'processTask does not resolve a handling agent: neither '
                + '`const currentAgent = handlingAgent || agentConfig;` nor '
                + '`const currentAgentId = currentAgent?.id || \'bridge\';` '
                + 'was found in its source. This is WORK-TODO #38 reopened.',
            );
        }
        // eslint-disable-next-line no-new-func
        return new Function(
            'handlingAgent',
            'agentConfig',
            `const currentAgent = ${extracted.agentExpr};
             const currentAgentId = ${extracted.idExpr};
             return { currentAgent, currentAgentId };`,
        )(handlingAgent, agentConfig);
    }

    it('processTask and processConversation both exist in source', () => {
        expect(taskBody).not.toBeNull();
        expect(convBody).not.toBeNull();
    });

    it('processTask accepts a handlingAgent, as processConversation already did', () => {
        expect(source).toMatch(
            /async function processTask\(msg, sourceChannel = BRIDGE_CHANNEL, queueId = null, handlingAgent = null\)/,
        );
        expect(source).toMatch(
            /async function processConversation\(msg, sourceChannel = BRIDGE_CHANNEL, handlingAgent = null\)/,
        );
    });

    it('it is the SAME mechanism, not a third one', () => {
        // Both resolve with the identical `handlingAgent || agentConfig` fallback.
        const task = extractResolution(taskBody);
        expect(task).not.toBeNull();
        expect(task.agentExpr).toBe('handlingAgent || agentConfig');
        expect(convBody).toMatch(/const currentAgent = handlingAgent \|\| agentConfig;/);
    });

    it('the poll loop hands BOTH paths the same channelAgentConfig', () => {
        const stripped = stripComments(source);
        expect(stripped).toMatch(
            /processTask\(msg, channelId, queuedTask\.id, channelAgentConfig\)/,
        );
        // processConversation is called on the ASK: and natural-language branches.
        const convCalls = stripped.match(/processConversation\(msg, channelId, channelAgentConfig\)/g) || [];
        expect(convCalls.length).toBeGreaterThanOrEqual(1);
        // The value both receive is destructured from the channelsToPoll entry.
        expect(stripped).toMatch(
            /const \{ channelId, agentId, agentConfig: channelAgentConfig \} = channelInfo;/,
        );
    });

    describe('every identity the executing agent decides reads the resolved agent', () => {
        const stripped = stripComments(taskBody || '');

        // Each entry: what the agent decides, and the expression that must produce it.
        const IDENTITY_SITES = [
            ['provider',        /resolveLlmProvider\(currentAgent, currentAgentId\)/],
            ['persona',         /const agentSystemPrompt = currentAgent\?\.system_prompt \|\| '';/],
            ['model',           /model: currentAgent\?\.llm_model,/],
            ['metrics id',      /const agentId = currentAgentId;/],
            ['bulletin stream', /formatBulletinsForContext\(currentAgentId, 10\)/],
            ['bulletin voice',  /postBulletin\(currentAgentId, 'task_completed'/],
            ['working memory',  /clearAgentWorkingMemory\(currentAgentId\)/],
        ];

        it.each(IDENTITY_SITES)('%s follows the resolved agent', (_label, pattern) => {
            expect(stripped).toMatch(pattern);
        });

        it('NO identity site still reads the module-scope agentConfig', () => {
            // The only permitted mention is the fallback arm of the resolution itself.
            const reads = (stripped.match(/agentConfig/g) || []).length;
            const inResolution = (stripped.match(/handlingAgent \|\| agentConfig/g) || []).length;
            expect(reads).toBe(inResolution);
            expect(inResolution).toBe(1);
        });

        it('the only hardcoded bridge identity left is the owner action inbox', () => {
            // `|| 'bridge'` is the registry-failed-to-load fallback and is expected.
            const literals = (stripped.match(/'bridge'/g) || []).length;
            const fallbacks = (stripped.match(/\|\| 'bridge'/g) || []).length;
            expect(fallbacks).toBe(1);
            // One remaining literal, and it is processActionRequired's: the OWNER's
            // action list, not the agent's identity. See the comment at that site.
            expect(literals - fallbacks).toBe(1);
            expect(stripped).toMatch(/processActionRequired\(output, \{ agentId: 'bridge' \}\)/);
        });
    });

    describe('replaying the extracted resolution against real agent records', () => {
        // Evaluate the EXPRESSIONS TAKEN FROM SOURCE, so a change to them changes
        // this test's subject rather than leaving it asserting a stale copy.
        //
        // Built lazily inside each test, not at describe time: when processTask does
        // NOT resolve an agent — which is the defect this file exists to catch — a
        // describe-time destructure throws during COLLECTION, and jest then reports
        // "0 tests" rather than a named failure. A guard whose failure mode is an
        // unreadable crash is a worse guard. Every test below fails with a message.
        const bridge = getAgent('bridge');

        it('processTask resolves an agent at all (the precondition for the rest)', () => {
            expect(extractResolution(taskBody)).not.toBeNull();
        });

        it('a task addressed to story-bot resolves to story-bot, not the bridge', () => {
            const storyBot = getAgent('story-bot');
            expect(storyBot).toBeTruthy();
            expect(storyBot.id).toBe('story-bot');

            const out = resolve(storyBot, bridge);
            expect(out.currentAgentId).toBe('story-bot');
            expect(out.currentAgent.system_prompt).toBe(storyBot.system_prompt);
            expect(out.currentAgent.llm_provider).toBe(storyBot.llm_provider);
            // The point of the item: it is NOT the bridge's.
            expect(out.currentAgentId).not.toBe('bridge');
            if (bridge) expect(out.currentAgent.system_prompt).not.toBe(bridge.system_prompt);
        });

        it('every declared agent resolves to itself', () => {
            for (const agent of loadAgents()) {
                expect(resolve(agent, bridge).currentAgentId).toBe(agent.id);
            }
        });

        it('no handling agent still falls back to the bridge', () => {
            expect(resolve(null, bridge).currentAgentId).toBe('bridge');
        });

        it('a registry that failed to load falls back to the literal id', () => {
            expect(resolve(null, null).currentAgentId).toBe('bridge');
            expect(resolve(null, null).currentAgent).toBeNull();
        });
    });

    describe('the scheduled case end to end: channel -> agent -> identity', () => {
        it('a scheduled agent posts into a channel whose poll entry is that agent', () => {
            // activeChannels() is THE one membership rule; buildChannelsToPoll()
            // delegates to it, and the scheduler refuses anything it excludes. So the
            // agent a scheduled TASK: message will execute as is the agent on the
            // channel entry for the channel the scheduler posted into.
            const agents = loadAgents();
            const scheduled = agents.filter(a => a.schedule);
            expect(scheduled.length).toBeGreaterThan(0);

            const entries = activeChannels(agents, 'C_BRIDGE_TEST');
            for (const entry of entries) {
                if (entry.agentId === 'bridge') continue;
                // This is exactly what buildChannelsToPoll puts in agentConfig.
                const resolved = getAgent(entry.agentId);
                expect(resolved).toBeTruthy();
                expect(resolved.id).toBe(entry.agentId);
                // ...and what processTask would then execute as.
                const { currentAgentId } = resolve(resolved, getAgent('bridge'));
                expect(currentAgentId).toBe(entry.agentId);
            }
        });
    });
});
