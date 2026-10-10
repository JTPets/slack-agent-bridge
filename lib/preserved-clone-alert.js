'use strict';

/**
 * lib/preserved-clone-alert.js
 *
 * The text of the #sqtools-ops alert posted when processTask keeps a scratch clone
 * because its work was not delivered (lib/clone-lifecycle.js detectUndeliveredWork).
 *
 * LOGIC CHANGE 2026-10-02 (WORK-TODO #25): the alert used to post `Location: <path>`
 * and "the clone was NOT deleted so the work can be recovered". Both were true and
 * neither was enough:
 *
 *   - the path is INSIDE the jt-agent container. Unless WORK_DIR is bind-mounted,
 *     it does not exist on the NAS host, and an owner reading the alert cannot `cd`
 *     there. Recovery needs `docker exec` first, and the alert did not say so.
 *   - whether the clone survives depends on WHERE WORK_DIR lives, which this
 *     repository cannot see. `docker compose restart` keeps the container, so the
 *     clone survives it. `docker compose up -d --force-recreate` - which every .env
 *     change requires - discards the container's writable layer, so the clone
 *     survives it ONLY if WORK_DIR is on a mount. Since 2026-10-10 the tracked
 *     compose copy (docker-compose.example.yml) and the live box both mount
 *     /tmp/bridge-agent from /share/CACHEDEV1_DATA/jt-agent/work (WORK-TODO #25).
 *     The alert still states the condition, because WORK_DIR is configurable and
 *     this process cannot see its own mounts.
 *
 * Pure: builds a string, posts nothing. bridge-agent.js posts it.
 */

/** The compose service / container name the bridge runs as (CLAUDE.md -> Deployment). */
const CONTAINER_NAME = 'jt-agent';

/**
 * Build the preserved-clone alert.
 *
 * @param {object} p
 * @param {string} p.description - the task's one-line description
 * @param {string} p.reason      - detectUndeliveredWork's reason
 * @param {string} p.taskDir     - the preserved clone's path, as the bridge sees it
 * @param {string} p.workDir     - WORK_DIR, the base the clone lives under
 * @param {string} [p.sourceLink] - Slack mrkdwn link to the source message
 * @returns {string}
 */
function formatPreservedCloneAlert({ description, reason, taskDir, workDir, sourceLink }) {
    const lines = [
        ':warning: *Scratch clone preserved — undelivered work.*',
        `Task: ${description}`,
        `Reason: ${reason}`,
        `Location: \`${taskDir}\` — a path *inside the \`${CONTAINER_NAME}\` container*, not on the NAS host.`,
        `Reach it: \`docker exec -it ${CONTAINER_NAME} sh\`, then \`cd ${taskDir}\` and \`git status\` / \`git log\`.`,
        'The clone was NOT deleted so the work can be recovered and pushed manually.',
        '*Push it before the container is recreated.* It survives `docker compose restart`. ' +
            '`docker compose up -d --force-recreate` (needed for any `.env` change) deletes it ' +
            `unless WORK_DIR (\`${workDir}\`) is on a mount. ` +
            // LOGIC CHANGE 2026-10-10 (WORK-TODO #25): the tracked compose copy now mounts the
            // default WORK_DIR; the alert used to say it did not.
            'The tracked compose copy mounts `/tmp/bridge-agent` from `/share/CACHEDEV1_DATA/jt-agent/work` on the NAS host.',
    ];
    if (sourceLink) lines.push(`Source: ${sourceLink}`);
    return lines.join('\n');
}

module.exports = { formatPreservedCloneAlert, CONTAINER_NAME };
