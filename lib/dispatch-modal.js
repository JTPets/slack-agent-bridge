'use strict';

/**
 * lib/dispatch-modal.js
 *
 * The FORM half of the slash-command dispatch path: the five-input modal, and the
 * two translations either side of it — reading a submission back out of Slack's
 * payload shape, and turning a per-field rejection into Slack's per-field error map.
 *
 * LOGIC CHANGE 2026-09-15: New file. Part two of the change described in
 * docs/WIRING-AND-SEAMS.md section 7 ("What the NEXT change has to do", step 3).
 * Split out of lib/dispatch-command.js so neither file breaks the repo's 300-line
 * rule (`npm run validate`); the handlers live there, the form lives here, and the
 * generator they share lives in lib/dispatch-message.js.
 *
 * FIVE SEPARATE INPUTS IS THE ENTIRE POINT. A dispatch pasted as a multi-line block
 * can be flattened onto one line by Slack, at which point the labels stop being
 * line-anchored and REPO: swallows the rest of the message. Nothing typed into one
 * input can merge two fields.
 */

const { FIELD_KEYS, DISPATCH_DEFAULT_TURNS } = require('./dispatch-message');
const { MIN_TURNS, MAX_TURNS } = require('./task-parser');
const { getConfiguredRepos } = require('./config');

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
    // LOGIC CHANGE 2026-09-15: a SELECT sourced from REPOS, not a hardcoded
    // placeholder — adding a repository is a config change, not an edit to this file.
    // It stays OPTIONAL: a task with no repository is a legitimate dispatch and REPO:
    // is optional in the parser, so a select with no "none" would have made an
    // optional field mandatory. Validation does NOT move: the submitted payload is
    // whatever Slack sends, so a select is a convenience, never a boundary.
    select: true,
    options: () => getConfiguredRepos(),
    placeholder: 'Pick a repository, or leave blank',
    hint: 'Sourced from REPOS in the environment. Leave blank for a task with no repository.',
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
    // LOGIC CHANGE 2026-09-15: the form's default is the CEILING, not the parser's 50
    // (the convention is TURNS: 100 — docs/EXECUTOR-CONTRACT.md §7 — and the old
    // default cost three runs half their budget). The default and the ceiling cannot
    // disagree because they are the SAME CONSTANT: DISPATCH_DEFAULT_TURNS is defined
    // as MAX_TURNS, which is what validateDispatchFields rejects against. A default
    // above its own ceiling is not expressible. The tests assert that identity, not 100.
    placeholder: String(DISPATCH_DEFAULT_TURNS),
    initial: String(DISPATCH_DEFAULT_TURNS),
    hint: `A whole number between ${MIN_TURNS} and ${MAX_TURNS}. Defaults to ${DISPATCH_DEFAULT_TURNS}.`,
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
function buildInputBlock(key, initialValues = {}) {
  const spec = FIELD_SPECS[key];
  let element;

  if (spec.select) {
    // Slack caps a static select at 100 options and REJECTS an empty options array,
    // so a mis-set REPOS would stop the modal opening at all. Falling back to a text
    // input keeps /dispatch working with a degraded field — and that field is the one
    // this replaced, so nothing is lost.
    const options = (spec.options() || []).slice(0, 100);
    if (options.length === 0) {
      element = {
        type: 'plain_text_input',
        action_id: ACTION_ID,
        multiline: false,
        max_length: 140,
        placeholder: { type: 'plain_text', text: 'owner/name' },
      };
    } else {
      element = {
        type: 'static_select',
        action_id: ACTION_ID,
        placeholder: { type: 'plain_text', text: spec.placeholder },
        options: options.map(value => ({
          text: { type: 'plain_text', text: value },
          value,
        })),
      };
      // Pre-fill only with an option the select offers: Slack rejects an
      // initial_option absent from `options`, so a repository since removed from
      // REPOS would fail the modal open rather than be quietly re-sent.
      const wanted = initialValues[key];
      if (wanted && options.includes(wanted)) {
        element.initial_option = { text: { type: 'plain_text', text: wanted }, value: wanted };
      }
    }
  } else {
    element = {
      type: 'plain_text_input',
      action_id: ACTION_ID,
      multiline: spec.multiline,
      max_length: spec.maxLength,
      placeholder: { type: 'plain_text', text: spec.placeholder },
    };
    // LOGIC CHANGE 2026-09-15: an explicit initial value (a re-run pre-fill) wins
    // over the spec's default. Truncated to the field's own max_length, because
    // Slack rejects an initial_value longer than it.
    const wanted = initialValues[key];
    const initial = (typeof wanted === 'string' && wanted) ? wanted : spec.initial;
    if (initial) element.initial_value = String(initial).slice(0, spec.maxLength);
  }

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
  // LOGIC CHANGE 2026-09-15: `context.initial` pre-fills the form. YES, the modal can
  // be opened pre-filled from a previous dispatch — every element Slack offers here
  // supports it (`initial_value` on a text input, `initial_option` on a static
  // select), which is why re-running with one line changed is a form concern and not
  // a new mechanism. What does NOT exist is the STORE: nothing records a previous
  // submission, so there is no "last dispatch" to pass in. That is a persisted file
  // and a retention rule, and it is a separate change — this parameter is the seam
  // it would plug into, exercised by the tests and by nothing in production yet.
  const initial = (context && context.initial) || {};
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
    blocks: FIELD_KEYS.map(key => buildInputBlock(key, initial)),
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
    // LOGIC CHANGE 2026-09-15: a static_select reports its value under
    // `selected_option.value`, not `value`. Reading both keeps this function
    // element-agnostic, so the repo field falling back to a text input (an empty
    // REPOS list) needs no branch here and cannot be read as blank by accident.
    if (typeof element.value === 'string') {
      out[key] = element.value;
    } else if (element.selected_option && typeof element.selected_option.value === 'string') {
      out[key] = element.selected_option.value;
    } else {
      out[key] = '';
    }
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
};
