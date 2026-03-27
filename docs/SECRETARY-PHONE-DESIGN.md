# Secretary Agent Phone Design

This document specifies the phone capabilities for the Secretary agent, enabling JT Pets to handle inbound calls, make outbound delivery notifications, and coordinate with other agents via the bulletin board system.

---

## Overview

The Secretary agent acts as the receptionist for JT Pets, handling:
- **Inbound calls**: IVR menu, call routing, voicemail, message logging
- **Outbound calls**: Delivery confirmations, appointment reminders, vendor follow-ups
- **SMS**: Delivery ETAs, order confirmations, two-way customer communication

The Secretary integrates with Google Calendar to determine store hours and staff availability, and coordinates with other agents (especially store-ops) via the bulletin board pattern.

---

## Inbound Call Flow

### Architecture

```
Customer Call → Twilio → Secretary Agent → Google Calendar Check
                                              ↓
                           ┌──────────────────┼──────────────────┐
                           ↓                  ↓                  ↓
                    During Hours         After Hours        Staff Unavailable
                           ↓                  ↓                  ↓
                      IVR Menu         After Hours Menu      Voicemail
```

### During Business Hours

When a customer calls during store hours:

```
Secretary: "Hi, thanks for calling JT Pets!
            Press 1 for store hours and directions.
            Press 2 to place an order.
            Press 3 to check on a delivery.
            Press 4 to speak with staff."
```

| Key | Action | Implementation |
|-----|--------|----------------|
| 1 | Hours & Directions | Static TwiML response with store hours and address |
| 2 | Place Order | Record voicemail → transcribe → route to Storefront agent |
| 3 | Delivery Status | Check bulletin board for delivery status, read to customer |
| 4 | Talk to Staff | Check Google Calendar → forward call or offer voicemail |

### After Business Hours

When a customer calls outside store hours:

```
Secretary: "Thanks for calling JT Pets. We're currently closed.
            Our store hours are [read from calendar].
            Press 1 to leave a message and we'll get back to you.
            Press 2 to place an order by voicemail.
            Press 3 if this is urgent."
```

| Key | Action | Implementation |
|-----|--------|----------------|
| 1 | Leave Message | Record voicemail → transcribe → log to #store-inbox |
| 2 | Place Order | Record voicemail → transcribe → route to Storefront agent |
| 3 | Urgent | Forward to owner's cell (if configured) or offer callback |

### Call Logging

All calls are logged to #store-inbox:

```
📞 Inbound Call from +1 (416) 555-1234
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Time: 2:34pm | Duration: 1:45
IVR Selection: 3 (Delivery Status)
Outcome: Read delivery ETA from bulletin board
Status: Resolved
```

### Voicemail Handling

1. Customer leaves voicemail
2. Twilio transcribes audio
3. Secretary receives transcription webhook
4. Secretary determines intent:
   - Order-related → route to Storefront agent
   - Staff inquiry → log to #store-inbox, add to callback queue
   - General question → log to #store-inbox
5. Confirmation SMS sent to customer: "Thanks for calling JT Pets! We got your message and will get back to you shortly."

---

## Outbound Call Flow

### Delivery Confirmations

The Secretary monitors the bulletin board for delivery tasks posted by store-ops:

**Bulletin Board Entry (from store-ops):**
```json
{
  "type": "delivery_scheduled",
  "customer_phone": "+14165551234",
  "address": "45 King St",
  "time": "3:00pm",
  "items": ["2x Acana Adult Dog 25lb"],
  "driver": "John"
}
```

**Secretary Response (30 minutes before delivery):**

Option A - Auto-call:
```
Secretary calls customer:
"Hi, this is JT Pets! Your delivery is on the way.
Expected arrival is around 3pm.
Press 1 to confirm someone will be there.
Press 2 if you need to reschedule."
```

Option B - SMS:
```
📱 SMS to +1 (416) 555-1234:
"Your JT Pets order is out for delivery! 🐾
ETA ~30 minutes
Items: 2x Acana Adult Dog 25lb
Reply YES to confirm, or call us to reschedule."
```

**Bulletin Board Update (from Secretary):**
```json
{
  "type": "delivery_confirmed",
  "customer_phone": "+14165551234",
  "address": "45 King St",
  "confirmation": "customer confirmed, someone home",
  "confirmed_at": "2:35pm"
}
```

### Appointment Reminders

For appointments on the calendar (grooming, pickup times, etc.):

**24 hours before:**
```
SMS: "Hi! Reminder: Your JT Pets appointment is tomorrow at 10am.
Reply YES to confirm or call us to reschedule."
```

**2 hours before:**
```
SMS: "Your JT Pets appointment is in 2 hours at 10am. See you soon! 🐾"
```

### Vendor Follow-ups

Secretary monitors the calendar for missed vendor orders:

**Example Scenario:**
- Calendar shows "Hagen Order Due" at 6pm
- Owner doesn't mark it complete by 6:30pm
- Secretary calls/texts owner:

```
SMS to owner:
"Hey boss, looks like the Hagen order was due at 6pm but I don't see it marked complete.
Want me to draft it now? Reply YES and I'll have it ready for you to review."
```

If owner replies YES, Secretary:
1. Reads last Hagen order from memory/history
2. Drafts order based on typical patterns
3. Posts draft to #sqtools-ops for owner approval

### Customer Callbacks

When a customer requested a callback:

```
Secretary calls customer:
"Hi, this is JT Pets returning your call.
You asked about [transcribed voicemail summary].
[Route to appropriate response or staff]"
```

---

## SMS Capabilities

### Inbound SMS

Customer texts are handled by the Storefront agent by default, but Secretary monitors for specific patterns:

