/**
 * lib/integrations/google-calendar.js
 *
 * Google Calendar integration for fetching calendar events.
 * Supports authentication via service account or OAuth refresh token.
 *
 * Required env vars (one of):
 *   GOOGLE_SERVICE_ACCOUNT_KEY - Path to service account JSON key file
 *   OR
 *   GOOGLE_CALENDAR_REFRESH_TOKEN, GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET - OAuth credentials
 *
 * Optional env vars:
 *   GOOGLE_CALENDAR_IDS - Comma-separated list of calendar IDs (default: 'primary')
 */

'use strict';

const { google } = require('googleapis');
const fs = require('fs');
const path = require('path');

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
        else if (
            process.env.GOOGLE_CALENDAR_REFRESH_TOKEN &&
            process.env.GOOGLE_CLIENT_ID &&
            process.env.GOOGLE_CLIENT_SECRET
        ) {
            const oauth2Client = new google.auth.OAuth2(
                process.env.GOOGLE_CLIENT_ID,
                process.env.GOOGLE_CLIENT_SECRET
            );
            oauth2Client.setCredentials({
                refresh_token: process.env.GOOGLE_CALENDAR_REFRESH_TOKEN,
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

/**
 * Get start and end of today in ISO format.
 *
 * @returns {{ start: string, end: string }}
 */
function getTodayRange() {
    const now = new Date();
    const start = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const end = new Date(start);
    end.setDate(end.getDate() + 1);

    return {
        start: start.toISOString(),
        end: end.toISOString(),
    };
}

/**
 * Get start and end of yesterday in ISO format.
 *
 * @returns {{ start: string, end: string }}
 */
function getYesterdayRange() {
    const now = new Date();
    const end = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const start = new Date(end);
    start.setDate(start.getDate() - 1);

    return {
        start: start.toISOString(),
        end: end.toISOString(),
    };
}

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

// ---- Public API ----

/**
 * Fetch events for today from a specific calendar.
 *
 * @param {string} [calendarId='primary'] - Calendar ID to fetch events from
 * @returns {Promise<Array<{ title: string, start: string, end: string, status: string, recurring: boolean }>>}
 */
async function getTodayEvents(calendarId = 'primary') {
    try {
        const calendar = await getCalendarClient();
        if (!calendar) {
            return [];
        }

        const { start, end } = getTodayRange();
        const response = await calendar.events.list({
            calendarId,
            timeMin: start,
            timeMax: end,
            singleEvents: true,
            orderBy: 'startTime',
        });

        return (response.data.items || []).map(transformEvent);
    } catch (err) {
        console.error(`[google-calendar] Failed to fetch today's events for ${calendarId}:`, err.message);
        return [];
    }
}

/**
 * Fetch events from yesterday from a specific calendar.
 *
 * @param {string} [calendarId='primary'] - Calendar ID to fetch events from
 * @returns {Promise<Array<{ title: string, start: string, end: string, status: string, recurring: boolean }>>}
 */
async function getYesterdayEvents(calendarId = 'primary') {
    try {
        const calendar = await getCalendarClient();
        if (!calendar) {
            return [];
        }

        const { start, end } = getYesterdayRange();
        const response = await calendar.events.list({
            calendarId,
            timeMin: start,
            timeMax: end,
            singleEvents: true,
            orderBy: 'startTime',
        });

        return (response.data.items || []).map(transformEvent);
    } catch (err) {
        console.error(`[google-calendar] Failed to fetch yesterday's events for ${calendarId}:`, err.message);
        return [];
    }
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

/**
 * Fetch today's events from all configured calendars.
 *
 * @returns {Promise<Array<{ title: string, start: string, end: string, status: string, recurring: boolean, calendarId: string }>>}
 */
async function getAllTodayEvents() {
    const calendarIds = getCalendarIds();
    const allEvents = [];

    for (const calendarId of calendarIds) {
        const events = await getTodayEvents(calendarId);
        for (const event of events) {
            allEvents.push({ ...event, calendarId });
        }
    }

    // Sort by start time
    allEvents.sort((a, b) => {
        const aStart = new Date(a.start || 0).getTime();
        const bStart = new Date(b.start || 0).getTime();
        return aStart - bStart;
    });

    return allEvents;
}

/**
 * Fetch yesterday's events from all configured calendars.
 *
 * @returns {Promise<Array<{ title: string, start: string, end: string, status: string, recurring: boolean, calendarId: string }>>}
 */
async function getAllYesterdayEvents() {
    const calendarIds = getCalendarIds();
    const allEvents = [];

    for (const calendarId of calendarIds) {
        const events = await getYesterdayEvents(calendarId);
        for (const event of events) {
            allEvents.push({ ...event, calendarId });
        }
    }

    // Sort by start time
    allEvents.sort((a, b) => {
        const aStart = new Date(a.start || 0).getTime();
        const bStart = new Date(b.start || 0).getTime();
        return aStart - bStart;
    });

    return allEvents;
}

module.exports = {
    getTodayEvents,
    getYesterdayEvents,
    listCalendars,
    getAllTodayEvents,
    getAllYesterdayEvents,
    getCalendarIds,
    // Export for testing
    transformEvent,
    getTodayRange,
    getYesterdayRange,
};
