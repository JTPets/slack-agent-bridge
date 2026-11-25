'use strict';

/**
 * tests/helpers/task-path-sources.js
 *
 * WORK-TODO #10, B36 (2026-11-25): what the task-path guards read since processTask
 * became a hub over spokes. Before the split every one of them sliced processTask out of
 * bridge-agent.js; the steps now live in lib/task-*.js, so a guard reads the hub AND the
 * spoke that holds the step it is about.
 *
 *   HUB_PATH / hubBody(src)      processTask's body in bridge-agent.js
 *   SPOKES / SPOKE_FILES         every spoke, by name, in step order
 *   spokeSource(name)            one spoke's source
 *   functionBody(src, name)      a top-level `[async ]function name(` body, brace matched
 *   taskPathSource()             the hub and every spoke, for claims about the whole path
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');
const HUB_PATH = path.join(ROOT, 'bridge-agent.js');

/** Index just past the bracket that closes the one opened at `open`, or -1. */
function matchClose(src, open, openCh, closeCh) {
    let depth = 0;
    for (let i = open; i < src.length; i++) {
        if (src[i] === openCh) depth++;
        else if (src[i] === closeCh && --depth === 0) return i + 1;
    }
    return -1;
}

/** A top-level function's text, from its keyword to its matching brace, or null. */
function functionBody(src, name) {
    const m = new RegExp(`(^|\\n)((?:async )?function ${name}\\()`).exec(src || '');
    if (!m) return null;
    const start = m.index + m[1].length;
    const paramsEnd = matchClose(src, start + m[2].length - 1, '(', ')');
    if (paramsEnd < 0) return null;
    const end = matchClose(src, src.indexOf('{', paramsEnd), '{', '}');
    return end < 0 ? null : src.slice(start, end);
}

/** processTask's body in `src` (bridge-agent.js by default). */
function hubBody(src = fs.readFileSync(HUB_PATH, 'utf8')) {
    return functionBody(src, 'processTask');
}

/**
 * The spoke modules processTask calls, in the order its steps run. Declared, not
 * scanned: bridge-agent.js also requires task-parser, task-queue and others that are not
 * steps. tests/task-hub.test.js fails when one of these is not required by the hub or
 * not called from it, and when a lib/task-*.js module whose header says it was moved out
 * of processTask is missing here.
 */
const SPOKES = [
    'task-state-gate', 'task-memory-record', 'task-workspace', 'task-prompt',
    'task-llm-run', 'task-outcome', 'task-followups',
];
const SPOKE_FILES = Object.fromEntries(SPOKES.map((n) => [n, path.join(ROOT, 'lib', `${n}.js`)]));

function spokeSource(name) {
    if (!SPOKE_FILES[name]) throw new Error(`no task spoke named ${name} is required by bridge-agent.js`);
    return fs.readFileSync(SPOKE_FILES[name], 'utf8');
}

/** The hub and every spoke, hub first. */
function taskPathSource() {
    return [hubBody(), ...Object.keys(SPOKE_FILES).map(spokeSource)].join('\n');
}

module.exports = { HUB_PATH, SPOKES, SPOKE_FILES, functionBody, hubBody, spokeSource, taskPathSource };
