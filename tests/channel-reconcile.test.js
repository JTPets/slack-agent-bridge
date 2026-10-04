'use strict';

/**
 * tests/channel-reconcile.test.js - WORK-TODO #52: channels vs agents, both directions.
 */

const { listMemberChannels, reconcileChannels, formatReconciliation } = require('../lib/channel-reconcile');
const { runCommand } = require('../lib/command-router');

const AGENTS = [
  { id: 'bridge', channel: 'C_BRIDGE', channel_name: 'claude-bridge' },
  { id: 'secretary', channel: 'C_SEC', channel_name: 'secretary-agent' },
  { id: 'jester', channel: null, channel_name: 'jester-agent' },
  { id: 'storefront', channel: 'C_STORE', channel_name: 'storefront', status: 'planned' },
];
const ENV = { BRIDGE_CHANNEL_ID: 'C_BRIDGE', OPS_CHANNEL_ID: 'C_OPS' };
const MEMBER = [
  { id: 'C_BRIDGE', name: 'claude-bridge' },
  { id: 'C_SEC', name: 'secretary-agent' },
  { id: 'C_OPS', name: 'sqtools-ops' },
  { id: 'C_OLD', name: 'bot-memory' },
];

describe('reconcileChannels', () => {
  const r = reconcileChannels({ memberChannels: MEMBER, agents: AGENTS, env: ENV });

  test('a channel owned by an agent or an env var is owned, with every owner named', () => {
    expect(r.owned.find((c) => c.id === 'C_BRIDGE').owners).toEqual(['agent bridge', 'BRIDGE_CHANNEL_ID']);
    expect(r.owned.find((c) => c.id === 'C_OPS').owners).toEqual(['OPS_CHANNEL_ID']);
  });

  test('direction two: a channel the bot is in that nothing owns', () => {
    expect(r.unowned.map((c) => c.name)).toEqual(['bot-memory']);
  });

  test('direction one: an agent channel the bot is not in, and an agent with no resolved channel', () => {
    expect(r.agentsNotMember.map((a) => a.id)).toEqual(['storefront']);
    expect(r.agentsUnresolved.map((a) => a.id)).toEqual(['jester']);
  });

  test('the text says private channels were not looked at', () => {
    expect(formatReconciliation(r)).toMatch(/groups:read/);
    expect(formatReconciliation(r)).toMatch(/#bot-memory/);
  });
});

describe('listMemberChannels', () => {
  test('pages until the cursor is empty and keeps only channels the bot is in', async () => {
    const list = jest.fn()
      .mockResolvedValueOnce({ channels: [{ id: 'A', name: 'a', is_member: true }, { id: 'B', name: 'b', is_member: false }], response_metadata: { next_cursor: 'x' } })
      .mockResolvedValueOnce({ channels: [{ id: 'C', name: 'c', is_member: true }], response_metadata: { next_cursor: '' } });
    const out = await listMemberChannels({ conversations: { list } });
    expect(out.map((c) => c.id)).toEqual(['A', 'C']);
    expect(list.mock.calls[1][0].cursor).toBe('x');
    expect(list.mock.calls[0][0].types).toBe('public_channel');
  });

  test('an unfinished list throws rather than returning a partial one', async () => {
    const list = jest.fn().mockResolvedValue({ channels: [], response_metadata: { next_cursor: 'again' } });
    await expect(listMemberChannels({ conversations: { list } }, 3)).rejects.toThrow(/not finished/);
  });
});

describe('the `channels` verb', () => {
  test('a Slack failure is reported as a failure, not an empty workspace', async () => {
    const slack = { conversations: { list: async () => { throw new Error('missing_scope'); } } };
    const r = await runCommand('channels', { slack });
    expect(r).toMatchObject({ handled: true, ok: false });
    expect(r.text).toMatch(/missing_scope/);
  });

  test('it writes nothing: the module names no mutating Slack API', () => {
    const src = require('fs').readFileSync(require.resolve('../lib/channel-reconcile'), 'utf8');
    expect(src).not.toMatch(/conversations\.(join|create|leave|invite|archive)|chat\.post/);
  });
});
