/**
 * lib/social-drafts.js
 *
 * Post drafts for new catalog items: written by the social media agent's model, held
 * in a file, shown in its channel with Publish / Edit / Reject buttons.
 *
 * LOGIC CHANGE 2026-11-09: created. Owner's rule from the design: nothing is
 * published without a person pressing Publish. So this module WRITES and SHOWS drafts
 * and never publishes; lib/social-buttons.js publishes on a press.
 *
 * The model gets the item's facts and nothing else, runs with no tools (the agent's
 * definition grants none, lib/agent-tools.js), and must answer JSON with a `text` for
 * Facebook, Instagram and Google and a `short` of at most 300 characters for Bluesky.
 * An answer that is not that shape is a failed draft, reported, never posted.
 *
 * State: agents/shared/social-drafts.json (gitignored). Only the bridge writes it.
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { formatPrice } = require('./catalog-new-items');
const { MAX_GRAPHEMES, graphemeCount } = require('./social-bluesky');

const DEFAULT_DRAFTS_FILE = path.join(__dirname, '..', 'agents', 'shared', 'social-drafts.json');
const ACTION_PREFIX = 'social_draft_';
const ACTIONS = ['publish', 'edit', 'reject'];
const MAX_TEXT = 1500;
const STATUSES = ['pending', 'publishing', 'published', 'rejected'];

function readDrafts(file = DEFAULT_DRAFTS_FILE) {
    try {
        const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
        return parsed && typeof parsed.drafts === 'object' && parsed.drafts ? parsed : { drafts: {} };
    } catch (err) {
        if (err.code === 'ENOENT') return { drafts: {} };
        throw err;
    }
}

function writeDrafts(state, file = DEFAULT_DRAFTS_FILE) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(state, null, 2));
    fs.renameSync(tmp, file);
}

/** Read, change one draft, write. Returns the changed draft, or null when the id is unknown. */
function updateDraft(id, change, file = DEFAULT_DRAFTS_FILE) {
    const state = readDrafts(file);
    const draft = state.drafts[id];
    if (!draft) return null;
    const next = typeof change === 'function' ? change({ ...draft }) : { ...draft, ...change };
    if (next === null) return null;
    state.drafts[id] = next;
    writeDrafts(state, file);
    return next;
}

/** The prompt for one item. Facts only; the model is told not to add any. */
function buildDraftPrompt(item, agent) {
    const persona = (agent && (agent.system_prompt || agent.systemPrompt)) || 'You write social media posts for JT Pets, an independent pet food store in Hamilton, Ontario.';
    const facts = [
        `Name: ${item.name}`,
        `Price: ${formatPrice(item)}`,
        item.category_names && item.category_names.length ? `Category: ${item.category_names.join(' / ')}` : null,
        item.description ? `Description from our catalog: ${item.description.slice(0, 800)}` : null,
    ].filter(Boolean).join('\n');
    return `${persona}

Write a post announcing this new product at JT Pets. Use ONLY the facts below. Do not invent ingredients, health claims, discounts, stock levels or dates. If a fact is missing, leave it out.

${facts}

Answer with JSON only, no other text:
{"text": "<post for Facebook, Instagram and Google, at most 1200 characters, may use a few relevant hashtags>", "short": "<the same post for Bluesky, at most 280 characters>"}`;
}

/** Parse the model's answer. Throws with the reason when it is not the required shape. */
function parseDraftAnswer(output) {
    const raw = String(output || '').trim();
    const start = raw.indexOf('{');
    const end = raw.lastIndexOf('}');
    if (start < 0 || end <= start) throw new Error('the model did not answer JSON');
    let parsed;
    try { parsed = JSON.parse(raw.slice(start, end + 1)); } catch (err) { throw new Error(`the model's JSON did not parse: ${err.message}`); }
    const text = typeof parsed.text === 'string' ? parsed.text.trim() : '';
    const short = typeof parsed.short === 'string' ? parsed.short.trim() : '';
    if (!text) throw new Error('the model returned no post text');
    if (text.length > MAX_TEXT) throw new Error(`the post is ${text.length} characters, over ${MAX_TEXT}`);
    if (!short) throw new Error('the model returned no Bluesky version');
    if (graphemeCount(short) > MAX_GRAPHEMES) throw new Error(`the Bluesky version is over ${MAX_GRAPHEMES} characters`);
    return { text, short };
}

