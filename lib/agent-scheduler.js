/**
 * lib/agent-scheduler.js
 *
 * Cron-based scheduler for triggering agent proactive tasks.
 * Reads agent schedules from the registry and sets up node-cron jobs
 * to post TASK messages to each agent's channel at the scheduled times.
 *
 * LOGIC CHANGE 2026-03-28: Initial implementation of agent scheduler.
 * Enables agents to run proactively on a schedule (e.g., morning briefings,
 * nightly audits, weekly content creation) without manual triggering.
 */

'use strict';

const cron = require('node-cron');
const { loadAgents } = require('./agent-registry');
const { notifyOps } = require('./notify-owner');

// Store active cron jobs for cleanup
const activeJobs = new Map();

// Task templates for scheduled jobs
const TASK_TEMPLATES = {
    'morning-briefing': {
        description: 'Morning briefing',
        instructions: `Prepare the morning briefing for John. Include:
1. Today's calendar events and appointments
2. Weather forecast for Hamilton/Toronto
3. Any urgent emails or messages from overnight
4. Task reminders and deadlines
5. Any relevant Canadian holidays or pet awareness dates

Post the briefing summary to the channel.`,
    },
    'nightly-audit': {
        description: 'Nightly security audit',
        instructions: `Perform the nightly security audit. Review:
1. All commits to monitored repos from the last 24 hours
2. Check for credential exposure, injection vulnerabilities, insecure dependencies
3. Scan for OWASP top 10 issues
4. Review any new or changed API endpoints
5. Check for suspicious activity patterns

Post findings to the channel with severity ratings.`,
    },
    'weekly-critique': {
        description: 'Weekly business critique',
        instructions: `Time for your weekly critique! Review the week's activities and provide:
1. Contrarian takes on recent business decisions
2. Questions nobody else is asking
3. Devil's advocate perspectives on new features or plans
4. Witty observations about the week's events
5. One serious concern wrapped in humor

Keep it sharp, incisive, and thought-provoking.`,
    },
    'draft-weekly-posts': {
        description: 'Draft weekly LinkedIn posts',
        instructions: `Draft LinkedIn content for the coming week. Create:
1. One founder journey post (lessons learned, challenges faced)
2. One technical/building-in-public post (AI, automation, Raspberry Pi)
3. One pet industry insight or tip
4. One engagement post (question or conversation starter)

For each post:
- Hook in first line
- Story or insight
- Clear takeaway
- No buzzwords, ADHD-friendly short paragraphs

Post drafts for John's review and approval.`,
    },
    'content-calendar': {
        description: 'Social media content planning',
        instructions: `Update the content calendar and prepare posts. Tasks:
1. Review engagement metrics from recent posts
2. Plan content for the next week
3. Draft 2-3 posts for immediate scheduling
4. Suggest content themes based on upcoming pet awareness dates
5. Note any trending topics in the pet community

Keep content authentic, avoid corporate-speak. Post calendar and drafts for review.`,
    },
    'weekly-analytics': {
        description: 'Weekly marketing analytics review',
        instructions: `Compile the weekly marketing analytics report. Include:
1. Google Business Profile metrics (views, calls, directions)
2. Website traffic and conversion trends
3. Review/reputation monitoring summary
4. Competitor activity notes
5. ROI analysis of any paid campaigns
6. Recommended actions with expected impact

Post the analytics summary with actionable insights.`,
    },
};

// LOGIC CHANGE 2026-09-14: Deterministic scheduled tasks.
//
// A task name here runs CODE on its cron tick instead of posting a TASK: message
// for an LLM to interpret. `check-inbox` was the first: its template told a model
// to "check the email inbox and triage messages", and the model it reached had no
// mailbox access of any kind - lib/integrations/gmail.js had exactly one caller in
// the whole repository (morning-digest.js) and this was not it. Every 30 minutes
// between 09:00 and 21:00 the bridge asked an LLM to read an inbox it could not
// see, and whatever came back was posted as an inbox summary.
//
// Handlers are required to return a verdict object and to escalate their own
// failures; the scheduler only logs. See lib/email-check.js.
const DETERMINISTIC_TASKS = {
    'check-inbox': {
        description: 'Check and triage email inbox',
        run: async ({ slack, agent }) => {
            // Required lazily: this module is loaded by tests that do not want
            // gmail/googleapis pulled in, and by bridge-agent at startup.
            const { runInboxCheck } = require('./email-check');
            return runInboxCheck({ slack, channelId: agent.channel });
        },
    },
};

/**
 * Get the deterministic handler for a scheduled task, if there is one.
 *
 * @param {string} taskName - Name of the scheduled task
 * @returns {{ description: string, run: Function } | null}
 */
