/**
 * httpSMS Integration
 *
 * Uses httpSMS API (https://api.httpsms.com) for SMS delivery via owner's Android phone.
 * Free alternative to Twilio - customers see real local number.
 *
 * @see https://httpsms.com/docs/
 */

const https = require('https');

// LOGIC CHANGE 2026-03-27: Added httpSMS as primary SMS provider, replacing Twilio for basic SMS

/**
 * Check if httpSMS is configured
 * @returns {boolean}
 */
function isConfigured() {
    return !!(process.env.HTTPSMS_API_KEY && process.env.HTTPSMS_PHONE_NUMBER);
}

/**
 * Make an HTTPS request to httpSMS API
 * @param {string} method - HTTP method
 * @param {string} path - API endpoint path
 * @param {Object|null} body - Request body (for POST/PUT)
 * @returns {Promise<Object>} - Parsed JSON response
 */
function makeRequest(method, path, body = null) {
    return new Promise((resolve, reject) => {
        const apiKey = process.env.HTTPSMS_API_KEY;

        const options = {
            hostname: 'api.httpsms.com',
            port: 443,
            path: path,
            method: method,
            headers: {
                'x-api-key': apiKey,
                'Content-Type': 'application/json',
                'Accept': 'application/json'
            }
        };

        const req = https.request(options, (res) => {
            let data = '';
            res.on('data', chunk => { data += chunk; });
            res.on('end', () => {
                try {
                    const parsed = data ? JSON.parse(data) : {};
                    if (res.statusCode >= 200 && res.statusCode < 300) {
                        resolve(parsed);
                    } else {
                        reject(new Error(`httpSMS API error: ${res.statusCode} - ${parsed.message || data}`));
                    }
                } catch (e) {
                    reject(new Error(`httpSMS API parse error: ${e.message}`));
                }
            });
        });

        req.on('error', reject);
        req.setTimeout(30000, () => {
            req.destroy();
            reject(new Error('httpSMS API timeout'));
        });

        if (body) {
            req.write(JSON.stringify(body));
        }
        req.end();
    });
}

/**
 * Send an SMS message
 * @param {string} to - Recipient phone number (E.164 format: +1234567890)
 * @param {string} message - Message content (max 160 chars for single SMS)
 * @returns {Promise<Object>} - API response with message ID
 */
async function sendSMS(to, message) {
    if (!isConfigured()) {
        console.log('httpSMS not configured');
        return { success: false, error: 'httpSMS not configured' };
    }

    const from = process.env.HTTPSMS_PHONE_NUMBER;

    const body = {
        from: from,
        to: to,
        content: message
    };

    try {
        const response = await makeRequest('POST', '/v1/messages/send', body);
        return {
            success: true,
            messageId: response.data?.id,
            response: response
        };
    } catch (error) {
        console.error('httpSMS sendSMS error:', error.message);
        return { success: false, error: error.message };
    }
}

/**
 * Get received messages since a given timestamp
 * @param {Date|string} since - Fetch messages after this timestamp (ISO 8601 or Date object)
 * @returns {Promise<Object>} - API response with messages array
 */
async function getMessages(since) {
    if (!isConfigured()) {
        console.log('httpSMS not configured');
        return { success: false, error: 'httpSMS not configured', messages: [] };
    }

    const owner = process.env.HTTPSMS_PHONE_NUMBER;
    const sinceStr = since instanceof Date ? since.toISOString() : since;

    // URL encode the timestamp
    const encodedSince = encodeURIComponent(sinceStr);
    const path = `/v1/messages?owner=${encodeURIComponent(owner)}&contact=&type=mobile-originated&since=${encodedSince}`;

    try {
        const response = await makeRequest('GET', path);
        return {
            success: true,
            messages: response.data || [],
            response: response
        };
    } catch (error) {
        console.error('httpSMS getMessages error:', error.message);
        return { success: false, error: error.message, messages: [] };
    }
}

/**
 * Register a webhook URL for incoming SMS notifications
 * @param {string} url - Webhook URL to receive notifications
 * @returns {Promise<Object>} - API response confirming webhook registration
 */
async function registerWebhook(url) {
    if (!isConfigured()) {
        console.log('httpSMS not configured');
        return { success: false, error: 'httpSMS not configured' };
    }

    const body = {
        url: url,
        events: ['message.received']
    };

    try {
        const response = await makeRequest('POST', '/v1/webhooks', body);
        return {
            success: true,
            webhookId: response.data?.id,
            response: response
        };
    } catch (error) {
        console.error('httpSMS registerWebhook error:', error.message);
        return { success: false, error: error.message };
    }
}

module.exports = {
    isConfigured,
    sendSMS,
    getMessages,
    registerWebhook
};
