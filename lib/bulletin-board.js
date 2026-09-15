/**
 * lib/bulletin-board.js
 *
 * Inter-agent communication via a shared bulletin board.
 * All agents can post bulletins and read bulletins from other agents.
 *
 * LOGIC CHANGE 2026-03-28: Initial implementation of bulletin board system.
 * Enables agents to share information across channels without direct coupling.
 */

'use strict';

const fs = require('fs');
const path = require('path');

// Bulletin file path
const BULLETIN_FILE = path.join(__dirname, '..', 'agents', 'shared', 'bulletin.json');

// Valid bulletin types
const BULLETIN_TYPES = [
    'milestone',
    'alert',
    'vendor_deal',
    'customer_insight',
    'task_completed',
    'security_finding',
    'content_idea',
];

// Default cleanup age in days
const DEFAULT_CLEANUP_DAYS = 7;

/**
 * Load bulletins from file with self-healing on corruption.
 *
 * @returns {Array} Array of bulletin objects
 */
function loadBulletins() {
    try {
        if (!fs.existsSync(BULLETIN_FILE)) {
            // Auto-create directory and empty file if missing
            const dir = path.dirname(BULLETIN_FILE);
            if (!fs.existsSync(dir)) {
                fs.mkdirSync(dir, { recursive: true });
            }
            saveBulletins([]);
            return [];
        }

        const data = fs.readFileSync(BULLETIN_FILE, 'utf8');
        if (!data || !data.trim()) {
            console.warn('[bulletin-board] Empty file detected, resetting to empty array');
            saveBulletins([]);
            return [];
        }

        const parsed = JSON.parse(data);

        // Validate structure
        if (!Array.isArray(parsed)) {
            console.warn('[bulletin-board] Expected array in bulletin.json, got', typeof parsed, '. Resetting.');
            saveBulletins([]);
            return [];
        }

        return parsed;
    } catch (err) {
        if (err.code === 'ENOENT') {
            return [];
        }
        // JSON parse error or corruption - reset file
        console.warn(`[bulletin-board] Corrupted file: ${err.message}. Resetting to empty array.`);
        try {
            saveBulletins([]);
        } catch (saveErr) {
            console.error('[bulletin-board] Failed to reset bulletin file:', saveErr.message);
        }
        return [];
    }
}

/**
 * Save bulletins to file.
 *
 * @param {Array} bulletins - Array of bulletin objects
 */
function saveBulletins(bulletins) {
    // Ensure directory exists
    const dir = path.dirname(BULLETIN_FILE);
    if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
    }
    fs.writeFileSync(BULLETIN_FILE, JSON.stringify(bulletins, null, 2), 'utf8');
}

/**
 * Generate a unique bulletin ID.
 *
 * @returns {string} Unique ID
 */
