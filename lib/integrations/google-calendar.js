/**
 * lib/integrations/google-calendar.js
 *
 * Google Calendar integration for fetching calendar events.
 * Supports authentication via service account or OAuth refresh token.
 *
 * Required env vars (one of):
 *   GOOGLE_SERVICE_ACCOUNT_KEY - Path to service account JSON key file
 *   OR
 *   GOOGLE_REFRESH_TOKEN (or its legacy alias GOOGLE_CALENDAR_REFRESH_TOKEN), GOOGLE_CLIENT_ID,
 *   GOOGLE_CLIENT_SECRET - OAuth credentials
 *
 * Optional env vars:
 *   GOOGLE_CALENDAR_IDS - Comma-separated list of calendar IDs (default: 'primary')
 */

'use strict';

const { google } = require('googleapis');
const fs = require('fs');
const path = require('path');
const { getGoogleRefreshToken } = require('../config');

// ---- Auth helpers ----

/**
 * Create an authenticated Google Calendar client.
 * Tries service account first, then OAuth refresh token.
 *
 * @returns {Promise<import('googleapis').calendar_v3.Calendar|null>} Calendar client or null on failure
 */
async function getCalendarClient() {
    try {
        let auth;

        // Option 1: Service account
        const serviceAccountPath = process.env.GOOGLE_SERVICE_ACCOUNT_KEY;
        if (serviceAccountPath) {
            const keyPath = path.resolve(serviceAccountPath);
            if (!fs.existsSync(keyPath)) {
                console.error('[google-calendar] Service account key file not found:', keyPath);
                return null;
            }

            const keyFile = JSON.parse(fs.readFileSync(keyPath, 'utf8'));
            auth = new google.auth.GoogleAuth({
                credentials: keyFile,
                scopes: ['https://www.googleapis.com/auth/calendar.readonly'],
            });
        }
        // Option 2: OAuth refresh token
        // LOGIC CHANGE 2026-10-05: read through lib/config.js getGoogleRefreshToken, so
        // GOOGLE_REFRESH_TOKEN works here as it does for Gmail and as CLAUDE.md and
        // .env.example document. This file read only GOOGLE_CALENDAR_REFRESH_TOKEN, so a
        // .env holding just GOOGLE_REFRESH_TOKEN left the calendar silently unconfigured.
        else if (
            getGoogleRefreshToken() &&
            process.env.GOOGLE_CLIENT_ID &&
            process.env.GOOGLE_CLIENT_SECRET
        ) {
            const oauth2Client = new google.auth.OAuth2(
                process.env.GOOGLE_CLIENT_ID,
                process.env.GOOGLE_CLIENT_SECRET
            );
            oauth2Client.setCredentials({
                refresh_token: getGoogleRefreshToken(),
            });
            auth = oauth2Client;
        } else {
            console.error('[google-calendar] No authentication configured. Set GOOGLE_SERVICE_ACCOUNT_KEY or OAuth credentials.');
            return null;
        }

        return google.calendar({ version: 'v3', auth });
    } catch (err) {
        console.error('[google-calendar] Failed to create calendar client:', err.message);
        return null;
    }
}

/**
 * Get configured calendar IDs from env var.
 *
 * @returns {string[]} Array of calendar IDs
 */
function getCalendarIds() {
    const ids = process.env.GOOGLE_CALENDAR_IDS || 'primary';
    return ids.split(',').map(id => id.trim()).filter(Boolean);
}

// ---- Date helpers ----

// LOGIC CHANGE 2026-10-05 (WORK-TODO #10, wave 3): the three day-range builders, the
// three per-calendar fetchers and the three all-calendars merges were copies differing
// only in the day offset and the log label. Each is now one function; every exported
// name is kept as a thin wrapper with the same behaviour and the same log text
// (tests/google-calendar.test.js was run against the copies first).
//
// The range is LOCAL midnight to the next local midnight, so it depends on the process
// timezone, unlike the rest of the repo (see WORK-TODO). Kept as it was by this change.

/**
 * Start and end of the day `offset` days from today, in ISO format.
 *
 * @param {number} offset - -1 yesterday, 0 today, 1 tomorrow
 * @returns {{ start: string, end: string }}
 */
function dayRange(offset) {
    const now = new Date();
    const start = new Date(now.getFullYear(), now.getMonth(), now.getDate() + offset);
    const end = new Date(start);
    end.setDate(end.getDate() + 1);
    return { start: start.toISOString(), end: end.toISOString() };
}

