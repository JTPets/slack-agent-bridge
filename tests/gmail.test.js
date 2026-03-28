/**
 * tests/gmail.test.js
 *
 * Tests for lib/integrations/gmail.js
 */

'use strict';

// Mock googleapis before requiring gmail module
jest.mock('googleapis', () => {
    const mockMessages = {
        list: jest.fn(),
        get: jest.fn(),
    };

    const mockGmail = jest.fn(() => ({
        users: {
            messages: mockMessages,
        },
    }));

    return {
        google: {
            auth: {
                GoogleAuth: jest.fn().mockImplementation(() => ({})),
                OAuth2: jest.fn().mockImplementation(() => ({
                    setCredentials: jest.fn(),
                })),
            },
            gmail: mockGmail,
        },
    };
});

jest.mock('fs');

const gmail = require('../lib/integrations/gmail');
const fs = require('fs');

describe('gmail module', () => {
    beforeEach(() => {
        jest.clearAllMocks();
        // Reset env vars
        delete process.env.GOOGLE_SERVICE_ACCOUNT_KEY;
        delete process.env.GOOGLE_REFRESH_TOKEN;
        delete process.env.GOOGLE_CALENDAR_REFRESH_TOKEN;
        delete process.env.GOOGLE_CLIENT_ID;
        delete process.env.GOOGLE_CLIENT_SECRET;
    });

    describe('getRefreshToken', () => {
        test('returns GOOGLE_REFRESH_TOKEN if set', () => {
            process.env.GOOGLE_REFRESH_TOKEN = 'refresh-token-1';
            process.env.GOOGLE_CALENDAR_REFRESH_TOKEN = 'refresh-token-2';
            expect(gmail.getRefreshToken()).toBe('refresh-token-1');
        });

        test('falls back to GOOGLE_CALENDAR_REFRESH_TOKEN', () => {
            process.env.GOOGLE_CALENDAR_REFRESH_TOKEN = 'refresh-token-2';
            expect(gmail.getRefreshToken()).toBe('refresh-token-2');
        });

        test('returns undefined if neither is set', () => {
            expect(gmail.getRefreshToken()).toBeUndefined();
        });
    });

    describe('stripHtml', () => {
        test('removes HTML tags', () => {
            const html = '<p>Hello <strong>World</strong></p>';
            expect(gmail.stripHtml(html)).toBe('Hello World');
        });

        test('removes style tags and content', () => {
            const html = '<style>body { color: red; }</style><p>Text</p>';
            expect(gmail.stripHtml(html)).toBe('Text');
        });

        test('removes script tags and content', () => {
            const html = '<script>alert("hi");</script><p>Text</p>';
            expect(gmail.stripHtml(html)).toBe('Text');
        });

        test('converts HTML entities', () => {
            const html = '&amp; &lt; &gt; &quot; &#39; &nbsp;';
            expect(gmail.stripHtml(html)).toBe('& < > " \'');
        });

        test('handles empty string', () => {
            expect(gmail.stripHtml('')).toBe('');
        });

        test('handles null/undefined', () => {
            expect(gmail.stripHtml(null)).toBe('');
            expect(gmail.stripHtml(undefined)).toBe('');
        });

        test('collapses whitespace', () => {
            const html = '<p>Hello    \n\n   World</p>';
            expect(gmail.stripHtml(html)).toBe('Hello World');
        });
    });

    describe('decodeBase64Url', () => {
        test('decodes base64url string', () => {
            // "Hello World" in base64url
            const encoded = 'SGVsbG8gV29ybGQ';
            expect(gmail.decodeBase64Url(encoded)).toBe('Hello World');
        });

        test('handles URL-safe characters', () => {
            // String with + and / that get replaced in base64url
            const encoded = 'dGVzdC1kYXRhXw'; // "test-data_" (approximately)
            const result = gmail.decodeBase64Url(encoded);
            expect(typeof result).toBe('string');
        });

        test('handles empty string', () => {
            expect(gmail.decodeBase64Url('')).toBe('');
        });

        test('handles null/undefined', () => {
            expect(gmail.decodeBase64Url(null)).toBe('');
            expect(gmail.decodeBase64Url(undefined)).toBe('');
        });
    });

    describe('getHeader', () => {
        const headers = [
            { name: 'From', value: 'sender@example.com' },
            { name: 'To', value: 'recipient@example.com' },
            { name: 'Subject', value: 'Test Subject' },
            { name: 'Date', value: 'Sat, 28 Mar 2026 10:00:00 -0400' },
        ];

        test('finds header by exact name', () => {
            expect(gmail.getHeader(headers, 'From')).toBe('sender@example.com');
        });

        test('finds header case-insensitively', () => {
            expect(gmail.getHeader(headers, 'from')).toBe('sender@example.com');
            expect(gmail.getHeader(headers, 'FROM')).toBe('sender@example.com');
        });

        test('returns empty string for missing header', () => {
            expect(gmail.getHeader(headers, 'X-Custom')).toBe('');
        });

        test('handles empty headers array', () => {
            expect(gmail.getHeader([], 'From')).toBe('');
        });

        test('handles null/undefined headers', () => {
            expect(gmail.getHeader(null, 'From')).toBe('');
            expect(gmail.getHeader(undefined, 'From')).toBe('');
        });
    });

    describe('extractBody', () => {
        test('extracts body from simple text message', () => {
            const payload = {
                mimeType: 'text/plain',
                body: {
                    data: Buffer.from('Hello World').toString('base64'),
                },
            };
            expect(gmail.extractBody(payload)).toBe('Hello World');
        });

        test('extracts and strips HTML from html message', () => {
            const payload = {
                mimeType: 'text/html',
                body: {
                    data: Buffer.from('<p>Hello <b>World</b></p>').toString('base64'),
                },
            };
            expect(gmail.extractBody(payload)).toBe('Hello World');
        });

        test('prefers text/plain in multipart', () => {
            const payload = {
                mimeType: 'multipart/alternative',
                parts: [
                    {
                        mimeType: 'text/plain',
                        body: { data: Buffer.from('Plain text').toString('base64') },
                    },
                    {
                        mimeType: 'text/html',
                        body: { data: Buffer.from('<p>HTML text</p>').toString('base64') },
                    },
                ],
            };
            expect(gmail.extractBody(payload)).toBe('Plain text');
        });

        test('falls back to text/html if no text/plain', () => {
            const payload = {
                mimeType: 'multipart/alternative',
                parts: [
                    {
                        mimeType: 'text/html',
                        body: { data: Buffer.from('<p>HTML only</p>').toString('base64') },
                    },
                ],
            };
            expect(gmail.extractBody(payload)).toBe('HTML only');
        });

        test('handles nested multipart', () => {
            const payload = {
                mimeType: 'multipart/mixed',
                parts: [
                    {
                        mimeType: 'multipart/alternative',
                        parts: [
                            {
                                mimeType: 'text/plain',
                                body: { data: Buffer.from('Nested text').toString('base64') },
                            },
                        ],
                    },
                ],
            };
            expect(gmail.extractBody(payload)).toBe('Nested text');
        });

        test('returns empty string for empty payload', () => {
            expect(gmail.extractBody(null)).toBe('');
            expect(gmail.extractBody(undefined)).toBe('');
            expect(gmail.extractBody({})).toBe('');
        });
    });

    describe('transformEmail', () => {
        test('transforms full message to email object', () => {
            const message = {
                id: 'msg123',
                snippet: 'This is a test email...',
                labelIds: ['INBOX', 'UNREAD'],
                payload: {
                    headers: [
                        { name: 'From', value: 'sender@example.com' },
                        { name: 'To', value: 'recipient@example.com' },
                        { name: 'Subject', value: 'Test Subject' },
                        { name: 'Date', value: 'Sat, 28 Mar 2026 10:00:00 -0400' },
                    ],
                    mimeType: 'text/plain',
                    body: {
                        data: Buffer.from('Email body content').toString('base64'),
                    },
                },
            };

            const result = gmail.transformEmail(message);

            expect(result).toEqual({
                id: 'msg123',
                from: 'sender@example.com',
                to: 'recipient@example.com',
                subject: 'Test Subject',
                date: 'Sat, 28 Mar 2026 10:00:00 -0400',
                snippet: 'This is a test email...',
                labels: ['INBOX', 'UNREAD'],
                body: 'Email body content',
            });
        });

        test('handles missing fields gracefully', () => {
            const message = {
                id: 'msg456',
            };

            const result = gmail.transformEmail(message);

            expect(result).toEqual({
                id: 'msg456',
                from: '',
                to: '',
                subject: '',
                date: '',
                snippet: '',
                labels: [],
                body: '',
            });
        });
    });

    describe('hasCredentials', () => {
        test('returns true with service account', () => {
            process.env.GOOGLE_SERVICE_ACCOUNT_KEY = '/path/to/key.json';
            expect(gmail.hasCredentials()).toBe(true);
        });

        test('returns true with OAuth credentials', () => {
            process.env.GOOGLE_REFRESH_TOKEN = 'refresh-token';
            process.env.GOOGLE_CLIENT_ID = 'client-id';
            process.env.GOOGLE_CLIENT_SECRET = 'client-secret';
            expect(gmail.hasCredentials()).toBe(true);
        });

        test('returns true with calendar refresh token alias', () => {
            process.env.GOOGLE_CALENDAR_REFRESH_TOKEN = 'refresh-token';
            process.env.GOOGLE_CLIENT_ID = 'client-id';
            process.env.GOOGLE_CLIENT_SECRET = 'client-secret';
            expect(gmail.hasCredentials()).toBe(true);
        });

        test('returns false with no credentials', () => {
            expect(gmail.hasCredentials()).toBe(false);
        });

        test('returns false with partial OAuth credentials', () => {
            process.env.GOOGLE_REFRESH_TOKEN = 'refresh-token';
            process.env.GOOGLE_CLIENT_ID = 'client-id';
            // Missing CLIENT_SECRET
            expect(gmail.hasCredentials()).toBe(false);
        });
    });

    describe('getRecentEmails', () => {
        test('returns empty array when no credentials', async () => {
            const result = await gmail.getRecentEmails();
            expect(result).toEqual([]);
        });
    });

    describe('getEmailById', () => {
        test('returns null when no credentials', async () => {
            const result = await gmail.getEmailById('msg123');
            expect(result).toBeNull();
        });
    });

    describe('getEmailHeaders', () => {
        test('returns null when no credentials', async () => {
            const result = await gmail.getEmailHeaders('msg123');
            expect(result).toBeNull();
        });
    });

    describe('module exports', () => {
        test('exports all expected functions', () => {
            expect(gmail).toHaveProperty('getRecentEmails');
            expect(gmail).toHaveProperty('getEmailById');
            expect(gmail).toHaveProperty('getEmailHeaders');
            expect(gmail).toHaveProperty('hasCredentials');
            expect(gmail).toHaveProperty('getRefreshToken');
            expect(gmail).toHaveProperty('stripHtml');
            expect(gmail).toHaveProperty('decodeBase64Url');
            expect(gmail).toHaveProperty('getHeader');
            expect(gmail).toHaveProperty('extractBody');
            expect(gmail).toHaveProperty('transformEmail');

            expect(typeof gmail.getRecentEmails).toBe('function');
            expect(typeof gmail.getEmailById).toBe('function');
            expect(typeof gmail.getEmailHeaders).toBe('function');
            expect(typeof gmail.hasCredentials).toBe('function');
        });
    });
});
