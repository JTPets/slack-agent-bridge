/**
 * lib/agent-task-catalogue.js
 *
 * WHAT scheduled tasks exist. `lib/agent-scheduler.js` owns WHEN and HOW they fire.
 *
 * LOGIC CHANGE 2026-09-15: Extracted verbatim from `lib/agent-scheduler.js` (WORK-TODO
 * #10). The concern boundary is catalogue vs. registrar: everything here is a
 * declaration of a task that can be scheduled — an LLM prompt template, or a
 * deterministic handler — and none of it knows anything about cron, channels or Slack.
 * The registrar it came from does nothing else but that.
 *
 * Nothing was renamed and no behaviour changed: `TASK_TEMPLATES`, `DETERMINISTIC_TASKS`,
 * `getTaskTemplate` and `getDeterministicTask` are re-exported from
 * `lib/agent-scheduler.js`, so every existing caller keeps working against the same
 * names. This repository cannot prove a pure move is behaviour-preserving — see the
 * commit body for what smoke actually covers here, which is nothing.
 */

'use strict';

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
 * Get the task template for a scheduled task.
 *
 * @param {string} taskName - Name of the scheduled task
 * @returns {{ description: string, instructions: string } | null}
 */
function getTaskTemplate(taskName) {
    return TASK_TEMPLATES[taskName] || null;
}

module.exports = {
    TASK_TEMPLATES,
    DETERMINISTIC_TASKS,
    getTaskTemplate,
    getDeterministicTask,
};
