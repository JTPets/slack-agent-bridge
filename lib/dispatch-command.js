'use strict';

/**
 * lib/dispatch-command.js
 *
 * The COMMAND and FORM halves of the slash-command dispatch path: the modal the
 * command opens, and the handlers that attach at the seam marked THE COMMAND SEAM
 * in lib/slack-socket.js. The generator it feeds is lib/dispatch-message.js.
 *
 * LOGIC CHANGE 2026-09-15: New file. Parts one, two and four of the change described
 * in docs/WIRING-AND-SEAMS.md section 7 ("What the NEXT change has to do").
 *
 * WHERE THE TASK ENTERS THE PIPELINE - the decision step 6 of that section asks for,
 * stated: the form composes a well-formed task message and POSTS IT TO THE BRIDGE
 * CHANNEL. poll() picks it up like any other message. It does NOT call processTask.
 * One intake path, one owner of deduplication (lib/bridge-state.js, by message ts),
 * one task that survives a restart because it exists as a message. The cost is up to
 * POLL_INTERVAL_MS of latency, paid against work that runs for ten minutes.
 *
 * AUTHORISATION IS THIS MODULE'S, NOT THE POLL LOOP'S. The poll loop's allowlist
 * check is `!isUserAuthorized(msg.user) && !isBotMessage` (bridge-agent.js) - a
 * message posted AS THE BOT bypasses it, deliberately, so scheduled tasks are not
 * dropped. Our post is a bot post. So the gate here is the only gate, and it must
 * run before anything is posted. It calls the SAME isUserAuthorized from
 * lib/config.js that the poll loop calls; this is a second call site, not a second
 * check, and it is checked again on submission because a view_submission arrives as
 * its own envelope rather than as a continuation of the command.
 *
 * THE THREE-SECOND RULE. Slack expires a command's `trigger_id` and its
 * acknowledgement window at about three seconds; a late ack shows the operator a
 * timeout with no trace of the cause. So: ack first, open the modal after. On
 * submission the order is inverted deliberately - see handleViewSubmission.
 */

const { composeDispatchMessage, FIELD_KEYS } = require('./dispatch-message');
const { DEFAULT_TURNS, MIN_TURNS, MAX_TURNS } = require('./task-parser');

// The command the Slack app must be configured with. Registering it is an owner
// action outside this repository - see docs/WIRING-AND-SEAMS.md section 7.
const COMMAND_NAME = '/dispatch';

// Identifies OUR modal on the way back. A view_submission for any other callback_id
// belongs to someone else and is acknowledged without being acted on.
const CALLBACK_ID = 'bridge_dispatch_modal';

// Every input block carries one element under this action_id, so extraction is
// uniform and needs no per-field special case.
const ACTION_ID = 'value';

// block_id per field. Slack keys BOTH the submitted values and the per-field error
// map by block_id, so this map is what makes "tell the user which field and why"
// land on the right input.
const BLOCK_IDS = {
  task: 'dispatch_task',
  repo: 'dispatch_repo',
  branch: 'dispatch_branch',
  turns: 'dispatch_turns',
  instructions: 'dispatch_instructions',
};

// Built from FIELD_KEYS so a field cannot exist in the generator and not the form.
const FIELD_SPECS = {
  task: {
    label: 'Task',
    optional: false,
    multiline: false,
    maxLength: 150,
    placeholder: 'Short description of the task',
    hint: 'One line. This becomes the TASK: field.',
  },
  repo: {
    label: 'Repository',
    optional: true,
    multiline: false,
    maxLength: 140,
    placeholder: 'JTPets/slack-agent-bridge',
    hint: 'owner/name, or a GitHub URL. Leave blank for a task with no repository.',
  },
  branch: {
    label: 'Branch',
    optional: true,
    multiline: false,
    maxLength: 255,
    placeholder: 'main',
    initial: 'main',
    hint: 'The branch to CLONE FROM, not one to create. Defaults to main.',
  },
  turns: {
    label: 'Turn budget',
    optional: true,
    multiline: false,
    maxLength: 3,
    placeholder: String(DEFAULT_TURNS),
    initial: String(DEFAULT_TURNS),
    hint: `A whole number between ${MIN_TURNS} and ${MAX_TURNS}. Defaults to ${DEFAULT_TURNS}.`,
  },
  instructions: {
    label: 'Instructions',
    optional: false,
    multiline: true,
    maxLength: 3000,
    placeholder: 'What to do, in as much detail as the task needs.',
    hint: 'Multiline. No line may START with TASK:, REPO:, BRANCH:, TURNS:, SKILL: or INSTRUCTIONS:.',
  },
};

