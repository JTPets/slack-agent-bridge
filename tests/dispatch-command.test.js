'use strict';

/**
 * tests/dispatch-command.test.js
 *
 * Part one of the slash-command dispatch form: the command handler and the
 * authorisation gate. Every test here fails without lib/dispatch-command.js.
 *
 * The properties under test: the acknowledgement goes out before anything slow, and
 * authorisation reuses the poll loop's own check rather than a second one. The
 * failure paths (part four) are in tests/dispatch-failure-paths.test.js.
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
// PART ONE — the command
// ---------------------------------------------------------------------------
describe('the slash command acknowledges first, then opens the form', () => {
  test('the ack is sent BEFORE the modal is opened', async () => {
    const order = [];
    const ack = jest.fn(async () => { order.push('ack'); });
    const openView = jest.fn(async () => { order.push('open'); });

    const result = await handleSlashCommand(
      { ack, body: commandBody() },
      { openView, isAuthorized, logger: silent }
    );

    expect(result).toEqual({ opened: true, reason: 'ok' });
    expect(order).toEqual(['ack', 'open']);
  });

  test('nothing slow runs before the ack — a hanging views.open cannot delay it', async () => {
    // The three-second rule made executable: the ack resolves while views.open is
    // still pending. A late ack shows the operator a timeout with no trace of why.
    let releaseOpen;
    const ack = jest.fn(async () => {});
    const openView = jest.fn(() => new Promise((resolve) => { releaseOpen = resolve; }));

    const pending = handleSlashCommand(
      { ack, body: commandBody() },
      { openView, isAuthorized, logger: silent }
    );

    await Promise.resolve();
    await Promise.resolve();
    expect(ack).toHaveBeenCalled();

    releaseOpen();
    await pending;
  });

  test('the ack carries no text, so nothing is echoed into the channel', async () => {
    const ack = jest.fn(async () => {});
    await handleSlashCommand(
      { ack, body: commandBody() },
      { openView: async () => {}, isAuthorized, logger: silent }
    );
    expect(ack).toHaveBeenCalledWith();
  });

  test('the modal is opened from the trigger_id Slack supplied', async () => {
    const openView = jest.fn(async () => {});
    await handleSlashCommand(
      { ack: async () => {}, body: commandBody({ trigger_id: 'TRIGGER.abc' }) },
      { openView, isAuthorized, logger: silent }
    );
    expect(openView.mock.calls[0][0].trigger_id).toBe('TRIGGER.abc');
    expect(openView.mock.calls[0][0].view.callback_id).toBe(CALLBACK_ID);
  });

  test('a missing trigger_id is reported, not passed to Slack as undefined', async () => {
    const ack = jest.fn(async () => {});
    const openView = jest.fn(async () => {});
    const result = await handleSlashCommand(
      { ack, body: commandBody({ trigger_id: '' }) },
      { openView, isAuthorized, logger: silent }
    );
    expect(result.reason).toBe('no_trigger_id');
    expect(openView).not.toHaveBeenCalled();
    expect(ack.mock.calls[0][0].text).toMatch(/trigger_id/);
  });
});

describe('authorisation reuses the existing allowlist check', () => {
  test('an unauthorized user gets an ephemeral refusal and no form', async () => {
    const ack = jest.fn(async () => {});
    const openView = jest.fn(async () => {});

    const result = await handleSlashCommand(
      { ack, body: commandBody({ user_id: 'U_STRANGER' }) },
      { openView, isAuthorized, logger: silent }
    );

    expect(result).toEqual({ opened: false, reason: 'unauthorized' });
    expect(openView).not.toHaveBeenCalled();
    expect(ack.mock.calls[0][0].response_type).toBe('ephemeral');
    expect(ack.mock.calls[0][0].text).toMatch(/ALLOWED_USER_IDS/);
  });

  test('the handler calls the injected check rather than reading an allowlist itself', async () => {
    const check = jest.fn(() => true);
    await handleSlashCommand(
      { ack: async () => {}, body: commandBody({ user_id: 'U_WHOEVER' }) },
      { openView: async () => {}, isAuthorized: check, logger: silent }
    );
    expect(check).toHaveBeenCalledWith('U_WHOEVER');
  });

  test('a submission from an unauthorized user is refused too — it is its own envelope', async () => {
    // A view_submission does not inherit the command's gate, and our post is a bot
    // post, which the poll loop lets through without an allowlist check.
    const ack = jest.fn(async () => {});
    const postMessage = jest.fn(async () => ({ ok: true }));

    const result = await handleViewSubmission(
      { ack, body: submissionBody(goodValues, { user: { id: 'U_STRANGER' } }) },
      { postMessage, isAuthorized, bridgeChannel: 'C_BRIDGE', logger: silent }
    );

    expect(result.reason).toBe('unauthorized');
    expect(postMessage).not.toHaveBeenCalled();
    expect(ack.mock.calls[0][0].response_action).toBe('errors');
  });
});

// ---------------------------------------------------------------------------
// The success path: a valid submission becomes a message the parser reads back
// ---------------------------------------------------------------------------
describe('a valid submission posts a parseable message to the bridge channel', () => {
  test('the post goes to the bridge channel and the modal then closes', async () => {
    const ack = jest.fn(async () => {});
    const postMessage = jest.fn(async () => ({ ok: true, ts: '1.1' }));

    const result = await handleViewSubmission(
      { ack, body: submissionBody(goodValues) },
      { postMessage, isAuthorized, bridgeChannel: 'C_BRIDGE', logger: silent }
    );

    expect(result.posted).toBe(true);
    expect(postMessage).toHaveBeenCalledTimes(1);
    expect(postMessage.mock.calls[0][0].channel).toBe('C_BRIDGE');
    // ack() with no payload closes the modal.
    expect(ack).toHaveBeenCalledWith();
  });

  test('what it posts round-trips through parseTask — the whole point of the change', async () => {
    const postMessage = jest.fn(async () => ({ ok: true }));
    await handleViewSubmission(
      { ack: async () => {}, body: submissionBody(goodValues) },
      { postMessage, isAuthorized, bridgeChannel: 'C_BRIDGE', logger: silent }
    );

    const parsed = parseTask(postMessage.mock.calls[0][0].text);
    expect(parsed.errors).toEqual([]);
    expect(parsed.repo).toBe('JTPets/slack-agent-bridge');
    expect(parsed.branch).toBe('main');
    expect(parsed.turns).toBe(100);
    expect(parsed.description).toBe(goodValues.task);
    expect(parsed.instructions).toBe(goodValues.instructions);
  });

  test('it does NOT call the task path directly — one intake path, one dedup owner', async () => {
    const processTask = jest.fn();
    const postMessage = jest.fn(async () => ({ ok: true }));
    await handleViewSubmission(
      { ack: async () => {}, body: submissionBody(goodValues) },
      { postMessage, processTask, isAuthorized, bridgeChannel: 'C_BRIDGE', logger: silent }
    );
    expect(processTask).not.toHaveBeenCalled();
  });

  test('a submission for someone else’s modal is acknowledged and ignored', async () => {
    const postMessage = jest.fn(async () => {});
    const ack = jest.fn(async () => {});
    const result = await handleViewSubmission(
      { ack, body: submissionBody(goodValues, { view: { callback_id: 'someone_elses_modal' } }) },
      { postMessage, isAuthorized, bridgeChannel: 'C_BRIDGE', logger: silent }
    );
    expect(result.reason).toBe('not_ours');
    expect(ack).toHaveBeenCalledWith();
    expect(postMessage).not.toHaveBeenCalled();
  });
});
