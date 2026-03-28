# Email Monitor Agent Design

## Overview

The Email Monitor agent watches Gmail for important emails, categorizes them by urgency, and provides summaries for the daily digest. It can also handle unsubscribe requests for newsletters and marketing emails.

## Permissions

| Permission | Granted | Description |
|------------|---------|-------------|
| `gmail-read` | Yes | Read emails, check headers, scan body |
| `gmail-unsubscribe` | Yes | Click unsubscribe links in categorized emails |
| `gmail-send` | No | Cannot compose or send emails |
| `gmail-delete` | No | Cannot delete emails |
| `gmail-archive` | No | Cannot archive emails |

## Email Categories

Categories are defined in `agents/email-monitor/memory/rules.json`:

| Category | Action | Description |
|----------|--------|-------------|
| `urgent` | `notify_immediately` | Time-sensitive emails posted to Slack immediately |
| `important` | `include_in_digest` | Important emails summarized in daily digest |
| `newsletter` | `ignore` | Marketing/newsletters skipped; can auto-unsubscribe |
| `spam` | `ignore` | Spam and unwanted emails |

## Unsubscribe Capability

The Email Monitor can automatically unsubscribe from newsletters and marketing emails on behalf of the owner. This is a controlled capability with explicit opt-in requirements.

### How Unsubscribe Works

1. **Owner says "unsubscribe from X"** - The sender is added to `auto_unsubscribe_list` in rules.json
2. **Next email arrives from that sender** - The monitor:
   - Checks `List-Unsubscribe` header (RFC 2369) for one-click unsubscribe
   - Falls back to scanning email body for unsubscribe links
   - Triggers the unsubscribe action (HTTP GET/POST or mailto:)
3. **Logs the action** - Posts to bulletin board so Secretary can report: "Unsubscribed from 3 newsletters this week"

### Owner Commands

| Command | Action |
|---------|--------|
| "unsubscribe from [sender]" | Add sender to `auto_unsubscribe_list` |
| "auto-unsubscribe all newsletters" | Set `newsletter.auto_unsubscribe: true` |
| "stop auto-unsubscribe" | Set `newsletter.auto_unsubscribe: false` |
| "show unsubscribe list" | Display current `auto_unsubscribe_list` |

### Unsubscribe Methods

The agent supports multiple unsubscribe mechanisms:

1. **List-Unsubscribe Header** (preferred)
   - RFC 2369 compliant header: `List-Unsubscribe: <mailto:unsub@example.com>, <https://example.com/unsub>`
   - One-click HTTP POST with `List-Unsubscribe-Post: List-Unsubscribe=One-Click` (RFC 8058)

2. **Body Link Scanning**
   - Regex scan for common patterns: "unsubscribe", "opt out", "manage preferences"
   - Follows link and confirms unsubscribe action
   - Limited to senders in `auto_unsubscribe_list` for safety

3. **Mailto Handling**
   - For `mailto:` unsubscribe links, logs a task for Secretary to send the email
   - Secretary has `gmail-send` permission; Email Monitor does not

### Safety Controls

- **Explicit opt-in only** - Unsubscribe only happens for senders in `auto_unsubscribe_list` or when `newsletter.auto_unsubscribe` is enabled
- **No bulk actions** - Cannot mass-unsubscribe without owner approval
- **Logging required** - Every unsubscribe action is logged with timestamp, sender, and method
- **Bulletin board reporting** - Secretary includes unsubscribe summary in weekly digest

### Rules.json Structure

```json
{
  "categories": {
    "newsletter": {
      "action": "ignore",
      "auto_unsubscribe": false
    }
  },
  "auto_unsubscribe_list": [
    "marketing@example.com",
    "newsletter@somestore.com"
  ],
  "unsubscribe_log": [
    {
      "sender": "marketing@example.com",
      "timestamp": "2026-03-26T10:00:00.000Z",
      "method": "list-unsubscribe-header",
      "success": true
    }
  ]
}
```

## Integration with Secretary

The Email Monitor and Secretary agents coordinate via the bulletin board:

1. **Email Monitor** categorizes incoming email
2. **Urgent emails** trigger immediate Slack notification
3. **Important emails** are summarized for daily digest
4. **Unsubscribe actions** are logged to bulletin board
5. **Secretary** includes email summary and unsubscribe report in morning briefing

### Bulletin Board Format

```json
{
  "type": "email_summary",
  "date": "2026-03-26",
  "urgent_count": 2,
  "important_count": 8,
  "unsubscribed": ["marketing@example.com", "news@shop.com"]
}
```

## Workflow

### Email Processing Flow

```
Gmail → Email Monitor → Categorize → Action
                           │
                           ├── urgent → Slack notification
                           ├── important → Digest queue
                           ├── newsletter → Check auto_unsubscribe → Unsubscribe if enabled
                           └── spam → Ignore
```

### Unsubscribe Flow

