/**
 * tests/slack-socket.test.js
 *
 * LOGIC CHANGE 2026-09-14: New file, covering lib/slack-socket.js.
 *
 * What this suite is actually for. The connection is additive by claim; the claim is
 * only worth something if it is asserted. The load-bearing group is
 * `describe('the additivity contract')` — every way this can fail must resolve to an
 * inert handle rather than throw, because a throw out of startup is exactly the
 * failure mode that would stop tasks arriving, including the task that would fix it.
 *
 * The second group pins the WIRING in bridge-agent.js by reading its source, the same
 * technique tests/integration.test.js uses for runWithFallback. A module that is
 * correct and unreachable is the standing failure in this repo (auto-update.js has 62
 * passing tests and no launcher), so "it is required, it is started, and it is started
 * AFTER the poll interval is armed and not awaited" is asserted, not assumed.
 */

'use strict';

const fs = require('fs');
const path = require('path');

const {
    startSocketMode,
    readAppTokenConfig,
    readDownAlertMs,
    DEFAULT_DOWN_ALERT_MS,
    APP_TOKEN_PREFIX,
} = require('../lib/slack-socket');

const VALID_TOKEN = 'xapp-1-A0123456789-0123456789012-abcdefabcdefabcdefabcdef';

/** A silent logger, so a passing run does not print reconnection noise. */
function quietLogger() {
    return { log: jest.fn(), warn: jest.fn(), error: jest.fn() };
}

/**
 * A fake SocketModeClient: an event registry plus a controllable `start`.
 * Deliberately NOT an EventEmitter subclass — the point is to assert which events
 * lib/slack-socket.js subscribes to, which a real emitter would hide.
 */
function fakeClient({ startImpl } = {}) {
    const handlers = {};
    return {
        handlers,
        on: jest.fn((event, fn) => {
            handlers[event] = fn;
        }),
        start: jest.fn(startImpl || (async () => ({ ok: true }))),
        disconnect: jest.fn(async () => undefined),
        emit: (event, payload) => handlers[event] && handlers[event](payload),
    };
}

/** Standard injected deps: a fake client, a recording notifier, manual timers. */
function harness(overrides = {}) {
    const notify = jest.fn(async () => true);
    const logger = quietLogger();
    const client = overrides.client || fakeClient();
    const timers = [];
    const setTimeoutFn = jest.fn((fn, ms) => {
        const handle = { fn, ms, cleared: false, unref: () => handle };
        timers.push(handle);
        return handle;
    });
    const clearTimeoutFn = jest.fn((handle) => {
        if (handle) handle.cleared = true;
    });
    return {
        notify,
        logger,
        client,
        timers,
        /** Fire the most recently armed, still-live timer. */
        fireLatestTimer: async () => {
            const live = timers.filter((t) => !t.cleared);
            await live[live.length - 1].fn();
        },
        deps: {
            env: { SLACK_APP_TOKEN: VALID_TOKEN },
            createClient: () => client,
            notify,
            logger,
            downAlertMs: 1000,
            setTimeoutFn,
            clearTimeoutFn,
            ...overrides.deps,
        },
    };
}