function newDraftId(item, now) {
    return `d${now.getTime().toString(36)}${String(item.id).replace(/[^A-Za-z0-9]/g, '').slice(-6)}`;
}

/**
 * Write one draft per item with the model and store it as pending.
 * @param {Function} runModel - (prompt) => Promise<string>
 * @returns {Promise<{ drafts: object[], failures: Array<{ item: string, reason: string }> }>} never rejects
 */
async function createDrafts(items, { runModel, agent, file = DEFAULT_DRAFTS_FILE, now = new Date() }) {
    const drafts = [];
    const failures = [];
    for (const item of items) {
        try {
            const { text, short } = parseDraftAnswer(await runModel(buildDraftPrompt(item, agent)));
            const draft = {
                id: newDraftId(item, now), itemId: item.id, itemName: item.name || item.id,
                imageUrl: item.image_url || null, text, short, status: 'pending',
                createdAt: now.toISOString(), post: null, results: [], decidedBy: null,
            };
            const state = readDrafts(file);
            state.drafts[draft.id] = draft;
            writeDrafts(state, file);
            drafts.push(draft);
        } catch (err) {
            failures.push({ item: item.name || item.id, reason: err.message });
        }
    }
    return { drafts, failures };
}

/** The Slack blocks for a draft: the item, both texts, and the buttons while pending. */
function buildDraftBlocks(draft, { targets = [], footer = null } = {}) {
    const head = { type: 'section', text: { type: 'mrkdwn', text: `*New item draft:* ${draft.itemName}\n\n${draft.text}` } };
    if (draft.imageUrl) head.accessory = { type: 'image', image_url: draft.imageUrl, alt_text: draft.itemName };
    const blocks = [head, { type: 'context', elements: [{ type: 'mrkdwn', text: `*Bluesky version:* ${draft.short}` }] }];
    if (draft.status === 'pending') {
        const where = targets.length ? targets.join(', ') : 'no platform is set up yet';
        blocks.push({ type: 'context', elements: [{ type: 'mrkdwn', text: `Publish goes to: ${where}${draft.imageUrl ? '' : '. No photo in Square, so Instagram will refuse it'}` }] });
        blocks.push({
            type: 'actions', block_id: `social_draft:${draft.id}`,
            elements: [
                { type: 'button', style: 'primary', action_id: `${ACTION_PREFIX}publish`, text: { type: 'plain_text', text: 'Publish' }, value: draft.id,
                    confirm: { title: { type: 'plain_text', text: 'Publish this post?' }, text: { type: 'mrkdwn', text: `It goes live on: ${where}.` },
                        confirm: { type: 'plain_text', text: 'Publish' }, deny: { type: 'plain_text', text: 'Cancel' } } },
                { type: 'button', action_id: `${ACTION_PREFIX}edit`, text: { type: 'plain_text', text: 'Edit' }, value: draft.id },
                { type: 'button', style: 'danger', action_id: `${ACTION_PREFIX}reject`, text: { type: 'plain_text', text: 'Reject' }, value: draft.id },
            ],
        });
    }
    if (footer) blocks.push({ type: 'context', elements: [{ type: 'mrkdwn', text: footer }] });
    return blocks;
}

module.exports = {
    DEFAULT_DRAFTS_FILE, ACTION_PREFIX, ACTIONS, STATUSES, MAX_TEXT,
    readDrafts, writeDrafts, updateDraft,
    buildDraftPrompt, parseDraftAnswer, createDrafts, buildDraftBlocks,
};
