'use strict';

/**
 * tests/dispatch-failure-paths.test.js
 *
 * Part four of the slash-command dispatch form: what the operator sees when
 * something goes wrong. Split out of tests/dispatch-command.test.js to keep both
 * files under the repo's 300-line rule (`npm run validate`).
 *
 * The property under test throughout: a failure must never look like success. A
 * command that fails AFTER its acknowledgement, a field the validator refused, and a
 * channel post that fails or outlives the acknowledgement window each have to reach
 * the operator — in the form where possible, so nothing they typed is lost.
 */

const {
  COMMAND_NAME,
  CALLBACK_ID,
  SUBMIT_POST_TIMEOUT_MS,
  raceWithTimeout,
  handleSlashCommand,
  handleViewSubmission,
} = require('../lib/dispatch-command');

const { BLOCK_IDS, ACTION_ID } = require('../lib/dispatch-modal');
const { FIELD_KEYS } = require('../lib/dispatch-message');
const { parseTask } = require('../lib/task-parser');

const silent = { log: () => {}, warn: () => {}, error: () => {} };
const AUTHORIZED = 'U_OWNER';
const isAuthorized = (id) => id === AUTHORIZED;

function commandBody(overrides = {}) {
  return {
    command: COMMAND_NAME,
    user_id: AUTHORIZED,
    channel_id: 'C_CMD',
    trigger_id: 'TRIGGER.123',
    text: '',
    ...overrides,
  };
}

function submissionBody(values, overrides = {}) {
  const state = { values: {} };
  for (const key of FIELD_KEYS) {
    state.values[BLOCK_IDS[key]] = {
      [ACTION_ID]: { type: 'plain_text_input', value: values[key] === undefined ? null : values[key] },
    };
  }
  return {
    type: 'view_submission',
    user: { id: AUTHORIZED },
    view: {
      callback_id: CALLBACK_ID,
      private_metadata: JSON.stringify({ channelId: 'C_CMD', userId: AUTHORIZED }),
      state,
    },
    ...overrides,
  };
}

const goodValues = {
  task: 'Add the missing regression test',
  repo: 'JTPets/slack-agent-bridge',
  branch: 'main',
  turns: '100',
  instructions: 'Read the contract.\nThen write the test.',
};

// ---------------------------------------------------------------------------
// PART FOUR — failure paths
// ---------------------------------------------------------------------------
describe('a failure after the acknowledgement reaches the operator', () => {
  test('views.open failing posts an ephemeral to the operator AND escalates to ops', async () => {
    const postEphemeral = jest.fn(async () => {});
    const notify = jest.fn(async () => {});

    const result = await handleSlashCommand(
      { ack: async () => {}, body: commandBody() },
      {
        openView: async () => { throw new Error('trigger_id expired'); },
        isAuthorized, postEphemeral, notify, logger: silent,
      }
    );

    expect(result).toEqual({ opened: false, reason: 'open_failed' });
    expect(postEphemeral).toHaveBeenCalledTimes(1);
    expect(postEphemeral.mock.calls[0][0].user).toBe(AUTHORIZED);
    expect(postEphemeral.mock.calls[0][0].text).toMatch(/trigger_id expired/);
    expect(notify).toHaveBeenCalledTimes(1);
  });

  test('if the operator cannot be reached either, a human is still told and nothing throws', async () => {
    const notify = jest.fn(async () => {});
    await expect(handleSlashCommand(
      { ack: async () => {}, body: commandBody() },
      {
        openView: async () => { throw new Error('boom'); },
        postEphemeral: async () => { throw new Error('not_in_channel'); },
        isAuthorized, notify, logger: silent,
      }
    )).resolves.toEqual({ opened: false, reason: 'open_failed' });
    expect(notify).toHaveBeenCalled();
  });

  test('an ack that itself throws does not propagate out of the handler', async () => {
    await expect(handleSlashCommand(
      { ack: async () => { throw new Error('envelope gone'); }, body: commandBody() },
      { openView: async () => {}, isAuthorized, logger: silent }
    )).resolves.toBeDefined();
  });
});

