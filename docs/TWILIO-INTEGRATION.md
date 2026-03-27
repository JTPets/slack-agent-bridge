# Twilio Integration Specification

This document defines the Twilio integration for SMS and voice communication with the bridge-agent system. The integration enables customers to interact with JT Pets via SMS and phone calls, routed through existing agents.

---

## Overview

Twilio provides the telephony layer for:
- **SMS Bot**: Two-way text messaging with intelligent agent routing
- **Voice IVR**: Interactive voice response menu for common inquiries
- **Voice Conversations**: Real-time speech-to-text conversations with agents

Both run on the same Raspberry Pi as the existing bridge-agent, using an Express webhook server exposed via Cloudflare Tunnel.

---

## Phase 1: SMS Bot

### Architecture

```
Customer SMS → Twilio → Cloudflare Tunnel → Pi (Express) → Agent Router → LLM
     ↑                                                                      ↓
     └──────────────────── Twilio SMS Reply ←──────────────────────────────┘
```

### Flow

1. Customer sends SMS to JT Pets Twilio number
2. Twilio forwards message to webhook URL via Cloudflare Tunnel
3. Express endpoint receives the webhook:
   - Validates Twilio signature (security)
   - Parses sender phone number and message body
   - Logs conversation to #store-inbox Slack channel
4. Agent router determines which agent handles the message:
   - `JESTER:` prefix → routes to Jester agent (easter egg)
   - Default → routes to Storefront agent (product inquiries, orders)
5. Selected agent processes message via `lib/llm-runner.js`
6. Response sent back to customer via Twilio SMS API
7. Response also logged to #store-inbox for visibility

### Routing Rules

| Prefix/Pattern | Agent | Description |
|----------------|-------|-------------|
| `JESTER:` | Jester | Easter egg agent for humorous responses |
| `HOURS` or `LOCATION` | Storefront | Quick info (could be handled without LLM) |
| Default | Storefront | Product inquiries, order status, general questions |

### SMS Webhook Endpoint

```
POST /webhooks/twilio/sms

Headers:
  X-Twilio-Signature: <signature for validation>

Body (application/x-www-form-urlencoded):
  From: +1234567890
  To: +1987654321
  Body: "What dog food do you recommend for allergies?"
  MessageSid: SM...
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

## Phase 2: Voice IVR

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
   - Confirmation SMS sent to customer
   - Order logged to #store-inbox

### Staff Routing via Google Calendar

1. Customer presses 3 (talk to staff)
2. System queries Google Calendar integration (`lib/integrations/google-calendar.js`)
3. Check for staff availability:
   - If staff available: forward call to staff phone number
   - If unavailable: offer voicemail or callback option
4. Staff phone numbers stored in context.json (not hardcoded)

---

## Phase 3: Voice Conversations

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
├── integrations/
│   └── twilio.js           # Express webhook handler, Twilio SDK wrapper
├── lib/
│   ├── llm-runner.js       # Existing: routes to agents
│   └── integrations/
│       └── google-calendar.js  # Existing: staff availability
└── agents/
    ├── agents.json         # Add: jester agent definition
    └── jester/
        └── memory/         # Jester agent memory
```

### New File: integrations/twilio.js

Responsibilities:
- Express router for `/webhooks/twilio/*` endpoints
- Twilio signature validation middleware
- SMS/voice webhook handlers
- TwiML response generation
- Agent routing logic
- Slack logging (to #store-inbox)

Dependencies:
- `twilio` (Twilio Node SDK)
- `express` (already used for webhook server)

---

## Security

### Webhook Validation

All Twilio webhooks MUST be validated:

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
| `TWILIO_ACCOUNT_SID` | .env | ✓ |
| `TWILIO_AUTH_TOKEN` | .env | ✓ |
| `TWILIO_PHONE_NUMBER` | .env | ✓ |
| Staff phone numbers | context.json | ✓ |

---

## Environment Variables

### Required for Twilio Integration

| Variable | Description |
|----------|-------------|
| `TWILIO_ACCOUNT_SID` | Twilio account SID (AC...) |
| `TWILIO_AUTH_TOKEN` | Twilio auth token (never log) |
| `TWILIO_PHONE_NUMBER` | JT Pets Twilio phone number (+1...) |
| `TWILIO_WEBHOOK_URL` | Public webhook URL via Cloudflare Tunnel |

### Optional

| Variable | Description | Default |
|----------|-------------|---------|
| `STORE_INBOX_CHANNEL_ID` | Slack channel for SMS/call logs | - |
| `SMS_SESSION_TTL_MS` | SMS session expiry | `86400000` (24h) |
| `VOICE_MAX_DURATION_SEC` | Max voice call duration | `300` (5 min) |

---

## Cost Estimation

Based on earlier research, estimated monthly costs:

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

### Phase 1: SMS Bot

- [ ] Purchase Twilio phone number
- [ ] Set up Cloudflare Tunnel for webhook endpoint
- [ ] Create `integrations/twilio.js` with Express router
- [ ] Implement SMS webhook handler
- [ ] Add Twilio signature validation
- [ ] Create #store-inbox Slack channel
- [ ] Implement agent routing (default + JESTER prefix)
- [ ] Add SMS session management to memory system
- [ ] Add Jester agent to agents.json
- [ ] Write tests for SMS handler
- [ ] Add Twilio env vars to .env

### Phase 2: Voice IVR

- [ ] Configure Twilio voice webhook URL
- [ ] Implement TwiML IVR menu generator
- [ ] Add voicemail recording endpoint
- [ ] Integrate Twilio transcription callback
- [ ] Connect transcriptions to Storefront agent
- [ ] Implement staff routing via Google Calendar
- [ ] Add staff phone numbers to context.json
- [ ] Write tests for IVR logic

### Phase 3: Voice Conversations

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
  "permissions": ["twilio-sms", "twilio-voice"],
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

All Twilio interactions logged to #store-inbox:

### SMS Format
```
📱 SMS from +1 (234) 567-8901 | Agent: Storefront
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Customer: What's the price of Acana dog food?
Agent: Acana Adult Dog costs $89.99 for a 25lb bag...
```

### Voice Format
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
| 2026-03-26 | Initial design specification |