describe('readAppTokenConfig classifies the token without revealing it', () => {
    test('an absent token is not_configured, not an error', () => {
        const verdict = readAppTokenConfig({});
        expect(verdict.ok).toBe(false);
        expect(verdict.reason).toBe('not_configured');
        expect(verdict.token).toBeNull();
        expect(verdict.detail).toMatch(/runs normally/i);
    });

    test('a blank or whitespace-only token is not_configured', () => {
        expect(readAppTokenConfig({ SLACK_APP_TOKEN: '   ' }).reason).toBe('not_configured');
        expect(readAppTokenConfig({ SLACK_APP_TOKEN: '' }).reason).toBe('not_configured');
    });

    test('a bot token in the app-token slot is rejected on shape', () => {
        const verdict = readAppTokenConfig({ SLACK_APP_TOKEN: 'xoxb-not-an-app-token-value' });
        expect(verdict.ok).toBe(false);
        expect(verdict.reason).toBe('invalid_token_shape');
    });

    test('a rejection message never contains the value it rejected', () => {
        // The whole point of returning a "detail" string is that it is safe to post
        // to Slack. A message that quotes the offending value is a credential leak
        // dressed as a diagnostic.
        const secret = 'xoxb-SUPERSECRETVALUE-0123456789';
        const verdict = readAppTokenConfig({ SLACK_APP_TOKEN: secret });
        expect(verdict.detail).not.toContain(secret);
        expect(verdict.detail).not.toContain('SUPERSECRETVALUE');
        expect(verdict.detail).toContain('SLACK_APP_TOKEN');
    });

    test('a well-shaped token is accepted and carried', () => {
        const verdict = readAppTokenConfig({ SLACK_APP_TOKEN: `  ${VALID_TOKEN}  ` });
        expect(verdict.ok).toBe(true);
        expect(verdict.token).toBe(VALID_TOKEN);
        expect(VALID_TOKEN.startsWith(APP_TOKEN_PREFIX)).toBe(true);
    });
});

describe('readDownAlertMs', () => {
    test('defaults when unset, blank, non-numeric or non-positive', () => {
        for (const value of [undefined, '', 'soon', '0', '-5']) {
            expect(readDownAlertMs({ SOCKET_MODE_DOWN_ALERT_MS: value })).toBe(DEFAULT_DOWN_ALERT_MS);
        }
        expect(readDownAlertMs({})).toBe(DEFAULT_DOWN_ALERT_MS);
    });

    test('honours a positive override', () => {
        expect(readDownAlertMs({ SOCKET_MODE_DOWN_ALERT_MS: '90000' })).toBe(90000);
    });
});

describe('defaultClientFactory builds a real SocketModeClient', () => {
    // Every other test here injects a fake client, which means none of them would
    // notice a wrong package name, a renamed export, or a LogLevel import that no
    // longer resolves. This is the one test that touches the real library. It only
    // CONSTRUCTS — construction opens no socket, so this needs no network.
    test('the real dependency resolves and constructs', () => {
        const { defaultClientFactory: factory } = require('../lib/slack-socket');
        const client = factory({ appToken: `xapp-1-A000-000-${'z'.repeat(24)}` });
        expect(client.constructor.name).toBe('SocketModeClient');
        for (const method of ['on', 'start', 'disconnect']) {
            expect(typeof client[method]).toBe('function');
        }
    });

    test('@slack/socket-mode is a declared dependency, not an accident of hoisting', () => {
        const pkg = require('../package.json');
        expect(pkg.dependencies['@slack/socket-mode']).toBeDefined();
    });
});