describe('a rejected field is reported IN THE FORM, not posted', () => {
  test('a bad repo keeps the modal open with the reason on the repo input', async () => {
    const ack = jest.fn(async () => {});
    const postMessage = jest.fn(async () => {});

    const result = await handleViewSubmission(
      { ack, body: submissionBody({ ...goodValues, repo: 'jtpets/my;repo' }) },
      { postMessage, isAuthorized, bridgeChannel: 'C_BRIDGE', logger: silent }
    );

    expect(result.reason).toBe('rejected');
    expect(postMessage).not.toHaveBeenCalled();
    const payload = ack.mock.calls[0][0];
    expect(payload.response_action).toBe('errors');
    expect(Object.keys(payload.errors)).toEqual([BLOCK_IDS.repo]);
    expect(payload.errors[BLOCK_IDS.repo]).toMatch(/^Rejected /);
  });

  test('several bad fields are all reported at once, each on its own input', async () => {
    const ack = jest.fn(async () => {});
    const result = await handleViewSubmission(
      // "no" would NORMALISE to "jtpets/no" and pass — the bare-name default org is
      // the parser's own behaviour. "no;repo" is rejected by the identifier module.
      { ack, body: submissionBody({ task: '', repo: 'no;repo', branch: '..x', turns: 'many', instructions: '' }) },
      { postMessage: async () => {}, isAuthorized, bridgeChannel: 'C_BRIDGE', logger: silent }
    );
    expect(result.reason).toBe('rejected');
    expect(Object.keys(ack.mock.calls[0][0].errors).sort()).toEqual(
      FIELD_KEYS.map((k) => BLOCK_IDS[k]).sort()
    );
  });

  test('an instructions body carrying a field label is refused rather than posted', async () => {
    const postMessage = jest.fn(async () => {});
    const ack = jest.fn(async () => {});
    await handleViewSubmission(
      { ack, body: submissionBody({ ...goodValues, instructions: 'Do it.\nREPO: someone/else' }) },
      { postMessage, isAuthorized, bridgeChannel: 'C_BRIDGE', logger: silent }
    );
    expect(postMessage).not.toHaveBeenCalled();
    expect(ack.mock.calls[0][0].errors[BLOCK_IDS.instructions]).toMatch(/Line 2/);
  });
});

describe('the socket is connected but the channel post fails', () => {
  test('the modal STAYS OPEN with the failure named, and ops is told', async () => {
    const ack = jest.fn(async () => {});
    const notify = jest.fn(async () => {});

    const result = await handleViewSubmission(
      { ack, body: submissionBody(goodValues) },
      {
        postMessage: async () => { throw new Error('channel_not_found'); },
        isAuthorized, bridgeChannel: 'C_BRIDGE', notify, logger: silent,
      }
    );

    expect(result.reason).toBe('post_failed');
    const payload = ack.mock.calls[0][0];
    expect(payload.response_action).toBe('errors');
    expect(payload.errors[BLOCK_IDS.instructions]).toMatch(/Not dispatched.*channel_not_found/);
    expect(notify).toHaveBeenCalledTimes(1);
  });

  test('a post that exceeds the ack window reports the outcome as UNKNOWN, never as failed', async () => {
    // Claiming "failed" would invite a resubmission, and dedup is by message ts —
    // two posts are two tasks, each running for ten minutes.
    const ack = jest.fn(async () => {});
    const notify = jest.fn(async () => {});

    const result = await handleViewSubmission(
      { ack, body: submissionBody(goodValues) },
      {
        postMessage: () => new Promise(() => {}), // never settles
        isAuthorized, bridgeChannel: 'C_BRIDGE', notify, logger: silent, postTimeoutMs: 20,
      }
    );

    expect(result.reason).toBe('post_timeout');
    const text = ack.mock.calls[0][0].errors[BLOCK_IDS.instructions];
    expect(text).toMatch(/UNKNOWN/);
    expect(text).toMatch(/CHECK the bridge channel/);
    expect(text).not.toMatch(/Not dispatched/);
    expect(notify).toHaveBeenCalledTimes(1);
  });

  test('an unconfigured bridge channel is refused before any post is attempted', async () => {
    const postMessage = jest.fn(async () => {});
    const ack = jest.fn(async () => {});
    const result = await handleViewSubmission(
      { ack, body: submissionBody(goodValues) },
      { postMessage, isAuthorized, bridgeChannel: '', logger: silent }
    );
    expect(result.reason).toBe('no_channel');
    expect(postMessage).not.toHaveBeenCalled();
    expect(ack.mock.calls[0][0].errors[BLOCK_IDS.instructions]).toMatch(/BRIDGE_CHANNEL_ID/);
  });
});

describe('raceWithTimeout never leaves an unhandled rejection behind', () => {
  test('a post that fails AFTER the timeout is caught, not thrown at the process', async () => {
    // An async handler that rejects unobserved terminates Node 20+, which would let
    // this module kill the bridge — the one thing the socket contract forbids.
    let reject;
    const slow = new Promise((_, r) => { reject = r; });
    const warn = jest.fn();

    const outcome = await raceWithTimeout(slow, 10, { ...silent, warn });
    expect(outcome.state).toBe('timeout');

    reject(new Error('late failure'));
    await new Promise((r) => setTimeout(r, 20));
    expect(warn).toHaveBeenCalledWith(expect.stringMatching(/eventually failed: late failure/));
  });

  test('a post that succeeds after the timeout is logged as HAVING DISPATCHED', async () => {
    let resolve;
    const slow = new Promise((r) => { resolve = r; });
    const warn = jest.fn();

    await raceWithTimeout(slow, 10, { ...silent, warn });
    resolve({ ok: true });
    await new Promise((r) => setTimeout(r, 20));
    expect(warn).toHaveBeenCalledWith(expect.stringMatching(/eventually SUCCEEDED/));
  });

  test('the default post budget leaves headroom inside Slack’s three-second ack window', () => {
    expect(SUBMIT_POST_TIMEOUT_MS).toBeLessThan(3000);
  });
});
