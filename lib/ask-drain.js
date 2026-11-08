'use strict';

/**
 * lib/ask-drain.js
 *
 * WORK-TODO #71, the owner's answer of 2026-11-08: "it should let the code finish its loop
 * but halt new asks from starting." While a self-update is pending, a NEW question that
 * would go to a model is refused, exactly as a new TASK: already is (lib/update-drain.js),
 * so the update waits for the one piece of work in flight and no longer.
 *
 * LOGIC CHANGE 2026-11-08: new file.
 *
 * What is NOT refused: a built-in command (a lib/command-router.js verb, or the
 * `what's queued` status query). Those answer from code in a moment and call no model,
 * and they are how the owner sees what the update is waiting for, or clears a lock it is
 * stuck behind (`ASK: lock clear`). Refusing them would make a stuck update harder to
 * diagnose. Natural-conversation messages (no `ASK:`) are always model work and refused.
 *
 * Pure: decides and builds text, posts nothing.
 */

const { parseCommand } = require('./command-router');
const { isStatusQuery } = require('./task-parser');

/**
 * @param {string} text - the raw Slack message text
 * @returns {boolean} true when answering it needs no model
 */
function isBuiltInAsk(text) {
    if (typeof text !== 'string' || !/^\s*ASK:/i.test(text)) return false;
    const body = text.replace(/^\s*ASK:\s*/i, '').trim();
    return Boolean(parseCommand(body).verb) || isStatusQuery(body);
}

/**
 * @param {{ text: string, drain: { refuse: boolean, state: object } }} p
 * @returns {boolean}
 */
function shouldRefuseAsk({ text, drain }) {
    return Boolean(drain && drain.refuse) && !isBuiltInAsk(text);
}

function describeAskRefusal(state = {}) {
    const short = state.commit ? `\`${String(state.commit).slice(0, 7)}\`` : '(unknown commit)';
    return (
        ':no_entry: *Not answered: a self-update is about to apply.*\n'
        + `Update ${short} passed the test gate and is waiting for the work already in progress to finish. `
        + 'New questions are held off so it does not wait on them too. '
        + '**Ask again in a few minutes,** after the bridge restarts. Built-in commands such as '
        + '`ASK: what\'s queued` and `ASK: lock` still answer now.'
    );
}

module.exports = { isBuiltInAsk, shouldRefuseAsk, describeAskRefusal };
