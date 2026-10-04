'use strict';

/**
 * tests/task-history.test.js - WORK-TODO #9: `ASK: history [n]`.
 */

const fs = require('fs');
const { handleHistory, describeOutcome, MAX_COUNT } = require('../lib/task-history');
const { runCommand, listVerbs } = require('../lib/command-router');

const ENTRIES = [
  { description: 'Newest', repo: 'jtpets/slack-agent-bridge', status: 'completed', completedAt: '2026-10-04T18:05:00Z', outcome: { elapsed: 312 } },
  { description: 'Broke', status: 'failed', failedAt: '2026-10-04T16:00:00Z', error: 'npm test failed\nwith detail' },
  { description: 'Killed', status: 'completed', completedAt: '2026-10-03T12:00:00Z', outcome: { interrupted: true } },
];

describe('handleHistory', () => {
  test('asks for 10 by default and renders newest first, in Toronto time', async () => {
    const readHistory = jest.fn(() => ENTRIES);
    const { ok, text } = await handleHistory({ args: '' }, { readHistory });
    expect(ok).toBe(true);
    expect(readHistory).toHaveBeenCalledWith(10);
    expect(text.indexOf('Newest')).toBeLessThan(text.indexOf('Broke'));
    expect(text).toMatch(/Oct 4, 2:05 PM/); // 18:05Z is 14:05 in Toronto (EDT)
    expect(text).toMatch(/\(312s\)/);
    expect(text).toMatch(/all that are recorded; asked for 10/);
  });

  test('n is clamped to 1..MAX_COUNT', async () => {
    const readHistory = jest.fn(() => []);
    await handleHistory({ args: '500' }, { readHistory });
    await handleHistory({ args: '0' }, { readHistory });
    expect(readHistory.mock.calls).toEqual([[MAX_COUNT], [1]]);
  });

  test('a non-number is refused with usage, and nothing is read', async () => {
    const readHistory = jest.fn();
    const { ok, text } = await handleHistory({ args: 'of the repo' }, { readHistory });
    expect(ok).toBe(false);
    expect(text).toMatch(/Usage/);
    expect(readHistory).not.toHaveBeenCalled();
  });

  test('an unreadable memory is a failure, not an empty history', async () => {
    const { ok, text } = await handleHistory({}, { readHistory: () => { throw new Error('EACCES'); } });
    expect(ok).toBe(false);
    expect(text).toMatch(/EACCES/);
  });

  test('outcomes are named: failed with its error on one line, interrupted, max turns', () => {
    expect(describeOutcome(ENTRIES[1])).toMatch(/failed - npm test failed with detail/);
    expect(describeOutcome(ENTRIES[2])).toMatch(/interrupted/);
    expect(describeOutcome({ status: 'completed', outcome: { partial: true } })).toMatch(/max turns/);
  });
});

describe('memory-manager getTaskHistory', () => {
  test('returns the last n of history.json, newest first (read stubbed; the real file is never touched)', () => {
    const mm = require('../memory/memory-manager');
    const real = fs.readFileSync;
    const spy = jest.spyOn(fs, 'readFileSync').mockImplementation((file, ...rest) =>
      (String(file).endsWith('history.json')
        ? JSON.stringify([{ description: 'a' }, { description: 'b' }, { description: 'c' }])
        : real(file, ...rest)));
    try {
      expect(mm.getTaskHistory(2).map((e) => e.description)).toEqual(['c', 'b']);
      expect(mm.getTaskHistory(0)).toEqual([]);
    } finally {
      spy.mockRestore();
    }
  });
});

describe('the verb', () => {
  test('is registered as `history` and reachable through runCommand', async () => {
    expect(listVerbs()).toContain('history');
    const r = await runCommand('history abc');
    expect(r).toMatchObject({ handled: true, verb: 'history', ok: false });
  });
  test('`task status` is NOT captured by it (the reason it is not spelled `task history`)', async () => {
    expect((await runCommand('task status')).handled).toBe(false);
  });
});