/** @returns {{ start: string, end: string }} */
function getTodayRange() { return dayRange(0); }
/** @returns {{ start: string, end: string }} */
function getYesterdayRange() { return dayRange(-1); }
// LOGIC CHANGE 2026-03-28: Added getTomorrowRange for secretary agent daily briefings.
/** @returns {{ start: string, end: string }} */
function getTomorrowRange() { return dayRange(1); }

// ---- Event transformation ----

/**
 * Transform a Google Calendar event to a simple object.
 *
 * @param {Object} event - Google Calendar event
 * @returns {{ title: string, start: string, end: string, status: string, recurring: boolean }}
 */
function transformEvent(event) {
    return {
        title: event.summary || 'Untitled Event',
        start: event.start?.dateTime || event.start?.date || '',
        end: event.end?.dateTime || event.end?.date || '',
        status: event.status || 'confirmed',
        recurring: !!event.recurringEventId,
    };
}

// ---- Fetching ----

/**
 * Fetch one calendar's events in a range. Never throws: a failure is logged and is [].
 *
 * @param {string} calendarId
 * @param {{ start: string, end: string }} range
 * @param {string} label - "today's", "yesterday's" or "tomorrow's", for the log line
 */
async function fetchEventsInRange(calendarId, range, label) {
    try {
        const calendar = await getCalendarClient();
        if (!calendar) {
            return [];
        }
        const response = await calendar.events.list({
            calendarId,
            timeMin: range.start,
            timeMax: range.end,
            singleEvents: true,
            orderBy: 'startTime',
        });
        return (response.data.items || []).map(transformEvent);
    } catch (err) {
        console.error(`[google-calendar] Failed to fetch ${label} events for ${calendarId}:`, err.message);
        return [];
    }
}

/**
 * Run a per-calendar fetcher over every configured calendar, tag each event with its
 * calendar, and sort by start time.
 *
 * @param {(calendarId: string) => Promise<Array>} fetchOne
 */
async function mergeAllCalendars(fetchOne) {
    const allEvents = [];
    for (const calendarId of getCalendarIds()) {
        for (const event of await fetchOne(calendarId)) {
            allEvents.push({ ...event, calendarId });
        }
    }
    allEvents.sort((a, b) => new Date(a.start || 0).getTime() - new Date(b.start || 0).getTime());
    return allEvents;
}

// ---- Public API ----

/** Today's events from one calendar. */
async function getTodayEvents(calendarId = 'primary') {
    return fetchEventsInRange(calendarId, getTodayRange(), "today's");
}

/** Yesterday's events from one calendar. */
async function getYesterdayEvents(calendarId = 'primary') {
    return fetchEventsInRange(calendarId, getYesterdayRange(), "yesterday's");
}

// LOGIC CHANGE 2026-03-28: Added getTomorrowEvents for secretary agent briefings.
/** Tomorrow's events from one calendar. */
async function getTomorrowEvents(calendarId = 'primary') {
    return fetchEventsInRange(calendarId, getTomorrowRange(), "tomorrow's");
}

/**
 * List all calendars accessible by the authenticated user.
 *
 * @returns {Promise<Array<{ id: string, summary: string, primary: boolean }>>}
 */
async function listCalendars() {
    try {
        const calendar = await getCalendarClient();
        if (!calendar) {
            return [];
        }

        const response = await calendar.calendarList.list();
        return (response.data.items || []).map(cal => ({
            id: cal.id || '',
            summary: cal.summary || 'Unnamed Calendar',
            primary: cal.primary || false,
        }));
    } catch (err) {
        console.error('[google-calendar] Failed to list calendars:', err.message);
        return [];
    }
}

/** Today's events from every configured calendar, tagged and sorted. */
async function getAllTodayEvents() { return mergeAllCalendars(getTodayEvents); }
/** Yesterday's events from every configured calendar, tagged and sorted. */
async function getAllYesterdayEvents() { return mergeAllCalendars(getYesterdayEvents); }
// LOGIC CHANGE 2026-03-28: Added getAllTomorrowEvents for secretary agent.
/** Tomorrow's events from every configured calendar, tagged and sorted. */
async function getAllTomorrowEvents() { return mergeAllCalendars(getTomorrowEvents); }

module.exports = {
    getTodayEvents,
    getYesterdayEvents,
    getTomorrowEvents,
    listCalendars,
    getAllTodayEvents,
    getAllYesterdayEvents,
    getAllTomorrowEvents,
    getCalendarIds,
    // Export for testing
    transformEvent,
    getTodayRange,
    getYesterdayRange,
    getTomorrowRange,
};
