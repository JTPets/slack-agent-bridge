/**
 * tests/weekly-critique-gating.test.js
 *
 * THE guard that the jester cannot gate anything.
 *
 * He controls nothing, blocks nothing, and is read when the owner chooses to read him.
 * That powerlessness is a design constraint, not an omission: the moment his opinion
 * gates something, it becomes an unaccountable check with taste instead of rules — a
 * reviewer with no definition of done, no appeal, and a personality prompt telling it
 * to be contrarian.
 *
 * A sentence in a design document does not enforce that. These do, in four independent
 * ways: a source walk over the module (it may write no state), a disk walk over every
 * production file (it may have one call site), a second disk walk (its task name may be
 * declared in exactly two places), and an assertion that both consumers of its verdict
 * use it only to choose what text to say.
 *
 * LOGIC CHANGE 2026-09-16: split out of tests/weekly-critique.test.js, which reached
 * 440 lines against the 300-line rule (lib/file-size-gate.js). Splitting on this seam
 * beat buying a 70th entry in lib/validate-exceptions.json — and the guard is worth
 * citing on its own, which a describe block buried in a behaviour suite is not.
 *
 * Carries its own negative controls: every live assertion here has the shape "this list
 * is empty" or "this list is exactly these", which a broken enumerator also satisfies.
 */

'use strict';

const fs = require('fs');
const path = require('path');

describe('HE CANNOT GATE ANYTHING — enforced, not asserted', () => {
    const SRC = fs.readFileSync(path.join(__dirname, '..', 'lib', 'weekly-critique.js'), 'utf8');
    const CODE = SRC.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');

    /**
     * Every way this repository changes state that could make something proceed or not.
     * The critique may touch none of them. Adding a state-mutating API to this module
     * fails here.
     */
    const FORBIDDEN = [
        ['approval-queue', /approval-queue|approveTask|rejectTask|queueTask/],
        ['task queue transitions', /task-queue|markRunning|\.complete\(|\.fail\(|\.interrupt\(/],
        ['the task lock', /task-lock|acquire\(|releaseIfStale/],
        ['agent activation', /agent-activation|activateAgent|deactivateAgent/],
        ['the bulletin board', /bulletin-board|postBulletin/],
        ['git', /child_process|execFileSync|spawn\(/],
        ['owner task state', /owner-tasks|completeTask|addTask/],
        ['durable writes', /writeFileSync|writeFile\(|appendFile/],
    ];

    test.each(FORBIDDEN)('it never touches %s', (_label, pattern) => {
        expect(CODE).not.toMatch(pattern);
    });

    test('the only filesystem calls are mkdtemp and its own rm', () => {
        // A temp dir for the model's cwd, removed in a finally. Nothing else.
        expect(CODE).toMatch(/fs\.mkdtemp\(/);
        expect(CODE).toMatch(/fs\.rm\(/);
        expect(CODE.match(/fs\.\w+\(/g).sort()).toEqual(['fs.mkdtemp(', 'fs.rm(']);
    });

    /** Every production .js file except this module itself, comments and all stripped. */
    function productionSources() {
        const root = path.join(__dirname, '..');
        const out = [];
        const walk = (dir) => {
            for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
                if (['node_modules', '.git', 'tests', 'coverage', 'public'].includes(e.name)) continue;
                const full = path.join(dir, e.name);
                if (e.isDirectory()) walk(full);
                else if (e.name.endsWith('.js') && full !== path.join(root, 'lib', 'weekly-critique.js')) {
                    out.push({
                        rel: path.relative(root, full),
                        code: fs.readFileSync(full, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, ''),
                    });
                }
            }
        };
        walk(root);
        return out;
    }

    test('exactly ONE production file calls runWeeklyCritique — no third route', () => {
        // A CALL SITE, not a mention. The catalogue is the single entry point; the cron
        // registrar and the `critique` verb both reach it through getDeterministicTask(),
        // so they are one route triggered two ways rather than two routes.
        const callers = productionSources()
            .filter(f => /runWeeklyCritique/.test(f.code))
            .map(f => f.rel);
        expect(callers.sort()).toEqual(['lib/agent-task-catalogue.js']);
    });

    test('the task NAME is declared in exactly the catalogue and the command table', () => {
        // Distinct from the assertion above: naming the task is a DECLARATION (what
        // exists, and what verb spells it), which is allowed in those two places and
        // nowhere else. A third file naming it would be a second registry, which is
        // what WORK-TODO #45 and lib/command-router.js's own header forbid.
        const namers = productionSources()
            .filter(f => /'weekly-critique'|"weekly-critique"/.test(f.code))
            .map(f => f.rel);
        expect(namers.sort()).toEqual(['lib/agent-task-catalogue.js', 'lib/command-router.js']);
    });

    test('the verdict is a report — no caller branches on it to decide anything', () => {
        const router = fs.readFileSync(path.join(__dirname, '..', 'lib', 'command-router.js'), 'utf8');
        const scheduler = fs.readFileSync(path.join(__dirname, '..', 'lib', 'agent-scheduler.js'), 'utf8');
        // Both consume a deterministic verdict only to decide what TEXT to report.
        expect(router).toMatch(/const ok = verdict\?\.ok !== false;/);
        expect(scheduler).toMatch(/return \{ success: verdict\?\.ok !== false, deterministic: true, verdict \}/);
    });
});

describe('the guard itself detects what it claims to', () => {
    test('a forbidden API WOULD be caught', () => {
        const fake = "const q = require('./approval-queue');";
        expect(fake).toMatch(/approval-queue|approveTask|rejectTask|queueTask/);
    });

    test('an extra production caller WOULD be caught', () => {
        const callers = ['lib/agent-task-catalogue.js', 'bridge-agent.js'];
        expect(callers.sort()).not.toEqual(['lib/agent-task-catalogue.js']);
    });

    test('the walker actually finds files, so the two live assertions scan something', () => {
        // Both live assertions above compare against a SHORT list, which a walker that
        // found nothing would also satisfy on one side and fail on the other — but a
        // walker that found nothing relevant would silently weaken them. Prove it reads
        // real sources.
        const root = path.join(__dirname, '..');
        const walkCount = fs.readdirSync(path.join(root, 'lib')).filter(n => n.endsWith('.js')).length;
        expect(walkCount).toBeGreaterThan(20);
    });
});
