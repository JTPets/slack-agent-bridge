'use strict';

/**
 * tests/helpers/module-splits-table.js
 *
 * THE table tests/module-splits.test.js checks: one entry per WORK-TODO #10 split, with
 * the facade, its parts and the pre-split `module.exports` keys copied from the parent
 * commit. Moved out of the suite on 2026-11-12 (B28) so the suite stays under the
 * 300-line limit as the table grows; the suite is unchanged in what it asserts.
 *
 * Optional keys: `wrapped` names exports the facade wraps on purpose (identity is not
 * checked); `facadeOverLimit` exempts the facade itself, never its parts, from the
 * 300-line check, for a facade that keeps a declared exception.
 */

const SPLITS = [
    {
        facade: 'lib/integrations/gmail.js',
        parts: ['lib/integrations/gmail-auth.js', 'lib/integrations/gmail-message.js'],
        exports: [
            'getRecentEmails', 'fetchRecentEmails', 'getEmailById', 'getEmailHeaders', 'hasCredentials',
            'createGmailClient', 'getRefreshToken', 'stripHtml', 'decodeBase64Url', 'getHeader',
            'extractBody', 'transformEmail',
        ],
    },
    {
        facade: 'lib/watercooler.js',
        parts: ['lib/watercooler-catalogue.js', 'lib/watercooler-context.js', 'lib/watercooler-prompt.js'],
        exports: [
            'runStandup', 'isStandupCommand', 'parseStandupType', 'getStandupSchedule',
            'getLastStandupTime', 'saveLastStandupTime', 'getBulletinsSinceLastStandup',
            'getRecentCompletions', 'getAgentBacklog', 'formatBulletinsSummary',
            'formatCompletionsSummary', 'formatBacklogSummary', 'formatPreviousMessages',
            'buildStandupPrompt', 'getAgentDisplay', 'sortAgentsForStandup',
            'filterStandupParticipants', 'isGeminiConfigured', 'init', 'AGENT_DISPLAY',
            'DEFAULT_WATERCOOLER_STATE_FILE', 'WATERCOOLER_STATE_FILE', 'STANDUP_TYPES',
            'AGENT_STANDUP_PROMPTS', 'DEFAULT_STANDUP_TYPE',
        ],
    },
    {
        facade: 'lib/memory-tiers.js',
        parts: ['lib/memory-tiers-store.js', 'lib/memory-tiers-entries.js', 'lib/memory-tiers-maintenance.js'],
        exports: [
            'MEMORY_FILES', 'DEFAULT_SHORT_TERM_TTL', 'DEFAULT_LONG_TERM_DECAY_DAYS', 'AUTO_PROMOTE_THRESHOLD',
            'createEntry', 'getAgentMemoryPath', 'ensureMemoryDir', 'loadMemoryFile', 'saveMemoryFile',
            'isExpired', 'shouldDecay', 'addWorkingMemory', 'clearWorkingMemory', 'addShortTerm',
            'promoteToLongTerm', 'addPermanent', 'getRelevantMemory', 'cleanupMemory', 'autoPromote',
            'startupCleanup', 'migrateToTiers', 'touchEntry',
        ],
    },
    {
        facade: 'lib/approval-queue.js',
        parts: ['lib/approval-queue-store.js', 'lib/approval-queue-decisions.js', 'lib/approval-queue-view.js'],
        // init is wrapped on purpose: the store's init sets the path, the facade's
        // returns the facade so `init(...).queueTask` keeps working.
        wrapped: ['init'],
        exports: [
            'init', 'loadQueue', 'saveQueue', 'queueTask', 'getPendingTasks', 'getTaskById', 'approveTask',
            'approveAllTasks', 'rejectTask', 'rejectAllTasks', 'cleanup', 'getStats', 'formatPendingTasks',
            'formatTaskDetails', 'requiresApproval', 'clearQueue', 'DEFAULT_QUEUE_FILE',
            'APPROVAL_REQUIRED_SOURCES', 'MAX_PENDING_AGE_MS',
        ],
    },
    {
        facade: 'lib/staff-tasks.js',
        parts: ['lib/staff-tasks-store.js', 'lib/staff-tasks-time.js', 'lib/staff-tasks-slack.js', 'lib/staff-tasks-commands.js'],
        exports: [
            'loadStaff', 'getStaffByName', 'getStaffBySlackId', 'getEscalationRecipients',
            'loadDailyTemplate', 'loadTasksState', 'saveTasksState', 'formatTask', 'formatCompletedTask',
            'createTask', 'completeTask', 'getDailyTasks', 'getOverdueTasks', 'getCriticalOverdueTasks',
            'postDailyTasks', 'escalateTask', 'checkAndEscalateOverdue', 'isStoreHours',
            'parseTimeToMinutes', 'getCurrentTimeMinutes', 'normalizeTimeString', 'parseAssignCommand',
            'isStaffTaskCommand', 'parseStaffTaskCommandType', 'formatDigestSummary', 'formatOverdueList',
            'formatTodayList', 'PRIORITY_EMOJI', 'STORE_HOURS', 'STAFF_FILE', 'TEMPLATE_FILE', 'init',
            'DEFAULT_TASKS_STATE_FILE', 'TASKS_STATE_FILE',
        ],
    },
    {
        facade: 'lib/security-followup.js',
        parts: ['lib/security-findings.js', 'lib/security-followup-dedup.js'],
        exports: [
            'parseFindings', 'groupFindingsByFile', 'getHighestSeverity', 'findCodeAgent',
            'buildTaskMessage', 'filterActionableFindings', 'processSecurityBulletin',
            'createSecurityFollowupHandler', 'formatFollowupSummary', 'wasRecentlyCreated',
            'recordTaskCreated', 'cleanupDedupMap', 'clearDedupMap', 'SEVERITY_LEVELS', 'SEVERITY_EMOJI',
        ],
    },
    {
        facade: 'memory/memory-manager.js',
        parts: ['memory/memory-store.js', 'memory/memory-context.js'],
        exports: [
            'loadMemory', 'saveMemory', 'addTask', 'completeTask', 'failTask', 'getTaskHistory',
            'getActiveTasks', 'getContext', 'updateContext', 'buildTaskContext', 'buildAgentContext',
            'addAgentWorkingMemory', 'clearAgentWorkingMemory', 'addAgentShortTerm', 'promoteAgentMemory',
            'setAgentPermanent', 'cleanupAgentMemory', 'autoPromoteAgentMemory', 'startupMemoryCleanup',
            'migrateAgentMemory',
        ],
    },
    {
        facade: 'lib/agent-context.js',
        parts: ['lib/agent-context-sources.js', 'lib/agent-context-ops.js', 'lib/agent-context-voices.js'],
        exports: [
            'buildEnrichedPrompt', 'buildAgentDataContext', 'buildSecretaryContext', 'buildSecurityContext',
            'buildJesterContext', 'buildStoryBotContext', 'buildCodeAgentContext', 'buildGenericContext',
            'formatEventsForPrompt', 'ANTI_HALLUCINATION_RULE',
        ],
    },
    {
        facade: 'bots/storefront.js',
        parts: ['bots/storefront-session.js', 'bots/storefront-records.js', 'bots/storefront-prompt.js'],
        exports: [
            'app', 'getOrCreateSession', 'buildPrompt', 'sanitizeInput', 'cleanExpiredSessions', 'sessions',
            'STOREFRONT_AGENT_CONFIG', 'loadDeliveryQuotes', 'saveDeliveryQuotes', 'logDeliveryQuoteToSlack',
            'DELIVERY_QUOTES_FILE', 'initializeCatalog', 'catalogInitialized',
        ],
    },
    {
        facade: 'lib/bridge-state.js',
        parts: ['lib/bridge-state-poll.js', 'lib/bridge-state-workspace.js'],
        // init is wrapped on purpose: it forwards to both parts and returns the facade.
        wrapped: ['init'],
        exports: [
            'init', 'loadState', 'saveState', 'getLastChecked', 'setLastChecked', 'loadProcessedTasks',
            'saveProcessedTasks', 'isTaskProcessed', 'markTaskProcessed', 'cleanupProcessedTasks',
            'loadChannelMap', 'saveChannelMap', 'getChannelId', 'setChannelId', 'loadActivations',
            'getActivation', 'setActivation', 'clearActivation', 'DEFAULT_CHANNEL_MAP_FILE',
            'DEFAULT_ACTIVATION_FILE',
        ],
    },
    {
        // runLLM is in lib/llm-dispatch.js, not the facade, so lib/llm-fallback.js can
        // call it without a require cycle back through lib/llm-runner.js.
        facade: 'lib/llm-runner.js',
        parts: ['lib/llm-errors.js', 'lib/llm-defaults.js', 'lib/llm-dispatch.js', 'lib/llm-adapter-claude.js',
            'lib/llm-adapter-gemini.js', 'lib/llm-adapter-ollama.js', 'lib/llm-fallback.js', 'lib/llm-http-failure.js'],
        exports: [
            'runLLM', 'runWithFallback', 'runClaudeAdapter', 'runOpenAIAdapter', 'runOllamaAdapter',
            'runGeminiAdapter', 'validateGeminiOnStartup', 'validateOllamaOnStartup', 'isOllamaAvailable',
            'DEFAULT_PROVIDER', 'DEFAULT_MAX_TURNS', 'DEFAULT_TIMEOUT', 'DEFAULT_FALLBACK_PROVIDER',
            'FALLBACK_ENABLED', 'DEFAULT_FALLBACK_CHAINS', 'DEFAULT_OLLAMA_BASE_URL', 'DEFAULT_OLLAMA_KEEP_ALIVE',
            'DEFAULT_OLLAMA_NUM_CTX', 'DEFAULT_OLLAMA_TIMEOUT', 'resolveFallbackChain', 'providerAvailability',
            'fallbackReasonFor', 'normalizeThink', 'describeClaudeExit', 'signalFromExitCode', 'isRateLimitError',
            'RateLimitError', 'RATE_LIMIT_PATTERNS', 'isBandwidthExhausted', 'BandwidthExhaustedError',
            'BANDWIDTH_EXHAUSTION_PATTERNS', 'MIN_REAL_OUTPUT_LENGTH', 'WARN_AT_FRACTION',
        ],
    },
    {
        facade: 'lib/integrations/holidays.js',
        parts: ['lib/integrations/holidays-public.js', 'lib/integrations/pet-awareness.js', 'lib/integrations/local-date.js'],
        exports: [
            'getTodayHoliday', 'getTodayPetAwareness', 'getActivePetAwareness', 'getUpcomingHolidays',
            'getUpcomingPetAwareness', 'isHoliday', 'getTodaySpecialDates', 'PET_AWARENESS_DATES',
            'filterOntarioHolidays', 'parseDate', 'formatDate', 'clearCache', 'CACHE_TTL_MS',
        ],
    },
    {   facade: 'auto-update.js', // #10 Wave 4, 2026-11-11; DEFAULT_DEPS and gatedDeps stay in it
        parts: ['config', 'git', 'state', 'deferral', 'apply', 'daemon'].map((p) => `lib/update-${p}.js`),
        exports: ['checkForUpdates', 'abortUpdate', 'revertTo', 'flushAndExit', 'loadState', 'saveState', 'gitResetTo',
            'checkTaskQueue', 'evaluateTaskDeferral', 'UPDATE_PENDING_FILE', 'RESTART_EXIT_CODE', 'DEFAULT_DEPS',
            'LOCAL_REPO_DIR', 'CHECK_INTERVAL_MS', 'gatedDeps'],
    },
    {
        // Nothing the router exported moved: the four report handlers and renderHelp
        // were never exported, so the export list is unchanged and the guard that
        // matters is tests/command-router.test.js enumerating handlers across both files.
        // morning-digest.js is not listed: it has no exports and requiring it starts the
        // cron job, so its split is pinned by tests/digest-sections.test.js instead.
        facade: 'lib/command-router.js',
        parts: ['lib/command-renderers.js'],
        exports: [
            'COMMANDS', 'NOT_COMMANDS', 'DETERMINISTIC_TASKS', 'parseCommand', 'isCommand',
            'isBareCommand', 'runCommand', 'listVerbs',
        ],
    },
    // WORK-TODO #10 B28, 2026-11-12. task-queue.js stays over the limit on purpose: it
    // keeps every writer of the queue state machine, so tests/task-queue-delivery-invariant
    // reads one owner. Only its parts are held to 300 (facadeOverLimit); its own entry in
    // lib/validate-exceptions.json says why.
    {   facade: 'lib/task-queue.js', facadeOverLimit: true,
        parts: ['lib/task-queue-status.js', 'lib/task-queue-delivery.js', 'lib/task-queue-view.js'],
        exports: ['TaskQueue', 'getQueue', 'hasActiveTasks', 'getQueueStatus', 'STATUS',
            'INTERRUPTED_ON_STARTUP_REASON', 'DEFAULT_QUEUE_FILE', 'deliveryRecorded', 'normalizeDelivery',
            'DELIVERY_NOT_RECORDED'],
    },
    {   facade: 'lib/integrations/email-categorizer.js',
        parts: ['lib/integrations/email-categorizer-rules.js', 'lib/integrations/email-categorizer-push.js'],
        exports: ['categorizeEmail', 'categorizeEmails', 'formatSummary', 'loadRules', 'containsKeyword',
            'wholeWordPattern', 'searchableTextFor', 'matchesSender', 'determinePriority', 'determineAction',
            'DEFAULT_RULES', 'RULES_FILE'],
    },
    {   facade: 'lib/integrations/email-sanitizer.js',
        parts: ['email-injection-patterns', 'email-content-sanitize', 'email-prompt-wrap']
            .map((p) => `lib/integrations/${p}.js`),
        exports: ['sanitizeEmailContent', 'prepareEmailForLLM', 'sanitizeMetadata', 'detectInjectionPatterns',
            'escapeContent', 'truncateContent', 'wrapEmailContent', 'INJECTION_PATTERNS', 'MAX_EMAIL_CONTENT_LENGTH',
            'MAX_METADATA_LENGTH', 'ESCAPE_MAP'],
    },
    {   facade: 'lib/bulletin-board.js',
        parts: ['lib/bulletin-board-store.js', 'lib/bulletin-board-format.js'],
        exports: ['postBulletin', 'getBulletins', 'markRead', 'cleanupOldBulletins', 'formatBulletinsForSlack',
            'formatBulletinsForContext', 'formatBulletinData', 'isBulletinQuery', 'BULLETIN_TYPES', 'init',
            'DEFAULT_BULLETIN_FILE', 'BULLETIN_FILE', 'DEFAULT_CLEANUP_DAYS', 'loadBulletins', 'saveBulletins'],
    },
    {   facade: 'lib/clone-lifecycle.js',
        parts: ['lib/clone-target.js', 'lib/clone-delivery.js'],
        exports: ['cloneRepo', 'cleanupDir', 'detectUndeliveredWork', 'assertValidTargetDir', 'SHA_PATTERN'],
    },
];

module.exports = { SPLITS };
