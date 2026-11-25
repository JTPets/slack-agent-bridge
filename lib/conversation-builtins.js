'use strict';

/**
 * lib/conversation-builtins.js
 *
 * The phrase-matched built-in commands an `ASK:` can name, answered without a model:
 * task status, owner tasks, create channel, staff tasks, bulletins, team standup, and the
 * approval queue (list, approve, reject, show). One spoke per command; `answerBuiltin` is
 * the hub processConversation calls before it asks a model.
 *
 * LOGIC CHANGE 2026-11-25 (WORK-TODO #10, B35): moved out of bridge-agent.js
 * processConversation, where they were a dozen inline `if` blocks, each with its own copy of
 * the thread-reply post, ahead of the model answer. Behaviour is unchanged: the same
 * matchers in the same order, the same replies, and the same channel rule (status, owner
 * tasks and create channel answer only in the bridge channel; the rest answer in any
 * channel, as before). Every reply goes through ctx.reply, the one thread-reply post.
 *
 * Not merged into lib/command-router.js's table: that table runs only in the bridge
 * channel and has its own agent-channel rule (lib/agent-channel-verbs.js), so moving these
 * there would change where staff, bulletin, standup and approval commands answer. That is a
 * behaviour decision, left to the owner.
 */

const {
    isStatusQuery,
    isCreateChannelCommand,
    parseCreateChannelCommand,
    isApprovalQuery,
    isApproveCommand,
    parseApproveCommand,
    isRejectCommand,
    parseRejectCommand,
    isShowTaskCommand,
    parseShowTaskCommand,
} = require('./task-parser');
const { isOwnerTasksQuery, formatPendingTasks } = require('./owner-tasks');
const staffTasks = require('./staff-tasks');
const bulletinBoard = require('./bulletin-board');
const watercooler = require('./watercooler');
const approvalQueue = require('./approval-queue');
const botTaskLedger = require('./bot-task-ledger');

async function answerStatus(q, ctx) {
    // LOGIC CHANGE 2026-11-08 (WORK-TODO #39): say whether each recent task's commit
    // reached main. A failure here costs the merge column, never the reply.
    let mergeStates = new Map();
    try {
        mergeStates = await ctx.resolveMergeStates();
    } catch (e) {
        console.error(`[${ctx.agentId}] Merge state unavailable: ${e.message}`);
    }
    await ctx.reply(ctx.formatStatusResponse(mergeStates));
}

async function answerOwnerTasks(q, ctx) {
    await ctx.reply(formatPendingTasks());
}

async function answerCreateChannel(q, ctx) {
    const channelName = parseCreateChannelCommand(q);
    if (!channelName) {
        await ctx.reply(':x: Invalid channel name. Use: `create channel #channel-name`');
        return;
    }
    try {
        const result = await ctx.slackClient.ensureChannel(channelName);
        const action = result.created ? 'Created' : 'Found existing';
        await ctx.reply(`:white_check_mark: ${action} channel <#${result.channelId}|${result.name}>\nChannel ID: \`${result.channelId}\``);
        console.log(`[${ctx.agentId}] Channel ${action.toLowerCase()}: ${result.name} (${result.channelId})`);
    } catch (channelErr) {
        await ctx.reply(`:x: Failed to create channel: ${channelErr.message}`);
        console.error(`[${ctx.agentId}] Create channel failed:`, channelErr.message);
    }
}

async function staffTaskResponse(q, ctx) {
    const commandType = staffTasks.parseStaffTaskCommandType(q);
    if (commandType === 'overdue') return staffTasks.formatOverdueList();
    if (commandType === 'today') return staffTasks.formatTodayList();
    if (commandType !== 'assign') return ':x: Unknown staff task command.';

    const parsed = staffTasks.parseAssignCommand(q);
    if (!parsed) return ':x: Invalid format. Use: `assign [task] to [name] by [time]`';
    const staffMember = staffTasks.getStaffByName(parsed.assignee);
    const assigneeId = staffMember ? staffMember.slackId : parsed.assignee;
    if (!ctx.storeTasksChannel) return ':x: STORE_TASKS_CHANNEL_ID not configured. Add it to .env first.';
    await staffTasks.createTask(ctx.slack, ctx.storeTasksChannel, {
        description: parsed.task,
        assignee: assigneeId,
        dueTime: parsed.dueTime,
        priority: 'medium',
    });
    return `:white_check_mark: Task created and posted to <#${ctx.storeTasksChannel}>`;
}

async function answerStaffTask(q, ctx) {
    try {
        await ctx.reply(await staffTaskResponse(q, ctx));
    } catch (staffErr) {
        await ctx.reply(`:x: Staff task error: ${staffErr.message}`);
        console.error(`[${ctx.agentId}] Staff task command failed:`, staffErr.message);
    }
}

async function answerBulletins(q, ctx) {
    await ctx.reply(bulletinBoard.formatBulletinsForSlack(bulletinBoard.getBulletins({ limit: 10 })));
}

async function answerStandup(q, ctx) {
    await ctx.reply(':coffee: Starting team standup... This will post to #sqtools-ops.');
    try {
        const result = await watercooler.runStandup(ctx.slack);
        await ctx.reply(result.success
            ? `:white_check_mark: Standup complete! ${result.messagesPosted} messages posted.`
            : `:warning: Standup finished with issues: ${result.errors.join(', ')}`);
    } catch (standupErr) {
        await ctx.reply(`:x: Standup failed: ${standupErr.message}`);
        console.error(`[${ctx.agentId}] Standup failed:`, standupErr.message);
    }
}