describe('the additivity contract: startSocketMode never throws', () => {
    test('no token: an inert handle, a report to a human, no throw', async () => {
        const h = harness();
        const handle = await startSocketMode({ ...h.deps, env: {} });
        expect(handle.started).toBe(false);
        expect(handle.reason).toBe('not_configured');
        expect(handle.getState()).toBe('off');
        expect(h.notify).toHaveBeenCalledTimes(1);
        expect(h.notify.mock.calls[0][0]).toMatch(/SLACK_APP_TOKEN is not set/);
    });

    test('malformed token: an inert handle, and the value never reaches the reporter', async () => {
        const secret = 'xoxb-LEAKME-0123456789';
        const h = harness();
        const handle = await startSocketMode({ ...h.deps, env: { SLACK_APP_TOKEN: secret } });
        expect(handle.started).toBe(false);
        expect(handle.reason).toBe('invalid_token_shape');
        expect(h.notify.mock.calls[0][0]).not.toContain(secret);
        expect(h.notify.mock.calls[0][0]).not.toContain('LEAKME');
    });

    test('the dependency cannot be loaded: reported, not thrown', async () => {
        const h = harness();
        const handle = await startSocketMode({
            ...h.deps,
            createClient: () => {
                throw new Error("Cannot find module '@slack/socket-mode'");
            },
        });
        expect(handle.started).toBe(false);
        expect(handle.reason).toBe('dependency_missing');
        expect(h.notify.mock.calls[0][0]).toMatch(/poll loop/i);
    });

    test('the handshake rejects: reported, not thrown', async () => {
        const client = fakeClient({
            startImpl: async () => {
                throw new Error('invalid_auth');
            },
        });
        const h = harness({ client });
        const handle = await startSocketMode(h.deps);
        expect(handle.started).toBe(false);
        expect(handle.reason).toBe('start_failed');
        expect(h.notify.mock.calls[0][0]).toMatch(/invalid_auth/);
    });

    test('a reporter that itself throws does not break startup', async () => {
        // notifyOps posts to Slack. Slack can be down at the same moment the socket
        // is. A failure to report a failure must not become a third failure.
        const h = harness();
        const handle = await startSocketMode({
            ...h.deps,
            env: {},
            notify: async () => {
                throw new Error('slack is down too');
            },
        });
        expect(handle.started).toBe(false);
        expect(handle.reason).toBe('not_configured');
        expect(h.logger.error).toHaveBeenCalled();
    });

    test('a rejecting event handler is contained, not left unhandled', async () => {
        // An async listener on an EventEmitter is fire-and-forget. If it rejects, Node
        // 20+ terminates the process — which would let this module kill the bridge.
        // The listener is invoked here exactly as the library invokes it: no await, no
        // catch at the call site.
        const onSlashCommand = jest.fn(async () => {
            throw new Error('handler blew up');
        });
        const h = harness();
        await startSocketMode({ ...h.deps, onSlashCommand });

        const returned = h.client.handlers.slash_commands({ ack: jest.fn(), body: {} });
        await expect(returned).resolves.toBeUndefined();
        expect(h.logger.error).toHaveBeenCalledWith(
            expect.stringContaining('handler blew up')
        );
    });

    test('a throwing outage timer is contained too', async () => {
        // Note the choice of failure: `report()` already try/catches the NOTIFY call,
        // so a rejecting notifier proves nothing about `guarded`. The logger call
        // ahead of it is not covered by that try/catch, so this is a path only the
        // wrapper can contain — verified by removing the wrapper and watching it fail.
        const h = harness();
        const logger = quietLogger();
        logger.warn = jest.fn(() => {
            throw new Error('log sink exploded');
        });
        await startSocketMode({ ...h.deps, logger });

        // Called the way setTimeout calls it: unawaited, uncaught at the call site.
        await expect(Promise.resolve(h.timers[0].fn())).resolves.toBeUndefined();
        expect(logger.error).toHaveBeenCalledWith(
            expect.stringContaining('log sink exploded')
        );
    });

    test('an inert handle is still safe to call stop() on', async () => {
        const h = harness();
        const handle = await startSocketMode({ ...h.deps, env: {} });
        await expect(handle.stop()).resolves.toEqual({ stopped: false, reason: 'not_configured' });
    });
});

describe('a healthy connection', () => {
    test('starts, subscribes to the state events it needs, and reports ready', async () => {
        const h = harness();
        const handle = await startSocketMode(h.deps);

        expect(handle.started).toBe(true);
        expect(h.client.start).toHaveBeenCalledTimes(1);
        for (const event of ['connected', 'disconnected', 'reconnecting', 'slash_commands']) {
            expect(Object.keys(h.client.handlers)).toContain(event);
        }

        await h.client.emit('connected');
        expect(handle.getState()).toBe('connected');
        expect(h.logger.log).toHaveBeenCalledWith('[slack-socket] Connection ready.');
        // Coming up cleanly is not an incident: nobody is paged for it.
        expect(h.notify).not.toHaveBeenCalled();
    });

    test('stop() disconnects and is safe when the socket refuses to close', async () => {
        const h = harness();
        const handle = await startSocketMode(h.deps);
        await h.client.emit('connected');

        await expect(handle.stop()).resolves.toEqual({ stopped: true });
        expect(h.client.disconnect).toHaveBeenCalledTimes(1);

        h.client.disconnect.mockRejectedValueOnce(new Error('socket wedged'));
        const second = await handle.stop();
        expect(second.stopped).toBe(false);
        expect(second.error).toBe('socket wedged');
    });
});