function getDeterministicTask(taskName) {
    return DETERMINISTIC_TASKS[taskName] || null;
}

/**
 * Run a scheduled task: deterministic handler if one is registered, otherwise
 * post the LLM TASK: message to the agent's channel.
 *
 * @param {object} slack - Slack WebClient instance
 * @param {object} agent - Agent record from the registry
 * @param {string} taskName - Name of the scheduled task
 * @returns {Promise<{ success: boolean, deterministic: boolean, error?: string, verdict?: object }>}
 */
async function runScheduledTask(slack, agent, taskName) {
    const deterministic = getDeterministicTask(taskName);
    if (deterministic) {
        try {
            const verdict = await deterministic.run({ slack, agent });
            return { success: verdict?.ok !== false, deterministic: true, verdict };
        } catch (err) {
            // A handler is required to escalate its own failures; a throw means
            // it did not get that far, so say so loudly here.
            console.error(`[scheduler] Deterministic task ${agent.id}:${taskName} threw:`, err.message);
            return { success: false, deterministic: true, error: err.message };
        }
    }

    const taskMessage = buildTaskMessage(agent.id, taskName);
    if (!taskMessage) {
        return { success: false, deterministic: false, error: `No template for task: ${taskName}` };
    }

    try {
        await slack.chat.postMessage({
            channel: agent.channel,
            text: taskMessage,
            unfurl_links: false,
        });
        return { success: true, deterministic: false };
    } catch (postErr) {
        return { success: false, deterministic: false, error: postErr.message };
    }
}

/**
 * Get the task template for a scheduled task.
 *
 * @param {string} taskName - Name of the scheduled task
 * @returns {{ description: string, instructions: string } | null}
 */
function getTaskTemplate(taskName) {
    return TASK_TEMPLATES[taskName] || null;
}

/**
 * Build a TASK message for posting to an agent's channel.
 *
 * @param {string} agentId - Agent ID
 * @param {string} taskName - Name of the scheduled task
 * @returns {string | null} - Task message or null if template not found
 */
function buildTaskMessage(agentId, taskName) {
    const template = getTaskTemplate(taskName);
    if (!template) {
        console.warn(`[scheduler] No template found for task: ${taskName}`);
        return null;
    }

    // Format as a proper TASK message that bridge-agent can parse
    return [
        `TASK: ${template.description} (scheduled by ${agentId})`,
        `INSTRUCTIONS: ${template.instructions}`,
    ].join('\n');
}

/**
 * Start the scheduler and set up cron jobs for all agents with schedules.
 *
 * @param {object} slack - Slack WebClient instance
 * @param {object} [options] - Options
 * @param {Function} [options.onTrigger] - Callback when a job triggers (for testing)
 * @returns {{ jobCount: number, agents: string[] }}
 */
