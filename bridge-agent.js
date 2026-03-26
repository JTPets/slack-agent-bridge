// bridge-agent.js - Slack polling agent for Claude Code CLI tasks
// Single-file Node.js agent that monitors Slack channels for task messages

const { WebClient } = require('@slack/web-api');
const { spawn } = require('child_process');
const fs = require('fs').promises;
const path = require('path');
const os = require('os');

// Configuration from environment variables
const SLACK_BOT_TOKEN = process.env.SLACK_BOT_TOKEN;
const SLACK_CHANNEL_ID = process.env.SLACK_CHANNEL_ID;
const POLL_INTERVAL_MS = parseInt(process.env.POLL_INTERVAL_MS, 10) || 5000;

// Initialize Slack client
const slack = new WebClient(SLACK_BOT_TOKEN);

/**
 * Post a message to a Slack channel
 * @param {string} channel - Channel ID
 * @param {string} message - Message text
 */
async function postToSlack(channel, message) {
    try {
        await slack.chat.postMessage({
            channel: channel,
            text: message
        });
    } catch (error) {
        console.error('Failed to post to Slack:', error.message);
    }
}

/**
 * Run a command using spawn and return a promise
 * @param {string} command - Command to run
 * @param {string[]} args - Command arguments
 * @param {object} options - Spawn options
 * @returns {Promise<{code: number, stdout: string, stderr: string}>}
 */
function runCommand(command, args, options = {}) {
    return new Promise((resolve) => {
        const child = spawn(command, args, {
            ...options,
            encoding: 'utf8'
        });

        let stdout = '';
        let stderr = '';

        if (child.stdout) {
            child.stdout.on('data', (data) => {
                stdout += data.toString();
            });
        }

        if (child.stderr) {
            child.stderr.on('data', (data) => {
                stderr += data.toString();
            });
        }

        child.on('close', (code) => {
            resolve({ code: code || 0, stdout, stderr });
        });

        child.on('error', (error) => {
            resolve({ code: 1, stdout, stderr: error.message });
        });
    });
}

/**
 * Clone a repository to a temporary directory
 * LOGIC CHANGE 2026-03-26: Added fallback to main branch if specified branch does not exist
 * @param {string} repoUrl - Git repository URL
 * @param {string} branch - Branch to clone
 * @param {string} targetDir - Directory to clone into
 * @returns {Promise<{success: boolean, branch: string, error?: string}>}
 */
async function cloneRepo(repoUrl, branch, targetDir) {
    // First attempt: clone the specified branch
    const result = await runCommand('git', ['clone', '--branch', branch, '--single-branch', repoUrl, targetDir]);

    if (result.code === 0) {
        return { success: true, branch: branch };
    }

    // LOGIC CHANGE 2026-03-26: If specified branch fails, fallback to main
    if (branch !== 'main') {
        console.warn(`[bridge-agent] Branch ${branch} not found, falling back to main`);

        // Clean up failed clone attempt if directory was created
        await fs.rm(targetDir, { recursive: true, force: true }).catch(() => {});

        const fallbackResult = await runCommand('git', ['clone', '--branch', 'main', '--single-branch', repoUrl, targetDir]);

        if (fallbackResult.code === 0) {
            return { success: true, branch: 'main' };
        }

        return {
            success: false,
            branch: 'main',
            error: `Failed to clone both branch '${branch}' and 'main': ${fallbackResult.stderr}`
        };
    }

    return {
        success: false,
        branch: branch,
        error: `Failed to clone branch '${branch}': ${result.stderr}`
    };
}

/**
 * Parse task message to extract BRANCH and other fields
 * @param {string} message - Task message text
 * @returns {object} Parsed task fields
 */
function parseTaskMessage(message) {
    const lines = message.split('\n');
    const task = {
        branch: 'main',
        repo: null,
        instructions: ''
    };

    let inInstructions = false;

    for (const line of lines) {
        const trimmed = line.trim();

        if (trimmed.startsWith('BRANCH:')) {
            task.branch = trimmed.substring(7).trim();
        } else if (trimmed.startsWith('REPO:')) {
            task.repo = trimmed.substring(5).trim();
        } else if (trimmed.startsWith('INSTRUCTIONS:')) {
            inInstructions = true;
            const instructionStart = trimmed.substring(13).trim();
            if (instructionStart) {
                task.instructions = instructionStart;
            }
        } else if (inInstructions) {
            task.instructions += (task.instructions ? '\n' : '') + line;
        }
    }

    return task;
}