describe('a dropped connection reaches a human, and a recovery does too', () => {
    test('a drop that recovers before the threshold pages nobody', async () => {
        const h = harness();
        await startSocketMode(h.deps);
        await h.client.emit('connected');

        await h.client.emit('disconnected');
        await h.client.emit('connected');

        expect(h.notify).not.toHaveBeenCalled();
    });

    test('a drop that persists past the threshold posts, and keeps posting', async () => {
        const h = harness();
        const handle = await startSocketMode(h.deps);
        await h.client.emit('connected');
        await h.client.emit('disconnected');
        expect(handle.getState()).toBe('disconnected');

        await h.fireLatestTimer();
        expect(h.notify).toHaveBeenCalledTimes(1);
        expect(h.notify.mock.calls[0][0]).toMatch(/has not recovered/);
        // Message handling is explicitly scoped so the reader is not misled into
        // thinking the bridge has stopped taking tasks.
        expect(h.notify.mock.calls[0][0]).toMatch(/poll loop is unaffected/i);

        // Still down one interval later: it re-arms rather than going quiet.
        await h.fireLatestTimer();
        expect(h.notify).toHaveBeenCalledTimes(2);
        expect(h.notify.mock.calls[1][0]).toMatch(/alert 2/);
    });

    test('recovery after an alert posts a recovery line and resets the counter', async () => {
        const h = harness();
        await startSocketMode(h.deps);
        await h.client.emit('connected');
        await h.client.emit('disconnected');
        await h.fireLatestTimer();

        await h.client.emit('connected');
        expect(h.notify).toHaveBeenCalledTimes(2);
        expect(h.notify.mock.calls[1][0]).toMatch(/recovered/);

        // A second outage starts from alert 1 again, not alert 3.
        await h.client.emit('disconnected');
        await h.fireLatestTimer();
        expect(h.notify.mock.calls[2][0]).toMatch(/alert 1/);
    });

    test('a socket that starts but never becomes ready is an outage too', async () => {
        // The failure this catches: start() resolves, no error is raised anywhere,
        // and `connected` simply never arrives. Without arming the timer at start,
        // that state reports as healthy forever.
        const h = harness();
        await startSocketMode(h.deps);
        await h.fireLatestTimer();
        expect(h.notify).toHaveBeenCalledTimes(1);
        expect(h.notify.mock.calls[0][0]).toMatch(/has not recovered/);
    });

    test('a deliberate stop does not page anyone', async () => {
        const h = harness();
        const handle = await startSocketMode(h.deps);
        await h.client.emit('connected');
        await handle.stop();

        await h.client.emit('disconnected');
        const live = h.timers.filter((t) => !t.cleared);
        for (const timer of live) await timer.fn();
        expect(h.notify).not.toHaveBeenCalled();
    });
});

