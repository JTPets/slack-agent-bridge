/**
 * Tests for lib/redact-secrets.js
 *
 * Regression guard for the leak where an LLM subprocess's stderr was surfaced
 * verbatim to Slack and the logs, publishing live tokens.
 */

'use strict';

const { redact, secretValuesFromEnv, SENSITIVE_NAME } = require('../lib/redact-secrets');

describe('redact-secrets', () => {
    describe('value-driven scrubbing (env)', () => {
        const env = {
            SLACK_BOT_TOKEN: 'xoxb-super-secret-value-1234567890',
            GOOGLE_CLIENT_SECRET: 'GOCSPX-abcdefghijklmnopqrstuvwxyz',
            OPS_CHANNEL_ID: 'C0123456789', // sensitive-name miss: not a secret
            MAX_TURNS: '50',
        };

        test('scrubs a live env secret value by exact match, tagged with its name', () => {
            const out = redact('boom: SLACK_BOT_TOKEN=xoxb-super-secret-value-1234567890 while starting', { env });
            expect(out).not.toContain('xoxb-super-secret-value-1234567890');
            expect(out).toContain('[REDACTED:SLACK_BOT_TOKEN]');
        });

        test('scrubs multiple distinct secrets in one string', () => {
            const out = redact('a=xoxb-super-secret-value-1234567890 b=GOCSPX-abcdefghijklmnopqrstuvwxyz', { env });
            expect(out).toContain('[REDACTED:SLACK_BOT_TOKEN]');
            expect(out).toContain('[REDACTED:GOOGLE_CLIENT_SECRET]');
            expect(out).not.toContain('GOCSPX-');
        });

        test('leaves non-secret env values (channel IDs, small ints) untouched', () => {
            const out = redact('channel C0123456789 turns 50', { env });
            expect(out).toBe('channel C0123456789 turns 50');
        });

        test('secretValuesFromEnv sorts longest value first', () => {
            const pairs = secretValuesFromEnv({ A_TOKEN: 'short-tok-1', B_TOKEN: 'a-much-longer-token-value' });
            expect(pairs[0][0]).toBe('B_TOKEN');
        });
    });

    describe('pattern-driven scrubbing (no env)', () => {
        test('redacts a Slack bot token', () => {
            const out = redact('error near xoxb-1111111111-2222222222-abcdefABCDEF here');
            expect(out).toContain('[REDACTED:SLACK_TOKEN]');
            expect(out).not.toContain('xoxb-1111111111');
        });

        test('redacts an Anthropic API key', () => {
            const out = redact('key sk-ant-api03-abcDEF0123456789_ghiJKL-mnop shown');
            expect(out).toContain('[REDACTED:ANTHROPIC_KEY]');
            expect(out).not.toContain('sk-ant-api03');
        });

        test('redacts a Google API key', () => {
            const out = redact('AIzaSyA1234567890abcdefghijklmnopqrstuv leaked');
            expect(out).toContain('[REDACTED:GOOGLE_API_KEY]');
        });

        test('redacts a GitHub token', () => {
            const out = redact('ghp_0123456789abcdefghijABCDEFGHIJ0123456789');
            expect(out).toContain('[REDACTED:GITHUB_TOKEN]');
        });

        test('redacts a PEM private key block', () => {
            const pem = '-----BEGIN OPENSSH PRIVATE KEY-----\nb3BlbnNzaC1rZXktdjEA\nsecretmaterial==\n-----END OPENSSH PRIVATE KEY-----';
            const out = redact(`deploy key:\n${pem}\ndone`);
            expect(out).toContain('[REDACTED:PRIVATE_KEY]');
            expect(out).not.toContain('secretmaterial');
        });

        test('redacts a bearer token but keeps the scheme', () => {
            const out = redact('Authorization: Bearer abcDEF012345.6789ghijkl');
            expect(out).toContain('Bearer [REDACTED]');
            expect(out).not.toContain('abcDEF012345.6789ghijkl');
        });

        test('redacts a Google OAuth refresh token', () => {
            const out = redact('refresh 1//0abcdefghijklmnopqrstuvwxyz-ABCDEF here');
            expect(out).toContain('[REDACTED:GOOGLE_REFRESH_TOKEN]');
        });
    });

    describe('edge cases', () => {
        test('passes through null and undefined unchanged', () => {
            expect(redact(null)).toBeNull();
            expect(redact(undefined)).toBeUndefined();
        });

        test('coerces non-strings to string', () => {
            expect(redact(12345)).toBe('12345');
        });

        test('leaves clean text alone', () => {
            const clean = 'Task interrupted (SIGTERM) - likely container restart';
            expect(redact(clean, { env: {} })).toBe(clean);
        });

        test('SENSITIVE_NAME matches common secret var names', () => {
            expect(SENSITIVE_NAME.test('SLACK_BOT_TOKEN')).toBe(true);
            expect(SENSITIVE_NAME.test('GOOGLE_CLIENT_SECRET')).toBe(true);
            expect(SENSITIVE_NAME.test('GEMINI_API_KEY')).toBe(true);
            expect(SENSITIVE_NAME.test('OPS_CHANNEL_ID')).toBe(false);
        });
    });
});