/**
 * Execute a task from a parsed task message
 * @param {string} channel - Slack channel ID
 * @param {object} task - Parsed task object
 */
async function executeTask(channel, task) {
    let tempDir;

    try {
        // Create temp directory
        tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'task-'));

        if (!task.repo) {
            throw new Error('No REPO specified in task message');
        }

        // Clone the repository
        const cloneResult = await cloneRepo(task.repo, task.branch, tempDir);

        if (!cloneResult.success) {
            throw new Error(cloneResult.error);
        }

        // Notify if we fell back to main
        if (cloneResult.branch !== task.branch) {
            await postToSlack(channel, `⚠️ Branch '${task.branch}' not found, using 'main' instead`);
        }

        // Execute Claude Code CLI
        const claudeResult = await runCommand('claude', ['--print', task.instructions], {
            cwd: tempDir,
            env: { ...process.env }
        });

        if (claudeResult.code !== 0) {
            throw new Error(`Claude Code CLI failed: ${claudeResult.stderr}`);
        }

        await postToSlack(channel, `✅ Task completed:\n${claudeResult.stdout.substring(0, 3000)}`);

    } catch (error) {
        // ALWAYS report errors to Slack
        await postToSlack(channel, `❌ Error: ${error.message}`);

        // Log error details (but NEVER tokens)
        console.error('Task failed:', {
            message: error.message,
            stack: error.stack
        });

    } finally {
        // ALWAYS cleanup temp dirs
        if (tempDir) {
            await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {});
        }
    }
}

/**
 * Process a Slack message
 * @param {object} message - Slack message object
 */
async function processMessage(message) {
    const text = message.text || '';

    // Check if this is a task message
    if (text.includes('REPO:') || text.includes('INSTRUCTIONS:')) {
        const task = parseTaskMessage(text);
        await executeTask(message.channel || SLACK_CHANNEL_ID, task);
    }
}

/**
 * Poll Slack channel for new messages
 */
async function pollChannel() {
    try {
        const result = await slack.conversations.history({
            channel: SLACK_CHANNEL_ID,
            limit: 10
        });

        if (result.messages && result.messages.length > 0) {
            for (const message of result.messages) {
                // Process only new, unprocessed messages
                // (In a real implementation, track processed message timestamps)
                await processMessage(message);
            }
        }
    } catch (error) {
        console.error('Poll failed:', error.message);
    }
}

/**
 * Log startup configuration (without secrets)
 */
function logStartupConfig() {
    console.log('=== Bridge Agent Starting ===');
    console.log('Configuration:');
    console.log(`  SLACK_CHANNEL_ID: ${SLACK_CHANNEL_ID ? '(set)' : '(not set)'}`);
    console.log(`  POLL_INTERVAL_MS: ${POLL_INTERVAL_MS}`);
    console.log(`  SLACK_BOT_TOKEN: ${SLACK_BOT_TOKEN ? '(set)' : '(not set)'}`);
    // NEVER log actual token values
    console.log('==============================');
}

/**
 * Validate required configuration
 * @returns {boolean}
 */
function validateConfig() {
    const errors = [];

    if (!SLACK_BOT_TOKEN) {
        errors.push('SLACK_BOT_TOKEN is required');
    }
    if (!SLACK_CHANNEL_ID) {
        errors.push('SLACK_CHANNEL_ID is required');
    }

    if (errors.length > 0) {
        console.error('Configuration errors:');
        errors.forEach(e => console.error(`  - ${e}`));
        return false;
    }

    return true;
}

/**
 * Main entry point
 */
async function main() {
    logStartupConfig();

    if (!validateConfig()) {
        process.exit(1);
    }

    console.log('Starting polling loop...');
    setInterval(pollChannel, POLL_INTERVAL_MS);

    // Run initial poll
    await pollChannel();
}

// Export for testing
module.exports = {
    cloneRepo,
    parseTaskMessage,
    runCommand
};

// Start the agent
main().catch(error => {
    console.error('Fatal error:', error.message);
    process.exit(1);
});