/**
 * Build one Slack input block for a field.
 * @param {string} key - A member of FIELD_KEYS.
 * @returns {object} A Slack Block Kit input block.
 */
function buildInputBlock(key) {
  const spec = FIELD_SPECS[key];
  const element = {
    type: 'plain_text_input',
    action_id: ACTION_ID,
    multiline: spec.multiline,
    max_length: spec.maxLength,
    placeholder: { type: 'plain_text', text: spec.placeholder },
  };
  if (spec.initial) element.initial_value = spec.initial;

  return {
    type: 'input',
    block_id: BLOCK_IDS[key],
    optional: spec.optional,
    label: { type: 'plain_text', text: spec.label },
    hint: { type: 'plain_text', text: spec.hint },
    element,
  };
}

/**
 * Build the modal view. FIVE separate inputs is the entire point: nothing an
 * operator types into one of them can merge two fields, which is what a flattened
 * pasted block does.
 *
 * @param {object} [context] - { channelId, userId } recorded in private_metadata so
 *   a failure on submission can be reported back where the command was invoked.
 * @returns {object} A Slack view payload.
 */
function buildModalView(context = {}) {
  return {
    type: 'modal',
    callback_id: CALLBACK_ID,
    title: { type: 'plain_text', text: 'Dispatch a task' },
    submit: { type: 'plain_text', text: 'Dispatch' },
    close: { type: 'plain_text', text: 'Cancel' },
    // Slack echoes this back on submission. It carries no secret and no value the
    // operator typed - only where the command came from, for error reporting.
    private_metadata: JSON.stringify({
      channelId: context.channelId || '',
      userId: context.userId || '',
    }),
    blocks: FIELD_KEYS.map(buildInputBlock),
  };
}

/**
 * Read the submitted view's private_metadata without trusting its shape.
 * @param {object} view
 * @returns {{ channelId: string, userId: string }}
 */
function readPrivateMetadata(view) {
  try {
    const parsed = JSON.parse((view && view.private_metadata) || '{}');
    return {
      channelId: typeof parsed.channelId === 'string' ? parsed.channelId : '',
      userId: typeof parsed.userId === 'string' ? parsed.userId : '',
    };
  } catch {
    return { channelId: '', userId: '' };
  }
}

/**
 * Pull the five raw values out of a view_submission payload.
 *
 * Every value is returned as a string, including an absent one, so the validator in
 * lib/dispatch-message.js has a single shape to reason about. An optional input the
 * operator left blank arrives as null from Slack, not as "".
 *
 * @param {object} view - `body.view` from a view_submission envelope.
 * @returns {object} Keyed by FIELD_KEYS.
 */
function extractSubmission(view) {
  const state = (view && view.state && view.state.values) || {};
  const out = {};
  for (const key of FIELD_KEYS) {
    const block = state[BLOCK_IDS[key]] || {};
    const element = block[ACTION_ID] || {};
    out[key] = typeof element.value === 'string' ? element.value : '';
  }
  return out;
}

/**
 * Turn the validator's per-field errors into Slack's per-field error map.
 * Keys must be block_ids, or Slack silently shows nothing - which would be the
 * "silently posting a malformed message" failure wearing a different hat.
 *
 * @param {object} errors - Keyed by FIELD_KEYS.
 * @returns {object} Keyed by block_id.
 */
function toSlackErrors(errors) {
  const out = {};
  for (const key of FIELD_KEYS) {
    if (errors[key]) {
      // Slack truncates a field error at 250 characters; cut it here so the reason
      // is not lost mid-word server-side.
      out[BLOCK_IDS[key]] = String(errors[key]).slice(0, 250);
    }
  }
  return out;
}

module.exports = {
  COMMAND_NAME,
  CALLBACK_ID,
  ACTION_ID,
  BLOCK_IDS,
  FIELD_SPECS,
  buildInputBlock,
  buildModalView,
  readPrivateMetadata,
  extractSubmission,
  toSlackErrors,
  composeDispatchMessage,
};