| Pattern | Action |
|---------|--------|
| "DELIVERY" or "WHERE" | Check delivery status, respond with ETA |
| "HOURS" or "OPEN" | Respond with store hours |
| "CALLBACK" or "CALL ME" | Add to callback queue, confirm with customer |

### Outbound SMS

| Type | Trigger | Content |
|------|---------|---------|
| Delivery ETA | Bulletin board entry | "Your order is out for delivery! ETA ~X min" |
| Delivery Confirmed | Driver confirms | "Your order has been delivered! Thanks for shopping with JT Pets 🐾" |
| Order Confirmation | Storefront order created | "Order confirmed! Total: $X. Pickup ready in ~30 min" |
| Appointment Reminder | Calendar event | "Reminder: Your appointment is tomorrow at X" |

---

## Cross-Agent Coordination

The Secretary coordinates with other agents via the bulletin board pattern (shared memory).

### Bulletin Board Schema

```json
{
  "bulletins": [
    {
      "id": "bulletin-uuid",
      "from": "store-ops",
      "to": "secretary",
      "type": "delivery_scheduled",
      "payload": { ... },
      "posted": "2026-03-26T14:30:00Z",
      "read": false,
      "response": null
    }
  ]
}
```

### Example: Delivery Coordination

1. **Store-ops posts bulletin:**
   ```
   "Delivery scheduled for 45 King St at 3pm"
   Payload: { customer_phone, address, items, driver }
   ```

2. **Secretary reads bulletin at 2:30pm:**
   - Sends SMS to customer: "Your order is out for delivery! ETA ~30 min"
   - Marks bulletin as read

3. **Customer confirms via SMS reply:**
   - Secretary posts response bulletin:
     ```
     "Customer confirmed delivery, someone home"
     ```

4. **Store-ops reads response:**
   - Confirms with driver
   - Updates delivery status

### Bulletin Types

| Type | From | To | Description |
|------|------|----|-------------|
| `delivery_scheduled` | store-ops | secretary | Notify customer of upcoming delivery |
| `delivery_confirmed` | secretary | store-ops | Customer confirmed delivery |
| `delivery_reschedule` | secretary | store-ops | Customer needs different time |
| `callback_requested` | secretary | store-ops | Customer wants a callback |
| `vendor_order_due` | secretary | owner | Vendor order deadline approaching |
| `vendor_order_draft` | secretary | owner | Draft order ready for review |

---

## Google Calendar Integration

Secretary uses the existing `lib/integrations/google-calendar.js` for:

### Store Hours

- Reads "Store Hours" calendar for open/close times
- Used in IVR: "We're open from X to Y"
- Used for after-hours routing

### Staff Availability

- Reads "Staff Schedule" calendar
- Determines who's working today
- Routes calls to available staff phones

### Appointments

- Reads "Appointments" calendar
- Sends reminders 24h and 2h before
- Tracks grooming, pickups, consultations

### Vendor Deadlines

- Reads "Vendor Orders" calendar
- Monitors for missed deadlines
- Proactively prompts owner

---

## Implementation Phases

### Phase 1: Inbound IVR (Builds on TWILIO-INTEGRATION.md Phase 2)

- [ ] Configure Secretary as IVR handler (instead of generic handler)
- [ ] Implement hours/closed routing via Google Calendar
- [ ] Add store hours TwiML response
- [ ] Add delivery status check via bulletin board
- [ ] Implement voicemail handling and transcription routing

### Phase 2: Outbound Notifications

- [ ] Implement bulletin board reader for delivery events
- [ ] Add delivery notification SMS (30 min before)
- [ ] Add delivery confirmation call option
- [ ] Implement appointment reminder SMS (24h and 2h)
- [ ] Add customer reply handling (YES/NO/reschedule)

### Phase 3: Cross-Agent Coordination

- [ ] Implement bulletin board shared memory
- [ ] Add store-ops → secretary delivery flow
- [ ] Add secretary → store-ops confirmation flow
- [ ] Implement vendor order monitoring
- [ ] Add owner notification for missed deadlines

### Phase 4: Smart Features

- [ ] Learn customer preferences (call vs SMS)
- [ ] Track delivery time patterns per area
- [ ] Auto-adjust ETAs based on driver patterns
- [ ] Build customer profile from conversation history

---

## Security & Privacy

### Phone Number Handling

- Customer phone numbers stored in short-term memory (48h TTL)
- Long-term customer profiles stored in long-term memory
- Phone numbers never logged with full detail (mask: +1***-***-1234)

### Staff Phone Numbers

- Stored in `agents/secretary/memory/context.json`
- Never logged or exposed
- Only used for call forwarding

### Conversation Logging

- Voicemail transcripts logged to #store-inbox
- No recording retention beyond Twilio's default
- Customer can request conversation deletion

---

## Environment Variables

Uses the same Twilio variables from CLAUDE.md:

| Variable | Description |
|----------|-------------|
| `TWILIO_ACCOUNT_SID` | Twilio account SID |
| `TWILIO_AUTH_TOKEN` | Twilio auth token (never log) |
| `TWILIO_PHONE_NUMBER` | JT Pets Twilio phone number |
| `STORE_INBOX_CHANNEL_ID` | Slack channel for call/SMS logs |

Additional Secretary-specific settings in `context.json`:

```json
{
  "staff_phones": {
    "owner": "+1XXXXXXXXXX",
    "staff1": "+1XXXXXXXXXX"
  },
  "delivery_notification_minutes_before": 30,
  "appointment_reminder_hours": [24, 2],
  "customer_preferred_contact": {}
}
```

---

## Revision History

| Date | Change |
|------|--------|
| 2026-03-26 | Initial secretary phone design specification |
