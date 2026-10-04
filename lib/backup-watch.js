'use strict';

/**
 * lib/backup-watch.js
 *
 * WORK-TODO #42 (c), the bridge half: an AGE alert for the NAS backups, so a backup that
 * stopped is reported instead of found. The host writes a status file
 * (scripts/backup-status.sh, from host cron); this reads it on an interval and posts to
 * #sqtools-ops when:
 *   - the status file is missing or unreadable,
 *   - the status file itself is older than the limit (the host job stopped - a firmware
 *     update wiping /etc/config/crontab stops BOTH the backups and this job, and this is
 *     the line that notices),
 *   - a directory is missing or empty, its newest file's age is unknown, or that file is
 *     older than the limit.
 * The bridge sees file names and ages only, never the dumps (they hold customer data).
 *
 * LOGIC CHANGE 2026-10-04: new file. Report-only. Off unless BACKUP_STATUS_FILE is set.
 *
 * When it posts: when the set of problems CHANGES, again every 24 hours while any persist,
 * and once when they clear. A steady healthy state posts nothing.
 */

const fs = require('fs');

const REPEAT_MS = 24 * 60 * 60 * 1000;

/** Problems in a status file, as stable one-line strings (their join is the dedup key). */
function evaluateStatus(raw, nowMs, maxAgeMs) {
    if (raw === null) return ['the status file does not exist (has the host job ever run?)'];
    let status;
    try {
        status = JSON.parse(raw);
    } catch (err) {
        return [`the status file is not valid JSON (${err.message})`];
    }
    const hours = (ms) => `${Math.round(ms / 3600000)}h`;
    const problems = [];
    const checkedMs = Number(status.checkedAt) * 1000;
    if (!Number.isFinite(checkedMs) || checkedMs <= 0) {
        problems.push('the status file has no checkedAt time');
    } else if (nowMs - checkedMs > maxAgeMs) {
        problems.push(`the host check last ran ${hours(nowMs - checkedMs)} ago - its cron entry has probably stopped (a firmware update wipes /etc/config/crontab), so the backups may have stopped with it`);
    }
    const dirs = Array.isArray(status.dirs) ? status.dirs : [];
    if (!dirs.length) problems.push('the status file lists no backup directories');
    for (const d of dirs) {
        const where = String(d.path || 'unnamed directory');
        if (d.missing) problems.push(`${where}: directory does not exist`);
        else if (!d.newest) problems.push(`${where}: directory is empty`);
        else if (!Number.isFinite(Number(d.newestMtime)) || d.newestMtime === null) problems.push(`${where}: age of ${d.newest} could not be read`);
        else if (nowMs - Number(d.newestMtime) * 1000 > maxAgeMs) {
            problems.push(`${where}: newest backup ${d.newest} is ${hours(nowMs - Number(d.newestMtime) * 1000)} old`);
        }
    }
    return problems;
}

/**
 * @param {object} deps - { file, maxAgeMs, notify(text), now(), readFile(path) -> string|null, logger }
 * @returns {{ tick: () => Promise<'healthy'|'reported'|'unchanged'|'recovered'> }}
 */
function createBackupWatch({ file, maxAgeMs, notify, now = Date.now, readFile, logger = console }) {
    const read = readFile || ((p) => {
        try {
            return fs.readFileSync(p, 'utf8');
        } catch (err) {
            if (err.code === 'ENOENT') return null;
            return `{"unreadable": ${JSON.stringify(err.message)}`; // parse fails and names it
        }
    });
    let lastKey = '';
    let lastPostMs = 0;

    async function post(text) {
        try {
            await notify(text);
        } catch (err) {
            logger.error(`[backup-watch] Could not post: ${err.message}`);
        }
    }

    async function tick() {
        const nowMs = now();
        const problems = evaluateStatus(read(file), nowMs, maxAgeMs);
        const key = problems.join('\n');
        if (!problems.length) {
            if (!lastKey) return 'healthy';
            lastKey = '';
            await post(':white_check_mark: *Backups look fresh again* — every directory in the backup status file has a file newer than the limit.');
            return 'recovered';
        }
        if (key === lastKey && nowMs - lastPostMs < REPEAT_MS) return 'unchanged';
        lastKey = key;
        lastPostMs = nowMs;
        await post(
            `:floppy_disk: *Backup check: ${problems.length} problem(s)* (limit ${Math.round(maxAgeMs / 3600000)}h, file \`${file}\`)\n` +
            problems.map((p) => `• ${p}`).join('\n') +
            '\nOn the NAS: `ls -lt /share/CACHEDEV1_DATA/sqtools/backups/ | head -5` and `crontab -l`. Repeats daily while it persists.'
        );
        return 'reported';
    }

    return { tick };
}

module.exports = { REPEAT_MS, evaluateStatus, createBackupWatch };
