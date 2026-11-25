'use strict';

/**
 * lib/task-turns.js
 *
 * THE turn budgets: the task path's (TURNS: header, default, floor and ceiling) and the
 * conversation path's (an ASK: answer), with conversationTurns() as the one place the
 * conversation clamp is applied. Pure.
 *
 * LOGIC CHANGE 2026-11-25 (WORK-TODO #10, B37): moved unchanged out of
 * lib/task-parser.js, which re-exports every name. Turn budgets are read by the parser,
 * the /dispatch form, lib/llm-defaults.js and bridge-agent.js; they are a different
 * concern from reading a task message.
 */

// LOGIC CHANGE 2026-03-26: Added TURNS parsing to allow per-task control of LLM
// max turns. Default 50, capped at 100 max, floor at 5 min.
// LOGIC CHANGE 2026-10-04 (WORK-TODO #20): the ceiling was named MAX_TURNS, the same
// name as the MAX_TURNS env var, lib/config.js's MAX_TURNS and lib/weekly-critique.js's
// MAX_TURNS, four different quantities. It is TURNS_CEILING now. The conversation path's
// default and ceiling were two bare literals in bridge-agent.js; they live here, beside
// the task path's, with conversationTurns() as the one place the clamp is applied.
const DEFAULT_TURNS = 50;
const MIN_TURNS = 5;
const TURNS_CEILING = 100;
const CONVERSATION_TURNS_DEFAULT = 10;
const CONVERSATION_TURNS_CEILING = 20;

/**
 * The turn budget for an ASK: answered by `agent`: its definition's `max_turns`, or
 * CONVERSATION_TURNS_DEFAULT when it declares none, never above
 * CONVERSATION_TURNS_CEILING. A code agent declaring 50 gets 20 on this path; that is
 * deliberate (a conversation is a short answer), and this is where it is stated.
 *
 * @param {{ max_turns?: number }|null|undefined} agent
 * @returns {number}
 */
function conversationTurns(agent) {
  const declared = agent && agent.max_turns;
  return Math.min(declared || CONVERSATION_TURNS_DEFAULT, CONVERSATION_TURNS_CEILING);
}

module.exports = {
  DEFAULT_TURNS,
  MIN_TURNS,
  TURNS_CEILING,
  CONVERSATION_TURNS_DEFAULT,
  CONVERSATION_TURNS_CEILING,
  conversationTurns,
};