function startScheduler(slack, options = {}) {
    const { onTrigger } = options;

    // Load agents from registry
    let agents;
    try {
        agents = loadAgents();
    } catch (err) {
        console.error('[scheduler] Failed to load agents:', err.message);
        return { jobCount: 0, agents: [], refusals: [] };
    }

    const refusals = [];
    const scheduledAgents = [];
    let jobCount = 0;

    for (const agent of agents) {
        // Skip agents without schedules or channels
        if (!agent.schedule || !agent.channel) {
            continue;
        }

        const { cron: cronExpr, task: taskName } = agent.schedule;

        // Validate cron expression
        if (!cronExpr || !cron.validate(cronExpr)) {
            console.warn(`[scheduler] Invalid cron expression for ${agent.id}: ${cronExpr}`);
            continue;
        }

        if (!taskName) {
            console.warn(`[scheduler] No task name specified for ${agent.id}`);
            continue;
        }

        // LOGIC CHANGE 2026-09-14: Refuse to register a job whose task name
        // resolves to nothing. Previously such a job registered happily and then
        // logged "No template found" on every single tick, forever, with no
        // other signal - a scheduled job that could never do anything.
        if (!getDeterministicTask(taskName) && !getTaskTemplate(taskName)) {
            console.error(`[scheduler] Unknown task "${taskName}" for ${agent.id} - no deterministic handler and no template. Job NOT registered.`);
            // LOGIC CHANGE 2026-09-14: a refusal to register is a scheduled
            // capability that silently does not exist. Startup is the only moment
            // anyone could learn that, and a startup log line in a container nobody
            // tails is not learning it.
            refusals.push(`${agent.id}:${taskName} — no deterministic handler and no template`);
            continue;
        }

        // Create cron job
        const job = cron.schedule(cronExpr, async () => {
            console.log(`[scheduler] Triggered ${agent.id}:${taskName}`);

            // Call optional callback (for testing)
            if (onTrigger) {
                onTrigger(agent.id, taskName);
            }

            // LOGIC CHANGE 2026-09-14: Route through runScheduledTask so a task
            // with a deterministic handler runs code instead of asking an LLM.
            const outcome = await runScheduledTask(slack, agent, taskName);
            if (outcome.success) {
                console.log(`[scheduler] Ran ${agent.id}:${taskName} (${outcome.deterministic ? 'deterministic' : 'posted TASK'})`);
            } else {
                const reason = outcome.error || 'handler reported failure';
                console.error(`[scheduler] ${agent.id}:${taskName} failed: ${reason}`);
                // LOGIC CHANGE 2026-09-14: escalate, do not just log. THE live
                // instance: story-bot's weekly job posts to a channel the bot was
                // never joined to, Slack answers `not_in_channel`, and the job
                // "succeeding" and the job's output reaching a human are different
                // events - only the first was observed. The fix is the visibility,
                // not the channel membership, which is the owner's to set.
                await notifyOps(
                    `:calendar: *Scheduled job failed* — \`${agent.id}:${taskName}\` (cron \`${cronExpr}\`)\n` +
                    `${reason}\n` +
                    `Channel: \`${agent.channel || 'none'}\`. If this is \`not_in_channel\`, the bot is not a ` +
                    'member of that channel — invite it, or clear the agent\'s schedule.'
                ).catch(notifyErr => {
                    console.error('[scheduler] Could not escalate scheduled-job failure:', notifyErr.message);
                });
            }
        }, {
            scheduled: true,
            timezone: 'America/Toronto',
        });

        // Store the job for cleanup
        activeJobs.set(`${agent.id}:${taskName}`, job);
        scheduledAgents.push(agent.id);
        jobCount++;

        console.log(`[scheduler] Scheduled ${agent.id}:${taskName} with cron ${cronExpr}`);
    }

    console.log(`[scheduler] Started with ${jobCount} jobs for agents: ${scheduledAgents.join(', ') || 'none'}`);

    if (refusals.length > 0) {
        notifyOps(
            `:calendar: *Scheduler refused ${refusals.length} job(s) at startup* — these schedules do not exist:\n` +
            refusals.map(r => `• ${r}`).join('\n')
        ).catch(notifyErr => {
            console.error('[scheduler] Could not escalate registration refusals:', notifyErr.message);
        });
    }

    return { jobCount, agents: scheduledAgents, refusals };
}

/**
 * Stop all scheduled jobs.
 */
function stopScheduler() {
    let stopped = 0;
    for (const [key, job] of activeJobs.entries()) {
        job.stop();
        stopped++;
    }
    activeJobs.clear();
    console.log(`[scheduler] Stopped ${stopped} jobs`);
    return stopped;
}

/**
 * Get the current list of active jobs.
 *
 * @returns {string[]} Array of job keys (agentId:taskName)
 */
function getActiveJobs() {
    return Array.from(activeJobs.keys());
}

/**
 * Manually trigger a scheduled task (for testing or on-demand execution).
 *
 * @param {object} slack - Slack WebClient instance
 * @param {string} agentId - Agent ID
 * @param {string} taskName - Task name
 * @returns {Promise<{ success: boolean, error?: string }>}
 */
async function triggerTask(slack, agentId, taskName) {
    // Load agents to find the channel
    let agents;
    try {
        agents = loadAgents();
    } catch (err) {
        return { success: false, error: `Failed to load agents: ${err.message}` };
    }

    const agent = agents.find(a => a.id === agentId);
    if (!agent) {
        return { success: false, error: `Agent not found: ${agentId}` };
    }

    if (!agent.channel) {
        return { success: false, error: `Agent has no channel: ${agentId}` };
    }

    // LOGIC CHANGE 2026-09-14: Same path as the cron tick, so a manual trigger
    // and a scheduled one cannot diverge.
    const outcome = await runScheduledTask(slack, agent, taskName);
    if (!outcome.success) {
        return { success: false, error: outcome.error || 'handler reported failure' };
    }
    console.log(`[scheduler] Manually triggered ${agentId}:${taskName}`);
    return { success: true, ...(outcome.verdict ? { verdict: outcome.verdict } : {}) };
}

module.exports = {
    startScheduler,
    stopScheduler,
    getActiveJobs,
    triggerTask,
    buildTaskMessage,
    getTaskTemplate,
    getDeterministicTask,
    runScheduledTask,
    TASK_TEMPLATES,
    DETERMINISTIC_TASKS,
};
