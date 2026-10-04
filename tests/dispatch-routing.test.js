'use strict';

/**
 * tests/dispatch-routing.test.js
 *
 * WORK-TODO #46 and the cheap half of #4 (2026-10-04). /dispatch posts to the channel it
 * was opened in when the poll loop watches that channel, so the task runs as that
 * channel's agent; anywhere else it is REFUSED in the form, never redirected to the
 * bridge channel. After a successful post the onDispatched hook runs once, which
 * bridge-agent.js uses to poll immediately.
 */

const fs = require('fs');
const path = require('path');
const { handleViewSubmission, resolveDispatchTarget } = require('../lib/dispatch-command');
const { CALLBACK_ID, BLOCK_IDS, ACTION_ID } = require('../lib/dispatch-modal');
const { FIELD_KEYS } = require('../lib/dispatch-message');

const silent = { log: () => {}, warn: () => {}, error: () => {} };
const isAuthorized = (id) => id === 'U_OWNER';
const POLL_SET = [
  { channelId: 'C_BRIDGE', agentId: 'bridge' },
  { channelId: 'C_SECRETARY', agentId: 'secretary' },
];
const good = {
  task: 'Fix the thing', repo: 'jtpets/slack-agent-bridge', branch: 'main', turns: '50',
  instructions: 'Do the work.',
};

function body(invokingChannel) {
  const values = {};
  for (const key of FIELD_KEYS) values[BLOCK_IDS[key]] = { [ACTION_ID]: { value: good[key] } };
  return {
    user: { id: 'U_OWNER' },
    view: {
      callback_id: CALLBACK_ID,
      private_metadata: JSON.stringify({ channelId: invokingChannel, userId: 'U_OWNER' }),
      state: { values },
    },
  };
}

async function submit(invokingChannel, extra = {}) {
  const ack = jest.fn(async () => {});
  const postMessage = jest.fn(async () => ({ ok: true }));
  const notify = jest.fn(async () => {});
  const result = await handleViewSubmission(
    { ack, body: body(invokingChannel) },
    { postMessage, isAuthorized, notify, watchedChannels: () => POLL_SET, logger: silent, ...extra }
  );
  return { ack, postMessage, notify, result };
}

describe('the post goes where the form was opened', () => {
  test("an agent's channel: posted there, so the task runs as that agent", async () => {
    const { postMessage, result } = await submit('C_SECRETARY');
    expect(postMessage.mock.calls[0][0].channel).toBe('C_SECRETARY');
    expect(result).toMatchObject({ posted: true, channel: 'C_SECRETARY', agentId: 'secretary' });
  });

  test('the bridge channel still posts to the bridge channel', async () => {
    const { postMessage } = await submit('C_BRIDGE');
    expect(postMessage.mock.calls[0][0].channel).toBe('C_BRIDGE');
  });

  test('an unwatched channel (or a DM) is refused in the form, and NOT redirected to the bridge', async () => {
    const { ack, postMessage, notify, result } = await submit('D_SOME_DM');
    expect(result.reason).toBe('unwatched_channel');
    expect(postMessage).not.toHaveBeenCalled(); // the old code posted to the bridge channel here
    const payload = ack.mock.calls[0][0];
    expect(payload.response_action).toBe('errors'); // the modal stays open, nothing typed is lost
    expect(payload.errors[BLOCK_IDS.instructions]).toMatch(/does not poll/);
    expect(notify).not.toHaveBeenCalled(); // an operator choice, shown to the operator
  });

  test('a poll set that cannot be read is refused and escalated, never guessed', async () => {
    const { postMessage, notify, result } = await submit('C_BRIDGE', {
      watchedChannels: () => { throw new Error('agents.json unreadable'); },
    });
    expect(result.reason).toBe('no_channel');
    expect(postMessage).not.toHaveBeenCalled();
    expect(notify).toHaveBeenCalledTimes(1);
  });

  test('resolveDispatchTarget matches by id only (negative control: no prefix match)', () => {
    expect(resolveDispatchTarget('C_BRIDGE', POLL_SET)).toMatchObject({ ok: true, agentId: 'bridge' });
    expect(resolveDispatchTarget('C_BRIDG', POLL_SET).ok).toBe(false);
    expect(resolveDispatchTarget('', POLL_SET).ok).toBe(false);
  });
});

describe('onDispatched: an immediate poll after a post', () => {
  test('runs once after a successful post, after the ack', async () => {
    const order = [];
    const onDispatched = jest.fn(() => order.push('hook'));
    const ack = jest.fn(async () => order.push('ack'));
    await handleViewSubmission(
      { ack, body: body('C_SECRETARY') },
      { postMessage: async () => ({}), isAuthorized, watchedChannels: () => POLL_SET, onDispatched, logger: silent }
    );
    expect(onDispatched).toHaveBeenCalledWith({ channelId: 'C_SECRETARY', agentId: 'secretary' });
    expect(order).toEqual(['ack', 'hook']);
  });

  test('does not run for a refused or failed submission', async () => {
    const onDispatched = jest.fn();
    await submit('D_SOME_DM', { onDispatched });
    await submit('C_BRIDGE', { onDispatched, postMessage: async () => { throw new Error('channel_not_found'); } });
    expect(onDispatched).not.toHaveBeenCalled();
  });

  test('a throwing hook cannot turn a posted task into a reported failure', async () => {
    const { result } = await submit('C_BRIDGE', { onDispatched: () => { throw new Error('boom'); } });
    expect(result.posted).toBe(true);
  });
});

describe('bridge-agent.js wires both', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'bridge-agent.js'), 'utf8');
  test('the poll set is the watched set, and a post triggers pollNow', () => {
    expect(src).toMatch(/watchedChannels:\s*\(\)\s*=>\s*channelsToPoll/);
    expect(src).toMatch(/onDispatched:\s*\(\)\s*=>\s*pollNow\('dispatch'\)/);
  });
  test('the fixed bridge-channel target is gone from the submission handler', () => {
    const wiring = src.slice(src.indexOf('handleViewSubmission(envelope'), src.indexOf('.then((handle)'));
    expect(wiring.length).toBeGreaterThan(100);
    expect(wiring).not.toMatch(/bridgeChannel/);
  });
});
