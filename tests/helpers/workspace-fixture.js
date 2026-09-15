'use strict';

/**
 * tests/helpers/workspace-fixture.js
 *
 * THE workspace a suite runs against, instead of whichever workspace the checkout
 * happens to be sitting in.
 *
 * LOGIC CHANGE 2026-09-15: New file, closing the first half of WORK-TODO #50.
 * `agents/shared/channel-map.json` is gitignored and is the ONLY thing that maps an
 * agent's declared `channel_name` to an id, so in a fresh clone every agent resolved
 * to no channel and 30 assertions of the form "agents with channels" got an empty
 * set. Seven suites were therefore red in the exact environment every dispatched task
 * runs in — a scratch clone — for a reason that had nothing to do with the change
 * under test. Measured on 3c62bb1: 7 suites / 30 tests red with no map, 66 suites /
 * 2229 tests green with one.
 *
 * The fixture is TRACKED (`tests/fixtures/channel-map.json`) and its ids are
 * deliberately fake (`C0FIX*`). A test that needs an id should read it from here, so
 * a real workspace id never has to appear in a tracked test file to make one pass.
 *
 * It is COPIED into a temp directory, not read in place, for the second half of the
 * same item: a suite that resolves a channel calls `setChannelId()`, which writes.
 * Reading ambient state a suite can also write is how three invented ids
 * (`test-channel`, `new-channel`, `my-channel`) ended up in the live channel map the
 * deployment depends on. The copy makes both directions harmless.
 *
 * The guard that it stays this way is `tests/helpers/live-state-setup.js` +
 * `-teardown.js`, wired as jest `globalSetup`/`globalTeardown`: the whole run fails
 * if any real state file changed.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

const FIXTURE = path.join(__dirname, '..', 'fixtures', 'channel-map.json');

/** The fixture's contents, as the tracked file declares them. */
const CHANNELS = JSON.parse(fs.readFileSync(FIXTURE, 'utf8'));

/** The bridge channel id every suite should pin BRIDGE_CHANNEL_ID to. */
const BRIDGE_CHANNEL = CHANNELS['claude-bridge'];

/**
 * Point `lib/bridge-state.js` at a private copy of the fixture workspace for the
 * lifetime of this suite, and tear it down afterwards.
 *
 * Call it at the top level of a suite file, before anything requires the registry —
 * `loadAgents()` reads the map on every call, so ordering of the require does not
 * matter, but ordering of the init does.
 *
 * @param {object} [options]
 * @param {object} [options.channels] - Override the name -> id map for this suite.
 * @returns {{ dir: string, channels: object, bridgeChannel: string }}
 */
function useFixtureWorkspace(options = {}) {
    const channels = options.channels || CHANNELS;
    const bridgeState = require('../../lib/bridge-state');
    const handle = { dir: null, channels, bridgeChannel: channels['claude-bridge'] || BRIDGE_CHANNEL };

    beforeEach(() => {
        handle.dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-workspace-'));
        fs.writeFileSync(path.join(handle.dir, 'channel-map.json'), JSON.stringify(channels, null, 2), 'utf8');
        bridgeState.init({
            channelMapFile: path.join(handle.dir, 'channel-map.json'),
            activationFile: path.join(handle.dir, 'agent-activation.json'),
            stateFile: path.join(handle.dir, 'state.json'),
            processedTasksFile: path.join(handle.dir, 'processed-tasks.json'),
        });
    });

    afterEach(() => {
        if (handle.dir) fs.rmSync(handle.dir, { recursive: true, force: true });
        handle.dir = null;
    });

    return handle;
}

module.exports = { useFixtureWorkspace, CHANNELS, BRIDGE_CHANNEL, FIXTURE };
