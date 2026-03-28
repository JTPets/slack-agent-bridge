# SMS Integration Specification

This document defines the SMS and voice integration for the bridge-agent system. The integration enables customers to interact with JT Pets via SMS and phone calls, routed through existing agents.

---

## Overview

SMS and voice communication is handled via two providers:

### httpSMS (Primary - SMS Only)
- **Cost**: Free (uses owner's Android phone)
- **Phone Number**: Owner's personal/business cell number - customers see a real local number
- **Features**: SMS send/receive, webhook notifications
- **Best For**: Delivery notifications, order confirmations, two-way customer texting
- **Setup**: Install httpSMS app on Android phone, create API key at httpsms.com

### Twilio (Fallback - SMS + Voice)
- **Cost**: ~$33-55 CAD/month (see cost breakdown below)
- **Phone Number**: Dedicated Twilio number - separate from personal
- **Features**: SMS, voice IVR, voicemail transcription, call forwarding, real-time voice
- **Best For**: Voice features (IVR, call routing), high-volume SMS, professional separation
- **Setup**: Twilio account, phone number purchase, Cloudflare Tunnel for webhooks

### Recommendation

Use **httpSMS for SMS delivery notifications** and customer texting. This is free and customers see a familiar local number. Only upgrade to **Twilio if voice/IVR features are needed** (e.g., after-hours voicemail, automated call menus).

---

## Provider Comparison

| Feature | httpSMS | Twilio |
|---------|---------|--------|
| Monthly Cost | Free | $33-55 CAD |
| SMS Send | ✓ | ✓ |
| SMS Receive | ✓ | ✓ |
| Phone Number | Owner's cell | Dedicated |
| Customer Perception | Local business owner | Professional line |
| Voice IVR | ✗ | ✓ |
| Voicemail | ✗ | ✓ |
| Call Forwarding | ✗ | ✓ |
| Transcription | ✗ | ✓ |
| Real-time Voice AI | ✗ | ✓ |
| Webhooks | ✓ | ✓ |
| Rate Limits | Phone battery/carrier | Twilio limits |

---

## Phase 1: SMS Bot (httpSMS)

### Architecture

```
Customer SMS → Android Phone → httpSMS App → httpSMS API → Webhook → Pi
     ↑                                                              ↓
     └─────────── httpSMS API ← Pi (send response) ←───────────────┘
```

### Flow

1. Customer sends SMS to owner's phone number
2. httpSMS app on Android forwards message to httpSMS API
3. httpSMS triggers webhook to Pi via Cloudflare Tunnel
4. Express endpoint receives the webhook:
   - Validates request signature
   - Parses sender phone number and message body
   - Logs conversation to #store-inbox Slack channel
5. Agent router determines which agent handles the message:
   - `JESTER:` prefix → routes to Jester agent (easter egg)
   - Default → routes to Storefront agent (product inquiries, orders)
6. Selected agent processes message via `lib/llm-runner.js`
7. Response sent back to customer via httpSMS API
8. Response also logged to #store-inbox for visibility

### Routing Rules

| Prefix/Pattern | Agent | Description |
|----------------|-------|-------------|
| `JESTER:` | Jester | Easter egg agent for humorous responses |
| `HOURS` or `LOCATION` | Storefront | Quick info (could be handled without LLM) |
| `DELIVERY` or `WHERE` | Secretary | Delivery status check |
| Default | Storefront | Product inquiries, order status, general questions |

### SMS Webhook Endpoint

```
POST /webhooks/httpsms/sms

Headers:
  x-httpsms-signature: <signature for validation>

Body (application/json):
  {
    "id": "message-uuid",
    "from": "+1234567890",
    "to": "+1987654321",
    "content": "What dog food do you recommend for allergies?",
    "timestamp": "2026-03-27T14:30:00Z"
  }
```

### Slack Logging Format

All SMS conversations logged to #store-inbox:

```
📱 SMS from +1 (234) 567-8901
> What dog food do you recommend for allergies?

🤖 Agent: Storefront
> For dogs with allergies, I recommend our limited ingredient formulas...
```

### Session Management

- Conversations keyed by phone number
- Session context stored in agent memory (tiered system)
- Sessions expire after 24 hours of inactivity
- Each new session starts with a brief greeting/intro

---

## Phase 2: Voice IVR (Twilio Only)

This phase requires Twilio. Skip if voice features are not needed.

### Architecture

```
Customer Call → Twilio → Cloudflare Tunnel → Pi (Express) → TwiML Generator
                                                               ↓
                                                          IVR Menu
                                                               ↓
                                    ┌──────────────────────────┼──────────────────────────┐
                                    ↓                          ↓                          ↓
                              Press 1: Info              Press 2: Order            Press 3: Staff
                              (static TwiML)             (voicemail)               (call forwarding)
                                                               ↓                          ↓
                                                     Twilio Transcription       Google Calendar lookup
                                                               ↓                          ↓
                                                     Storefront Agent            Route to available staff
                                                     (order parsing)
```

### IVR Menu Options

| Key | Action | Implementation |
|-----|--------|----------------|
| 1 | Hours & Location | Static TwiML response (no LLM needed) |
| 2 | Place an Order | Record voicemail → transcribe → send to Storefront agent |
| 3 | Talk to Staff | Check Google Calendar for available staff → call forwarding |
| 4 | Talk to the Jester | Easter egg: connect to Jester agent (Phase 3 preview) |

### Voice Webhook Endpoint

```
POST /webhooks/twilio/voice

Headers:
  X-Twilio-Signature: <signature for validation>

Body:
  From: +1234567890
  To: +1987654321
  CallSid: CA...

Response: TwiML document defining IVR menu
```

### Example TwiML Response

```xml
<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Gather numDigits="1" action="/webhooks/twilio/voice/menu">
    <Say voice="Polly.Amy">
      Thank you for calling JT Pets!
      Press 1 for hours and location.
      Press 2 to place an order.
      Press 3 to speak with a staff member.
      Press 4 for a special surprise.
    </Say>
  </Gather>
  <Say>We didn't receive any input. Goodbye!</Say>
</Response>
```

### Voicemail Transcription Flow

1. Customer presses 2 (place order)
2. Twilio records voicemail (max 2 minutes)
3. Twilio transcribes audio to text
4. Transcription webhook triggers:
   - Message sent to Storefront agent
   - Agent parses order intent
   - Confirmation SMS sent to customer (via httpSMS or Twilio)
   - Order logged to #store-inbox

### Staff Routing via Google Calendar

1. Customer presses 3 (talk to staff)
2. System queries Google Calendar integration (`lib/integrations/google-calendar.js`)
3. Check for staff availability:
   - If staff available: forward call to staff phone number
   - If unavailable: offer voicemail or callback option
4. Staff phone numbers stored in context.json (not hardcoded)

---

## Phase 3: Voice Conversations (Twilio Only)

This phase requires Twilio. Skip if real-time voice AI is not needed.

### Architecture

```
Customer Call → Twilio → Speech-to-Text (streaming) → Agent → Text-to-Speech → Customer
                              ↓                         ↑
                         Live transcript                Response text
```

### Real-Time Voice Flow

1. Customer calls and selects option 4 (or future dedicated number)
2. Twilio establishes WebSocket connection for streaming audio
3. Speech-to-text converts customer speech in real-time
4. Transcribed text sent to selected agent
5. Agent response converted via text-to-speech
6. Audio streamed back to customer
7. Loop continues until call ends

### Twilio Media Streams

Uses Twilio's Media Streams for bidirectional audio:
- Inbound: Customer audio → WebSocket → Pi
- Outbound: Pi → WebSocket → Twilio → Customer

### Agent Selection for Voice

| Scenario | Agent |
|----------|-------|
| IVR option 4 | Jester (easter egg voice chat) |
| Direct line (future) | Storefront (customer service) |
| Staff escalation | Human (call forwarding) |

### Jester Voice Feature

The Jester agent in voice mode:
- Responds with witty commentary about the pet store
- Can roast business decisions (playfully)
- Limited to 2-minute calls to prevent abuse
- Logged to Slack with [JESTER CALL] prefix

---

## File Structure

```
slack-agent-bridge/
├── lib/
│   ├── integrations/
│   │   ├── httpsms.js         # httpSMS API wrapper (primary SMS)
│   │   ├── twilio.js          # Twilio SDK wrapper (fallback SMS + voice)
│   │   └── google-calendar.js # Existing: staff availability
│   └── llm-runner.js          # Existing: routes to agents
├── integrations/
│   └── sms-router.js          # Express router for SMS webhooks (both providers)
└── agents/
    ├── agents.json            # Add: jester agent definition
    └── jester/
        └── memory/            # Jester agent memory
```

### New Files

**lib/integrations/httpsms.js** - httpSMS API wrapper
- `sendSMS(to, message)` - Send SMS via httpSMS API
- `getMessages(since)` - Fetch received messages
- `registerWebhook(url)` - Register webhook for incoming SMS
- Graceful degradation if not configured

**lib/integrations/twilio.js** (future) - Twilio SDK wrapper
- Express router for `/webhooks/twilio/*` endpoints
- Twilio signature validation middleware
- SMS/voice webhook handlers
- TwiML response generation
- Agent routing logic
- Slack logging (to #store-inbox)

---

## Security

### Webhook Validation (httpSMS)

Validate incoming webhooks using signature:

```javascript
const crypto = require('crypto');

function validateHttpSmsSignature(req, res, next) {
    const signature = req.headers['x-httpsms-signature'];
    const payload = JSON.stringify(req.body);
    const secret = process.env.HTTPSMS_WEBHOOK_SECRET;

    const expected = crypto
        .createHmac('sha256', secret)
        .update(payload)
        .digest('hex');

    if (signature !== expected) {
        return res.status(403).send('Invalid signature');
    }
    next();
}
```

### Webhook Validation (Twilio)

```javascript
const twilio = require('twilio');

function validateTwilioSignature(req, res, next) {
    const signature = req.headers['x-twilio-signature'];
    const url = process.env.TWILIO_WEBHOOK_URL + req.originalUrl;
    const params = req.body;

    if (!twilio.validateRequest(
        process.env.TWILIO_AUTH_TOKEN,
        signature,
        url,
        params
    )) {
        return res.status(403).send('Invalid signature');
    }
    next();
}
```

### Rate Limiting

| Limit | Value | Purpose |
|-------|-------|---------|
| SMS per phone per hour | 10 | Prevent spam/abuse |
| Calls per phone per hour | 5 | Prevent abuse |
| Voice minutes per call | 5 | Cost control |
| Voicemail duration | 2 min | Cost control |

### Phone Number Blocklist

- Maintain blocklist in memory/context.json
- Block numbers that abuse the system
- Alert #store-inbox when number is blocked

### Secrets

| Variable | Storage | Never Log |
|----------|---------|-----------|
| `HTTPSMS_API_KEY` | .env | ✓ |
| `HTTPSMS_PHONE_NUMBER` | .env | ✓ |
| `TWILIO_ACCOUNT_SID` | .env | ✓ |
| `TWILIO_AUTH_TOKEN` | .env | ✓ |
| `TWILIO_PHONE_NUMBER` | .env | ✓ |
| Staff phone numbers | context.json | ✓ |

---

## Environment Variables

### httpSMS (Primary)

| Variable | Description |
|----------|-------------|
| `HTTPSMS_API_KEY` | API key from httpsms.com. **Never log this.** |
| `HTTPSMS_PHONE_NUMBER` | Owner's phone number with httpSMS app (+1...) |

### Twilio (Fallback/Voice)

| Variable | Description |
|----------|-------------|
| `TWILIO_ACCOUNT_SID` | Twilio account SID (AC...) |
| `TWILIO_AUTH_TOKEN` | Twilio auth token (never log) |
| `TWILIO_PHONE_NUMBER` | JT Pets Twilio phone number (+1...) |
| `TWILIO_WEBHOOK_URL` | Public webhook URL via Cloudflare Tunnel |

### Shared

| Variable | Description | Default |
|----------|-------------|---------|
| `STORE_INBOX_CHANNEL_ID` | Slack channel for SMS/call logs | - |
| `SMS_SESSION_TTL_MS` | SMS session expiry | `86400000` (24h) |
| `VOICE_MAX_DURATION_SEC` | Max voice call duration | `300` (5 min) |

---

## Cost Estimation

### httpSMS

| Item | Cost |
|------|------|
| Service | Free |
| Phone | Uses existing Android phone |
| **Monthly Total** | **$0** |

### Twilio (if voice needed)

| Service | Unit Cost | Est. Volume | Monthly Cost |
|---------|-----------|-------------|--------------|
| Phone Number | $1.15 USD/mo | 1 | $1.15 |
| Inbound SMS | $0.0079/msg | 500 | $3.95 |
| Outbound SMS | $0.0079/msg | 500 | $3.95 |
| Inbound Voice | $0.0085/min | 200 min | $1.70 |
| Transcription | $0.025/15sec | 100 min | $10.00 |
| TTS (Amazon Polly) | $4.00/1M chars | ~50k chars | $0.20 |

**Estimated Total: $21-25 USD/month (~$28-35 CAD)**

With buffer for growth: **~$33-55 CAD/month**

---

## Implementation Checklist

### Phase 1: SMS Bot (httpSMS)

- [ ] Install httpSMS app on Android phone
- [ ] Create httpSMS account and API key
- [ ] Set up Cloudflare Tunnel for webhook endpoint (if not already)
- [ ] Create SMS webhook handler (`POST /webhooks/httpsms/sms`)
- [ ] Implement httpSMS signature validation
- [ ] Create #store-inbox Slack channel (if not exists)
- [ ] Implement agent routing (default + JESTER prefix)
- [ ] Add SMS session management to memory system
- [ ] Add httpSMS env vars to .env
- [ ] Write tests for SMS handler

### Phase 2: Voice IVR (Twilio - Optional)

- [ ] Purchase Twilio phone number (~$1.15/mo)
- [ ] Configure Twilio voice webhook URL
- [ ] Create `lib/integrations/twilio.js` with Express router
- [ ] Implement TwiML IVR menu generator
- [ ] Add voicemail recording endpoint
- [ ] Integrate Twilio transcription callback
- [ ] Connect transcriptions to Storefront agent
- [ ] Implement staff routing via Google Calendar
- [ ] Add staff phone numbers to context.json
- [ ] Write tests for IVR logic

### Phase 3: Voice Conversations (Twilio - Optional)

- [ ] Set up Twilio Media Streams WebSocket
- [ ] Integrate speech-to-text streaming
- [ ] Connect to agent via llm-runner
- [ ] Implement text-to-speech output
- [ ] Add real-time audio streaming
- [ ] Time-limit Jester calls (2 min)
- [ ] Load test voice handling

---

## Agent: Jester

Easter egg agent for humor and entertainment.

### Definition (for agents.json)

```json
{
  "id": "jester",
  "name": "The Jester",
  "role": "Comedic relief, witty commentary, playful business roasts",
  "channel": null,
  "permissions": ["sms", "twilio-voice"],
  "denied": ["github", "file-system", "square-write"],
  "priority": 5,
  "max_turns": 10,
  "memory_dir": "agents/jester/memory",
  "status": "planned",
  "personality": "Witty court jester who knows everything about the pet store and isn't afraid to offer unsolicited opinions"
}
```

### Personality Guidelines

- Self-aware AI that plays the role of court jester
- Can comment on business decisions (playfully critical)
- Never mean-spirited, always in good fun
- References pet store context when possible
- Limited knowledge scope (no sensitive business data)

---

## Slack Logging

All SMS interactions logged to #store-inbox:

### SMS Format
```
📱 SMS from +1 (234) 567-8901 | Agent: Storefront | via httpSMS
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Customer: What's the price of Acana dog food?
Agent: Acana Adult Dog costs $89.99 for a 25lb bag...
```

### Voice Format (Twilio only)
```
📞 Call from +1 (234) 567-8901 | Duration: 2:34
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
IVR Selection: 2 (Place Order)
Voicemail Transcript: "Hi, I'd like to order two bags of the senior cat food..."
Agent Response: Order created for 2x Senior Cat Formula. Confirmation SMS sent.
```

---

## Revision History

| Date | Change |
|------|--------|
| 2026-03-26 | Initial Twilio design specification |
| 2026-03-27 | Renamed to SMS-INTEGRATION.md. Added httpSMS as primary provider, Twilio as fallback. Updated architecture for dual-provider support. |