async function answerApprovalQuery(q, ctx) {
    await ctx.reply(approvalQueue.formatPendingTasks());
}

/** Post one approved task to its agent's channel, recorded so the poll loop runs it (#81). */
async function postApproved(task, ctx) {
    if (!task.targetChannel || !task.taskMessage) return false;
    await botTaskLedger.postBridgeTask(ctx.slack, {
        channel: task.targetChannel,
        text: task.taskMessage,
        unfurl_links: false,
    }, { onUnrecorded: ctx.postToOps });
    return true;
}

async function answerApprove(q, ctx) {
    const parsed = parseApproveCommand(q);
    if (!parsed) {
        await ctx.reply(':x: Invalid format. Use: `approve <task-id>` or `approve all`');
        return;
    }
    try {
        if (parsed.all) {
            const result = approvalQueue.approveAllTasks(ctx.userId);
            if (result.count === 0) {
                await ctx.reply(':information_source: No pending tasks to approve.');
                return;
            }
            let posted = 0;
            for (const task of result.tasks) {
                if (await postApproved(task, ctx)) posted++;
            }
            await ctx.reply(`:white_check_mark: Approved and posted ${posted} task(s) to agent channels.`);
        } else {
            const result = approvalQueue.approveTask(parsed.id, ctx.userId);
            if (!result.success) {
                await ctx.reply(`:x: ${result.error}`);
                return;
            }
            await postApproved(result.task, ctx);
            await ctx.reply(`:white_check_mark: Approved task \`${parsed.id}\` and posted to <#${result.task.targetChannel}>.`);
        }
    } catch (approveErr) {
        await ctx.reply(`:x: Approval failed: ${approveErr.message}`);
        console.error(`[${ctx.agentId}] Approve command failed:`, approveErr.message);
    }
}

async function answerReject(q, ctx) {
    const parsed = parseRejectCommand(q);
    if (!parsed) {
        await ctx.reply(':x: Invalid format. Use: `reject <task-id> [reason]` or `reject all`');
        return;
    }
    try {
        if (parsed.all) {
            const result = approvalQueue.rejectAllTasks(ctx.userId, parsed.reason);
            await ctx.reply(result.count > 0
                ? `:wastebasket: Rejected ${result.count} task(s).`
                : ':information_source: No pending tasks to reject.');
        } else {
            const result = approvalQueue.rejectTask(parsed.id, ctx.userId, parsed.reason);
            await ctx.reply(result.success ? `:wastebasket: Rejected task \`${parsed.id}\`.` : `:x: ${result.error}`);
        }
    } catch (rejectErr) {
        await ctx.reply(`:x: Rejection failed: ${rejectErr.message}`);
        console.error(`[${ctx.agentId}] Reject command failed:`, rejectErr.message);
    }
}

async function answerShowTask(q, ctx) {
    const taskId = parseShowTaskCommand(q);
    if (!taskId) {
        await ctx.reply(':x: Invalid format. Use: `show task <task-id>`');
        return;
    }
    await ctx.reply(approvalQueue.formatTaskDetails(approvalQueue.getTaskById(taskId)));
}

/**
 * The built-ins, in the order they are tried (the order processConversation tried them).
 * `bridgeOnly` answers only in the bridge channel; everything else answers anywhere.
 */
const BUILTINS = [
    { name: 'status', bridgeOnly: true, matches: isStatusQuery, answer: answerStatus },
    { name: 'owner tasks', bridgeOnly: true, matches: isOwnerTasksQuery, answer: answerOwnerTasks },
    { name: 'create channel', bridgeOnly: true, matches: isCreateChannelCommand, answer: answerCreateChannel },
    { name: 'staff task', matches: (q) => staffTasks.isStaffTaskCommand(q), answer: answerStaffTask },
    { name: 'bulletins', matches: (q) => bulletinBoard.isBulletinQuery(q), answer: answerBulletins },
    { name: 'standup', matches: (q) => watercooler.isStandupCommand(q), answer: answerStandup },
    { name: 'approval queue', matches: isApprovalQuery, answer: answerApprovalQuery },
    { name: 'approve', matches: isApproveCommand, answer: answerApprove },
    { name: 'reject', matches: isRejectCommand, answer: answerReject },
    { name: 'show task', matches: isShowTaskCommand, answer: answerShowTask },
];

/**
 * The hub: answer `questionText` if it names a built-in, and say whether it did.
 *
 * @param {string} questionText - the ASK: text with the prefix removed
 * @param {object} ctx - { reply(text), inBridgeChannel, agentId, msgTs, userId, slack,
 *   slackClient, storeTasksChannel, postToOps, resolveMergeStates(), formatStatusResponse(states) }
 * @returns {Promise<boolean>} true when a built-in answered (the model is not asked)
 */
async function answerBuiltin(questionText, ctx) {
    for (const builtin of BUILTINS) {
        if (builtin.bridgeOnly && !ctx.inBridgeChannel) continue;
        if (!builtin.matches(questionText)) continue;
        console.log(`[${ctx.agentId}] Built-in \`${builtin.name}\` detected: ${ctx.msgTs}`);
        await builtin.answer(questionText, ctx);
        console.log(`[${ctx.agentId}] Built-in \`${builtin.name}\` ${ctx.msgTs} answered`);
        return true;
    }
    return false;
}

module.exports = { answerBuiltin, BUILTINS };