describe('the command seam', () => {
    test('no handler attached: the command is acknowledged, never left hanging', async () => {
        const h = harness();
        await startSocketMode(h.deps);
        const ack = jest.fn(async () => undefined);

        await h.client.emit('slash_commands', { ack, body: { command: '/task' } });

        expect(ack).toHaveBeenCalledTimes(1);
        expect(ack.mock.calls[0][0].response_type).toBe('ephemeral');
        expect(h.logger.warn).toHaveBeenCalledWith(
            expect.stringContaining('/task')
        );
    });

    test('an attached handler receives the envelope and owns the ack', async () => {
        const onSlashCommand = jest.fn(async ({ ack }) => ack({ text: 'handled' }));
        const h = harness();
        await startSocketMode({ ...h.deps, onSlashCommand });
        const ack = jest.fn(async () => undefined);

        await h.client.emit('slash_commands', { ack, body: { command: '/task', text: 'x' } });

        expect(onSlashCommand).toHaveBeenCalledTimes(1);
        expect(onSlashCommand.mock.calls[0][0].body.command).toBe('/task');
        expect(ack).toHaveBeenCalledWith({ text: 'handled' });
    });

    // LOGIC CHANGE 2026-09-15: The seam now has two halves. A modal opened by a slash
    // command comes BACK as an `interactive` envelope, so a command that opens a form
    // is inert without this one.
    test('interactive: no handler attached: the submission is acknowledged, never left hanging', async () => {
        const h = harness();
        await startSocketMode(h.deps);
        const ack = jest.fn(async () => undefined);

        await h.client.emit('interactive', { ack, body: { type: 'view_submission' } });

        expect(ack).toHaveBeenCalledTimes(1);
        expect(h.logger.warn).toHaveBeenCalledWith(
            expect.stringContaining('view_submission')
        );
    });

    test('interactive: an attached handler receives the envelope and owns the ack', async () => {
        const onInteractive = jest.fn(async ({ ack }) => ack({ response_action: 'errors', errors: {} }));
        const h = harness();
        await startSocketMode({ ...h.deps, onInteractive });
        const ack = jest.fn(async () => undefined);

        await h.client.emit('interactive', { ack, body: { type: 'view_submission', view: { id: 'V1' } } });

        expect(onInteractive).toHaveBeenCalledTimes(1);
        expect(onInteractive.mock.calls[0][0].body.view.id).toBe('V1');
        expect(ack).toHaveBeenCalledWith({ response_action: 'errors', errors: {} });
    });

    test('a throwing interactive handler is contained — this module can never kill the bridge', async () => {
        const h = harness();
        await startSocketMode({
            ...h.deps,
            onInteractive: async () => { throw new Error('handler exploded'); },
        });

        const returned = h.client.handlers.interactive({ ack: jest.fn(), body: {} });

        await expect(returned).resolves.toBeUndefined();
        expect(h.logger.error).toHaveBeenCalledWith(
            expect.stringContaining('handler exploded')
        );
    });

    test('no command is registered in this change', () => {
        // The deliverable is a connection, not a command. If a future change adds one
        // here without also adding the modal and the parser round trip, this fails and
        // says why.
        const source = fs.readFileSync(path.join(__dirname, '..', 'lib', 'slack-socket.js'), 'utf8');
        expect(source).not.toMatch(/command\s*:\s*['"]\//);
        expect(source).toContain('THE COMMAND SEAM');
    });
});

describe('the wiring in bridge-agent.js', () => {
    const source = fs.readFileSync(path.join(__dirname, '..', 'bridge-agent.js'), 'utf8');
    // Comments in this file legitimately name startSocketMode when explaining the
    // ordering rule. Strip them, so prose about a call is never counted as one —
    // the same reason tests/no-shell-execution.test.js strips before it scans.
    const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

    test('bridge-agent.js requires lib/slack-socket.js', () => {
        expect(source).toMatch(
            /const \{[^}]*\bstartSocketMode\b[^}]*\} = require\('\.\/lib\/slack-socket'\);/
        );
    });

    test('startSocketMode is called exactly once, at startup', () => {
        const calls = code.match(/[^.\w]startSocketMode\s*\(/g) || [];
        expect(calls).toHaveLength(1);
    });

    test('it is started AFTER the poll interval is armed', () => {
        // The ordering IS the additivity guarantee. If a future edit moves the socket
        // ahead of the poll loop, an unreachable Slack delays the only path a task can
        // arrive on — and the task that would fix it cannot be dispatched.
        const pollArmed = code.indexOf('setInterval(poll, POLL_INTERVAL);');
        const socketStarted = code.search(/[^.\w]startSocketMode\s*\(/);
        expect(pollArmed).toBeGreaterThan(-1);
        expect(socketStarted).toBeGreaterThan(pollArmed);
    });

    test('it is not awaited, so it can never block startup', () => {
        // LOGIC CHANGE 2026-09-15: the call now carries the two seam handlers, so the
        // old literal `startSocketMode()` no longer appears. The PROPERTY being pinned
        // is unchanged and is what the regex asserts: the result is consumed with
        // .then(), never awaited, so startup cannot block on the connection.
        expect(code).not.toMatch(/await\s+startSocketMode\s*\(/);
        expect(source).toMatch(/startSocketMode\(\{[\s\S]*?\n\s*\}\)\s*\n\s*\.then\(/);
        expect(source).toMatch(/\.catch\(\(socketErr\)/);
    });

    test('both halves of the command seam are attached, not just the command', () => {
        // A slash command that opens a modal is inert without the interactive half:
        // the operator submits the form and nothing ever acknowledges it.
        expect(code).toMatch(/onSlashCommand:\s*\(envelope\)\s*=>/);
        expect(code).toMatch(/onInteractive:\s*\(envelope\)\s*=>/);
        expect(source).toMatch(/require\('\.\/lib\/dispatch-command'\)/);
    });

    test('the seam reuses the poll loop\u2019s allowlist rather than a second check', () => {
        // The gate has to be here: the composed task is posted AS THE BOT, and the
        // poll loop lets a bot post through without an allowlist check.
        const seam = code.slice(code.indexOf('startSocketMode({'));
        expect(seam).toMatch(/isAuthorized:\s*isUserAuthorized/);
        expect((seam.match(/isAuthorized:\s*isUserAuthorized/g) || []).length).toBe(2);
    });

    test('the composed task is POSTED, not handed to the task path directly', () => {
        const seam = code.slice(code.indexOf('startSocketMode({'));
        expect(seam).toMatch(/postMessage:\s*\(args\)\s*=>\s*slack\.chat\.postMessage/);
        expect(seam).toMatch(/bridgeChannel:\s*BRIDGE_CHANNEL/);
        expect(seam).not.toMatch(/processTask/);
    });

    test('the poll loop still owns message intake — the socket subscribes to no message event', () => {
        // The dispatch constraint, made executable: this connection carries commands.
        // If it ever starts receiving messages, message intake has two owners and the
        // dedup/authorisation path in poll() is no longer the single gate.
        //
        // LOGIC CHANGE 2026-09-15: 'interactive' joins the allowed set. It is what a
        // modal submission arrives on, and a slash command that opens a form is
        // useless without it. It is NOT a message event: it is delivered only because
        // this app opened that view, it carries no channel history, and no TASK:/ASK:
        // message can reach the bridge through it. The guard's CLAIM is unchanged —
        // no message intake — so the denylist below is the half that carries it, and
        // it is widened here rather than left implied by the allowlist.
        const socketSource = fs.readFileSync(
            path.join(__dirname, '..', 'lib', 'slack-socket.js'),
            'utf8'
        );
        const subscriptions = [...socketSource.matchAll(/client\.on\(\s*'([a-z_]+)'/g)].map((m) => m[1]);
        expect(subscriptions.sort()).toEqual(
            ['connected', 'disconnected', 'reconnecting', 'slash_commands', 'interactive'].sort()
        );
        for (const messageEvent of [
            'message',
            'app_mention',
            'message_changed',
            'message_replied',
            'events_api',
            'slack_event',
        ]) {
            expect(subscriptions).not.toContain(messageEvent);
        }
    });


    test('graceful shutdown closes the connection when one is open, but is not held open by it', () => {
        // Stopping matters so a deliberate shutdown is not reported as an outage.
        expect(code).toMatch(/socketMode\s*&&\s*typeof socketMode\.stop === 'function'/);
        expect(code).toMatch(/socketMode\.stop\(\)/);
        // Bounded matters more: a wedged WebSocket must not stall SIGTERM handling,
        // which runs before the ops post and before the wait for a running task.
        expect(code).toMatch(/Promise\.race\(\[\s*socketMode\.stop\(\),/);
        expect(code).toMatch(/SOCKET_STOP_TIMEOUT_MS/);
    });
});