function generateId() {
    return `${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
}

/**
 * Post a new bulletin to the board.
 *
 * @param {string} agentId - ID of the agent posting the bulletin
 * @param {string} type - Bulletin type (must be one of BULLETIN_TYPES)
 * @param {object} data - Bulletin data payload
 * @returns {{ success: boolean, bulletin?: object, error?: string }}
 */
function postBulletin(agentId, type, data) {
    if (!agentId || typeof agentId !== 'string') {
        return { success: false, error: 'agentId is required and must be a string' };
    }

    if (!type || !BULLETIN_TYPES.includes(type)) {
        return {
            success: false,
            error: `Invalid type. Must be one of: ${BULLETIN_TYPES.join(', ')}`,
        };
    }

    if (!data || typeof data !== 'object') {
        return { success: false, error: 'data is required and must be an object' };
    }

    try {
        const bulletins = loadBulletins();

        const bulletin = {
            id: generateId(),
            agentId,
            type,
            data,
            timestamp: new Date().toISOString(),
            read_by: [],
        };

        bulletins.push(bulletin);
        saveBulletins(bulletins);

        console.log(`[bulletin-board] Posted ${type} bulletin from ${agentId}: ${bulletin.id}`);

        return { success: true, bulletin };
    } catch (err) {
        console.error('[bulletin-board] Failed to post bulletin:', err.message);
        return { success: false, error: err.message };
    }
}

/**
 * Get bulletins with optional filtering.
 *
 * @param {object} [filters] - Optional filters
 * @param {string} [filters.type] - Filter by bulletin type
 * @param {string} [filters.agentId] - Filter by posting agent ID
 * @param {string} [filters.since] - ISO timestamp - only bulletins after this time
 * @param {string} [filters.unreadBy] - Agent ID - only bulletins not read by this agent
 * @param {number} [filters.limit] - Max number of bulletins to return (default: 50)
 * @returns {Array} Array of matching bulletins (newest first)
 */
function getBulletins(filters = {}) {
    try {
        let bulletins = loadBulletins();

        // Filter by type
        if (filters.type) {
            bulletins = bulletins.filter(b => b.type === filters.type);
        }

        // Filter by posting agent
        if (filters.agentId) {
            bulletins = bulletins.filter(b => b.agentId === filters.agentId);
        }

        // Filter by timestamp
        if (filters.since) {
            const sinceDate = new Date(filters.since).getTime();
            bulletins = bulletins.filter(b => new Date(b.timestamp).getTime() > sinceDate);
        }

        // Filter by unread
        if (filters.unreadBy) {
            bulletins = bulletins.filter(b => !b.read_by.includes(filters.unreadBy));
        }

        // Sort newest first
        bulletins.sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime());

        // Apply limit
        const limit = filters.limit || 50;
        bulletins = bulletins.slice(0, limit);

        return bulletins;
    } catch (err) {
        console.error('[bulletin-board] Failed to get bulletins:', err.message);
        return [];
    }
}

/**
 * Mark a bulletin as read by an agent.
 *
 * @param {string} bulletinId - ID of the bulletin
 * @param {string} agentId - ID of the agent marking it read
 * @returns {{ success: boolean, error?: string }}
 */
function markRead(bulletinId, agentId) {
    if (!bulletinId || !agentId) {
        return { success: false, error: 'bulletinId and agentId are required' };
    }

    try {
        const bulletins = loadBulletins();
        const bulletin = bulletins.find(b => b.id === bulletinId);

        if (!bulletin) {
            return { success: false, error: 'Bulletin not found' };
        }

        if (!bulletin.read_by.includes(agentId)) {
            bulletin.read_by.push(agentId);
            saveBulletins(bulletins);
            console.log(`[bulletin-board] Marked ${bulletinId} as read by ${agentId}`);
        }

        return { success: true };
    } catch (err) {
        console.error('[bulletin-board] Failed to mark read:', err.message);
        return { success: false, error: err.message };
    }
}

/**
 * Remove bulletins older than N days.
 *
 * @param {number} [daysOld] - Age threshold in days (default: 7)
 * @returns {{ success: boolean, removed: number, error?: string }}
 */
function cleanupOldBulletins(daysOld = DEFAULT_CLEANUP_DAYS) {
    try {
        const bulletins = loadBulletins();
        const cutoff = Date.now() - (daysOld * 24 * 60 * 60 * 1000);
        const original = bulletins.length;

        const filtered = bulletins.filter(b => {
            const bulletinTime = new Date(b.timestamp).getTime();
            return bulletinTime > cutoff;
        });

        const removed = original - filtered.length;

        if (removed > 0) {
            saveBulletins(filtered);
            console.log(`[bulletin-board] Cleaned up ${removed} bulletins older than ${daysOld} days`);
        }

        return { success: true, removed };
    } catch (err) {
        console.error('[bulletin-board] Failed to cleanup:', err.message);
        return { success: false, removed: 0, error: err.message };
    }
}

/**
 * Format bulletins for display in Slack.
 *
 * @param {Array} bulletins - Array of bulletin objects
 * @param {number} [maxItems] - Maximum items to display (default: 10)
 * @returns {string} Formatted string for Slack
 */
function formatBulletinsForSlack(bulletins, maxItems = 10) {
    if (!bulletins || bulletins.length === 0) {
        return 'No new bulletins.';
    }

    const toShow = bulletins.slice(0, maxItems);
    const lines = ['*Recent Bulletins:*', ''];

    for (const b of toShow) {
        const time = new Date(b.timestamp).toLocaleString('en-US', {
            month: 'short',
            day: 'numeric',
            hour: 'numeric',
            minute: '2-digit',
            hour12: true,
            timeZone: 'America/Toronto',
        });

        // Type emoji
        const typeEmoji = {
            milestone: ':trophy:',
            alert: ':warning:',
            vendor_deal: ':dollar:',
            customer_insight: ':mag:',
            task_completed: ':white_check_mark:',
            security_finding: ':lock:',
            content_idea: ':bulb:',
        }[b.type] || ':memo:';

        // Format data summary
        let summary = '';
        if (b.data.description) {
            summary = b.data.description;
        } else if (b.data.title) {
            summary = b.data.title;
        } else if (b.data.message) {
            summary = b.data.message;
        } else {
            summary = JSON.stringify(b.data).slice(0, 100);
        }

        // Truncate long summaries
        if (summary.length > 80) {
            summary = summary.slice(0, 77) + '...';
        }

        lines.push(`${typeEmoji} *${b.agentId}* (${time})`);
        lines.push(`   ${summary}`);
        lines.push('');
    }

    if (bulletins.length > maxItems) {
        lines.push(`_...and ${bulletins.length - maxItems} more_`);
    }

    return lines.join('\n');
}

/**
 * Render one bulletin's `data` payload as compact `key=value` pairs.
 *
 * LOGIC CHANGE 2026-09-15: this exists because the stream did not carry enough to
 * be worth reading. Every renderer picked `description || title || message ||
 * JSON.stringify(data).slice(0,150)` — so a bulletin whose payload has none of
 * those three keys (which is every bulletin `pushToSecretary` posts: its keys are
 * `from`, `subject`, `isTrustedVendor`) was shown as a truncated JSON fragment, and
 * one with a long `description` lost everything else in the payload. An agent
 * cannot notice a supplier shortage in a string that was cut at 150 characters.
 *
 * Scalars only, deliberately: a nested object in a bulletin payload is a design
 * smell, and flattening one here would reintroduce the unbounded-length problem.
 *
 * @param {object} data - Bulletin payload.
 * @param {number} [maxValue] - Per-VALUE cap, so one long field cannot crowd out
 *                              the others. The whole payload is never truncated.
 * @returns {string}
 */
function formatBulletinData(data, maxValue = 200) {
    if (!data || typeof data !== 'object') return '';
    const parts = [];
    for (const [key, value] of Object.entries(data)) {
        if (value === null || value === undefined || value === '') continue;
        if (typeof value === 'object') {
            parts.push(`${key}=<${Array.isArray(value) ? `${value.length} items` : 'object'}>`);
            continue;
        }
        let text = String(value);
        if (text.length > maxValue) text = `${text.slice(0, maxValue - 3)}...`;
        parts.push(`${key}=${text}`);
    }
    return parts.join(' | ');
}

/**
 * Format bulletins for inclusion in agent prompt context.
 *
 * THE STREAM, as an agent sees it. Every ACTIVE agent gets this on every ASK —
 * `processConversation` injects it for whichever agent owns the channel — so this
 * is what "every agent can see what the others produce" actually consists of. It is
 * not gated on `watches`: `watches` controls being PUSHED a notification, which is
 * opt-in because it costs a Slack post and an LLM dispatch per bulletin. Seeing the
 * stream is not opt-in.
 *
 * WHAT IT CARRIES: the bulletin type, which agent posted it, when (America/Toronto,
 * named explicitly like every other date site in this repo), and every scalar field
 * of the payload with each value capped at 200 characters.
 *
 * WHAT IT DOES NOT CARRY: anything older than the newest `limit`; the bulletin id,
 * so an agent cannot refer to one or mark it read; any thread or Slack permalink
 * back to the work that produced it; and nothing at all once a bulletin ages past
 * `cleanupOldBulletins`'s 7-day retention. It is a recent-events feed, not a log.
 *
 * `unreadBy` is applied, but NOTHING IN PRODUCTION CALLS `markRead` — regenerate
 * with `grep -rn "markRead" --include=*.js . | grep -v node_modules | grep -v tests`
 * — so in practice every agent sees the newest `limit` bulletins on every ASK,
 * including ones it has already seen. That is deliberate for now: an agent that saw
 * a bulletin once has no memory of it on the next ASK, so filtering it out would
 * make the stream emptier, not cleaner.
 *
 * @param {string} agentId - ID of the agent to get bulletins for.
 * @param {number} [limit] - Maximum bulletins to include.
 * @returns {string} Formatted context string, or '' when there is nothing to say.
 */
function formatBulletinsForContext(agentId, limit = 10) {
    const unread = getBulletins({ unreadBy: agentId, limit });

    if (unread.length === 0) {
        return '';
    }

    const lines = [
        `RECENT BULLETINS FROM OTHER AGENTS (newest first, up to ${limit}, 7-day retention):`,
    ];

    for (const b of unread) {
        const when = new Date(b.timestamp).toLocaleString('en-US', {
            month: 'short',
            day: 'numeric',
            hour: 'numeric',
            minute: '2-digit',
            hour12: true,
            timeZone: 'America/Toronto',
        });
        const payload = formatBulletinData(b.data);
        lines.push(`- [${b.type}] ${b.agentId} (${when}): ${payload || '(no payload)'}`);
    }

    lines.push('');
    return lines.join('\n');
}

/**
 * Check if query is a bulletin command (bulletins, what's new).
 *
 * @param {string} text - Query text (already stripped of ASK: prefix)
 * @returns {boolean}
 */
function isBulletinQuery(text) {
    if (!text) return false;
    const lower = text.toLowerCase().trim();
    // Match exact commands: "bulletins", "bulletin", "what's new", "show bulletins"
    // Don't match partial sentences like "bulletin board rules"
    return /^bulletins?$/i.test(lower) ||
           /^what'?s\s+new$/i.test(lower) ||
           /^show\s+bulletins?$/i.test(lower);
}

module.exports = {
    // Core functions
    postBulletin,
    getBulletins,
    markRead,
    cleanupOldBulletins,

    // Formatting helpers
    formatBulletinsForSlack,
    formatBulletinsForContext,
    formatBulletinData,

    // Query detection
    isBulletinQuery,

    // Constants (exported for testing)
    BULLETIN_TYPES,
    BULLETIN_FILE,
    DEFAULT_CLEANUP_DAYS,

    // Internal functions (exported for testing)
    loadBulletins,
    saveBulletins,
};
