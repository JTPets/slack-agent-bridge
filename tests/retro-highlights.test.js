/**
 * tests/retro-highlights.test.js
 *
 * WORK-TODO #14: the Friday 17:00 retro's content reaches story-bot's 18:00 LinkedIn
 * draft. Before, lib/watercooler.js's milestone bulletin carried a participant count
 * and nothing anyone said, and story-bot's context showed only that one line. Real
 * lib/watercooler.js and lib/bulletin-board.js on a temp bulletin file; the model and
 * the registry are doubles.
 */

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

jest.mock('../lib/llm-runner', () => ({ runLLM: jest.fn() }));
jest.mock('../lib/agent-registry', () => ({
    loadAgents: jest.fn().mockReturnValue([
        { id: 'secretary', name: 'Secretary', role: 'r', personality: 'p', system_prompt: 's', llm_provider: 'claude' },
        { id: 'jester', name: 'The Jester', role: 'r', personality: 'p', system_prompt: 's', llm_provider: 'claude' },
    ]),
    getActiveAgents: jest.fn().mockReturnValue([]),
    getAgent: jest.fn(),
}));

const { runLLM } = require('../lib/llm-runner');
const bulletinBoard = require('../lib/bulletin-board');
const watercooler = require('../lib/watercooler');
const { buildStoryBotContext } = require('../lib/agent-context-voices');

let dir;
beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'retro-highlights-'));
    bulletinBoard.init({ bulletinFile: path.join(dir, 'bulletin.json') });
    watercooler.init({ stateFile: path.join(dir, 'watercooler-state.json') });
    jest.spyOn(console, 'log').mockImplementation(() => {});
    jest.spyOn(global, 'setTimeout').mockImplementation((fn) => { fn(); return 0; });
    runLLM.mockImplementation(async (prompt) => ({
        output: prompt.includes('Jester') ? 'Grade: B. MVP the secretary.' : 'We shipped curbside pickup and sold out of the raw food line.',
        hitMaxTurns: false,
    }));
});
afterEach(() => {
    jest.restoreAllMocks();
    bulletinBoard.init();
    watercooler.init();
    fs.rmSync(dir, { recursive: true, force: true });
});

const slack = () => ({ chat: { postMessage: jest.fn().mockResolvedValue({ ok: true }) } });

test('the retro milestone bulletin records what each agent said', async () => {
    await watercooler.runStandup(slack(), 'C_OPS', 'retro');
    const [m] = bulletinBoard.getBulletins({ type: 'milestone' });
    expect(m.data.standupType).toBe('retro');
    expect(m.data.highlights).toEqual([
        { agent: 'Secretary', text: 'We shipped curbside pickup and sold out of the raw food line.' },
        { agent: 'The Jester', text: 'Grade: B. MVP the secretary.' },
    ]);
});

test('a highlight is capped, so one long answer cannot fill the bulletin file', async () => {
    runLLM.mockResolvedValue({ output: 'x'.repeat(5000), hitMaxTurns: false });
    await watercooler.runStandup(slack(), 'C_OPS', 'retro');
    const [m] = bulletinBoard.getBulletins({ type: 'milestone' });
    for (const h of m.data.highlights) expect(h.text.length).toBe(watercooler.HIGHLIGHT_CHARS);
});

test("story-bot's context carries the latest retro's highlights", async () => {
    await watercooler.runStandup(slack(), 'C_OPS', 'retro');
    const ctx = buildStoryBotContext();
    expect(ctx).toContain("THIS WEEK'S RETRO");
    expect(ctx).toContain('- Secretary: We shipped curbside pickup');
    expect(ctx).toContain('- The Jester: Grade: B.');
});

test('negative control: a milestone without highlights (the pre-#14 shape) adds no retro section', () => {
    bulletinBoard.postBulletin('watercooler', 'milestone', {
        description: 'Retro Standup completed: 2 agents participated', standupType: 'retro', participants: [], errors: 0,
    });
    const ctx = buildStoryBotContext();
    expect(ctx).toContain('Retro Standup completed');
    expect(ctx).not.toContain("THIS WEEK'S RETRO");
});

test('a kickoff is not presented as the retro', async () => {
    await watercooler.runStandup(slack(), 'C_OPS', 'kickoff');
    expect(buildStoryBotContext()).not.toContain("THIS WEEK'S RETRO");
});