```
Owner: "unsubscribe from marketing@example.com"
                │
                ▼
        Add to auto_unsubscribe_list
                │
                ▼
        Next email from marketing@example.com arrives
                │
                ▼
        Check List-Unsubscribe header
                │
        ┌───────┴───────┐
        │               │
    Found           Not found
        │               │
        ▼               ▼
    Click link      Scan body for link
        │               │
        └───────┬───────┘
                │
                ▼
        Log to unsubscribe_log
                │
                ▼
        Post to bulletin board
```

## Activation Checklist

- [ ] Create Gmail API credentials (OAuth or service account)
- [ ] Add `GMAIL_CREDENTIALS_PATH` to .env
- [ ] Grant `gmail-read` scope
- [ ] Create Slack channel `#email-monitor`
- [ ] Set channel ID in agents.json
- [ ] Test categorization with sample emails
- [ ] Test unsubscribe with test newsletter

## Vendor Deal Detection

When the Email Monitor detects a vendor email containing pricing keywords, it triggers a special workflow to help the owner capitalize on good deals.

### Pricing Keywords

The following keywords trigger vendor deal detection:
- `sale`, `discount`, `promo`, `clearance`
- `% off`, `special pricing`, `bulk pricing`
- `limited time`, `flash sale`, `deal`

### Extraction Process

When a vendor deal email is detected:

1. **Gemini extracts structured data:**
   - Vendor name
   - Product names
   - Sale prices
   - Regular prices
   - Sale dates (start/end)
   - Minimum quantities (if applicable)

2. **Posts to bulletin board:**
   ```json
   {
     "type": "vendor-deal",
     "priority": "high",
     "timestamp": "2026-03-26T10:00:00.000Z",
     "data": {
       "vendor": "ABC Pet Supplies",
       "products": [
         {
           "name": "Premium Dog Food 30lb",
           "salePrice": 45.99,
           "regularPrice": 59.99,
           "savings": 14.00
         }
       ],
       "validUntil": "2026-04-01",
       "minimumQty": null,
       "sourceEmail": "sales@abcpetsupplies.com"
     }
   }
   ```

### Secretary Integration

Secretary picks up vendor deal bulletins and cross-references with SqTools data (when available):

| Data Point | Source | Purpose |
|------------|--------|---------|
| Current sales velocity | SqTools API | Units sold per month |
| Current stock levels | SqTools API | Days of inventory remaining |
| Current margin | SqTools API | Existing profit margin |
| Sale margin | Calculated | New margin at sale price |

### Recommendation Algorithm

Secretary calculates the optimal purchase quantity:

1. **Base quantity:** 3-month supply based on sales velocity
2. **Stock adjustment:** Subtract current inventory
3. **Margin threshold:** Only recommend if margin improves by ≥5%
4. **Deal quality score:** `(regular_price - sale_price) / regular_price * 100`

### Slack Notification Format

Secretary posts recommendations to `#secretary-inbox`:

```
📦 Deal Alert: ABC Pet Supplies

Product: Premium Dog Food 30lb
Sale Price: $45.99 (save $14.00/unit)
Regular: $59.99 | Valid until: Apr 1

📊 Your Data:
• Sales velocity: 12 units/month
• Current stock: 8 units (20 days)
• Margin: 33% → 44% (+11%)

💡 Recommendation: Stock up 28 units (3mo supply - current stock)
Savings if purchased: $392.00

[View in SqTools] [Dismiss] [Snooze 1 week]
```

### Rules.json Category

```json
{
  "vendor_deal": {
    "action": "push_to_secretary",
    "priority": "high",
    "extract_pricing": true,
    "keywords": ["sale", "discount", "promo", "clearance", "% off", "special pricing", "bulk"]
  }
}
```

### Deal Processing Flow

```
Vendor Email Arrives
        │
        ▼
Check for pricing keywords
        │
        ├── No keywords → Normal categorization
        │
        └── Keywords found
                │
                ▼
        Extract pricing with Gemini
                │
                ▼
        Post to bulletin board (type: vendor-deal, priority: high)
                │
                ▼
        Secretary picks up bulletin
                │
                ▼
        Query SqTools for product data
                │
                ├── Product found → Calculate recommendation
                │       │
                │       ▼
                │   Post to #secretary-inbox
                │
                └── Product not found → Post deal summary only
```

### Safety Controls

- **Vendor whitelist** - Only process deals from known vendors in `trusted_vendors` list
- **No auto-purchase** - Recommendations only; owner must approve purchases
- **Duplicate detection** - Skip if same deal was processed in last 7 days
- **Price validation** - Flag suspicious deals (>80% off) for manual review

## Future Enhancements

- **Smart categorization** - Use LLM to categorize ambiguous emails
- **Sender reputation** - Track sender patterns over time
- **Auto-rules** - Suggest rules based on email patterns
- **Thread awareness** - Group related emails in digest
- **Deal history** - Track deal patterns by vendor over time
- **Price alerts** - Notify when prices drop below historical lows
