# Marketing Manager Agent Design

This document describes the design and implementation plan for the Marketing Manager agent.

## Overview

The Marketing Manager agent handles all paid and organic marketing channels except social media content creation (handled by Social Media agent). It focuses on measurable revenue growth through Google Business Profile optimization, product listings, analytics, and review monitoring.

## Permissions

| Permission | Granted | Description |
|------------|---------|-------------|
| `google-business-profile` | Yes | Manage GBP posts, reviews, info, photos |
| `google-merchant-center` | Yes | Sync product catalog for free listings |
| `google-analytics` | Yes | Read traffic and conversion data |
| `google-ads-readonly` | Yes | Monitor spend and performance (no edits) |
| `yelp-readonly` | Yes | Monitor reviews (cannot respond via API) |
| `github-write` | No | No code changes |
| `file-system-write` | No | No file system access |
| `payment-processing` | No | No payment handling |

## Platform Integrations

### Google Business Profile (Business Profile API)

**Purpose:** Manage the store's Google Business Profile listing to maximize local search visibility.

**Capabilities:**
- Auto-post store updates, events, and promotions
- Monitor and draft responses to reviews (owner approves before posting)
- Keep hours, photos, and business info current
- Post pet awareness day content from `lib/integrations/holidays.js`

**API Endpoints:**
- `accounts.locations.patch` - Update business info
- `accounts.locations.media.create` - Add photos
- `accounts.locations.localPosts.create` - Create posts
- `accounts.locations.reviews.list` - Fetch reviews
- `accounts.locations.reviews.updateReply` - Reply to reviews (after owner approval)

**Posting Schedule:**
- Post pet awareness dates from holidays.js (auto-generated content)
- Weekly store update posts (new products, promotions)
- Event posts for adoption days, brand visits

**Review Response Workflow:**
1. Fetch new reviews daily
2. Draft response using LLM
3. Post draft to Slack for owner approval
4. On approval, submit reply via API

### Google Merchant Center (Content API for Shopping)

**Purpose:** Sync Square catalog to Google Merchant Center for free product listings in Google Shopping.

**Capabilities:**
- Nightly sync of Square catalog (~2,700 SKUs) to Merchant Center
- Product data: name, description, price, image, availability, category
- Uses existing `lib/integrations/square-catalog.js` as data source
- Free product listings appear in Google Shopping tab

**Product Feed Schema:**
```json
{
  "offerId": "SQUARE_ITEM_ID",
  "title": "Product Name",
  "description": "Product description from Square",
  "link": "https://jtpets.ca/products/{id}",
  "imageLink": "https://...",
  "price": { "value": "29.99", "currency": "CAD" },
  "availability": "in_stock",
  "brand": "Brand Name",
  "productTypes": ["Animals & Pet Supplies > Pet Food"],
  "channel": "online",
  "contentLanguage": "en",
  "targetCountry": "CA"
}
```

**Sync Process:**
1. Fetch all items from Square Catalog API
2. Transform to Merchant Center product format
3. Calculate availability from Square inventory
4. Batch upload via Content API
5. Log sync status to Slack

**API Endpoints:**
- `products.insert` - Add/update products
- `products.delete` - Remove discontinued items
- `productstatuses.list` - Check feed health and errors

### Google Analytics (Data API)

**Purpose:** Track website traffic and conversions to measure marketing effectiveness.

**Capabilities:**
- Weekly traffic report: sessions, conversions, top pages, referral sources
- Alert if traffic drops 20%+ week over week
- Track conversion funnel performance
- Identify top-performing products and pages

**Weekly Report Format:**
```
📊 Weekly Traffic Report (Mar 20-27)

Sessions: 450 (+12% vs last week)
New Users: 280
Bounce Rate: 45%

Top Pages:
1. /raw-dog-food (120 views)
2. /freeze-dried-treats (85 views)
3. /delivery (62 views)

Traffic Sources:
- Google Search: 45%
- Direct: 30%
- Social: 15%
- Referral: 10%

Conversions: 12 orders from Google
```

**Alerts:**
- Traffic drop >20% WoW
- Bounce rate spike >60%
- Conversion rate drop >15%

**API Endpoints:**
- `runReport` - Run custom reports
- `runRealtimeReport` - Real-time traffic (for monitoring)

### Google Ads (Read-Only - Future Phase)

**Purpose:** Monitor paid advertising performance (read-only initially).

**Phase 1 Capabilities (Read-Only):**
- Monitor daily/weekly spend
- Track clicks, impressions, CTR
- Monitor conversion metrics
- Alert on unusual spend patterns

**Phase 2 Capabilities (Future - Requires Approval):**
- Auto-pause underperforming campaigns
- Suggest bid adjustments based on ROAS
- Budget reallocation recommendations

**Note:** Write operations require explicit owner approval. Phase 2 will not be implemented without discussion.

### Yelp (Fusion API - Read Only)

**Purpose:** Monitor Yelp reviews for reputation management.

**Capabilities:**
- Monitor new reviews daily
- Alert Secretary on new reviews
- Draft response for owner approval
- Track rating trends over time

**Limitations:**
- **Cannot post responses via API** - Yelp API does not support review responses
- Owner must respond manually via Yelp app or website
- Agent can only prepare draft responses in Slack

**Review Monitoring Workflow:**
1. Check for new reviews daily (8am cron)
2. Post new reviews to Slack with sentiment analysis
3. Generate draft response if negative (1-3 stars)
4. Owner responds manually on Yelp

**API Endpoints:**
- `businesses/{id}/reviews` - Fetch reviews
- `businesses/{id}` - Get business details and rating

### Facebook/Instagram (Meta Graph API)

**Note:** Content creation is handled by the Social Media agent, not Marketing.

**Marketing's Role:**
- Provide analytics data to Social Media agent
- Coordinate promotional timing with ad campaigns
- Share audience insights for content targeting

**Cross-Agent Communication:**
- Marketing posts analytics summaries to bulletin board
- Social Media agent consumes data for content optimization
- Shared `META_ACCESS_TOKEN` in .env (owner manages OAuth)

## Environment Variables

### Required

| Variable | Description |
|----------|-------------|
| `GOOGLE_BUSINESS_PROFILE_ACCOUNT_ID` | GBP account ID for API access |
| `GOOGLE_MERCHANT_CENTER_ID` | Merchant Center account ID |

### Optional

| Variable | Description | Default |
|----------|-------------|---------|
| `YELP_API_KEY` | Yelp Fusion API key for review monitoring | - |
| `META_ACCESS_TOKEN` | Shared with social-media agent | - |
| `META_PAGE_ID` | Facebook Page ID | - |
| `GA_PROPERTY_ID` | Google Analytics property ID | - |
| `GOOGLE_ADS_CUSTOMER_ID` | Google Ads customer ID (future) | - |

**Note:** Google APIs use the same service account credentials as other Google integrations (`GOOGLE_SERVICE_ACCOUNT_KEY`).

## Implementation Phases

### Phase 1: Google Business Profile

**Priority:** High - Immediate local SEO impact

**Deliverables:**
- GBP API integration module
- Auto-posting from holidays.js pet awareness dates
- Review monitoring and draft responses
- Store info/hours update capability

**Tasks:**
1. Create `lib/integrations/google-business.js`
2. Implement review fetch and Slack notification
3. Create post templates for pet awareness dates
4. Build approval workflow for review responses

### Phase 2: Google Merchant Center

**Priority:** High - Free product visibility

**Deliverables:**
- Product feed sync from Square catalog
- Nightly automated sync cron job
- Feed health monitoring
- Error reporting to Slack

**Tasks:**
1. Create `lib/integrations/google-merchant.js`
2. Build Square → Merchant Center transformer
3. Implement batch upload with retry logic
4. Add feed status monitoring

### Phase 3: Google Analytics

**Priority:** Medium - Performance tracking

**Deliverables:**
- Weekly traffic report generation
- Traffic drop alerts
- Conversion tracking
- Report posting to Slack

**Tasks:**
1. Create `lib/integrations/google-analytics.js`
2. Build report generation templates
3. Implement alert thresholds
4. Schedule weekly report cron

### Phase 4: Yelp Monitoring

**Priority:** Medium - Reputation management

**Deliverables:**
- Daily review check
- New review alerts
- Draft response generation
- Rating trend tracking

**Tasks:**
1. Create `lib/integrations/yelp.js`
2. Implement review polling
3. Build sentiment analysis for prioritization
4. Create response draft workflow

### Phase 5: Google Ads (Future)

**Priority:** Low - Requires budget and approval

**Deliverables:**
- Spend and performance dashboards
- Alert on unusual patterns
- (Phase 2: automated optimizations)

**Note:** This phase requires explicit owner approval and advertising budget allocation.

## Content Generation

### Pet Awareness Posts (GBP)

The Marketing agent auto-generates GBP posts for pet awareness dates from `lib/integrations/holidays.js`:

```javascript
// Example: National Pet Day post
{
  summary: "🐾 Happy National Pet Day! Stop by JT Pets today for special treats and nutrition advice for your furry family members.",
  callToAction: {
    actionType: "LEARN_MORE",
    url: "https://jtpets.ca"
  }
}
```

### Review Response Drafts

LLM generates responses based on review content:

**Positive Review (4-5 stars):**
```
Thank you so much for the kind words, [Name]! We're thrilled that [specific mention from review]. Looking forward to seeing you and [pet name] again soon!
```

**Negative Review (1-3 stars):**
```
Hi [Name], we're sorry to hear about your experience with [issue]. We'd love the chance to make this right. Please reach out to us directly at [phone/email] so we can address your concerns.
```

## Cross-Agent Coordination

### With Social Media Agent

| Data | Direction | Purpose |
|------|-----------|---------|
| Traffic analytics | Marketing → Social | Content performance insights |
| Top products | Marketing → Social | Product spotlight suggestions |
| Pet awareness dates | Shared (holidays.js) | Coordinated content calendar |
| Campaign timing | Marketing → Social | Align organic with paid |

### With Secretary Agent

| Data | Direction | Purpose |
|------|-----------|---------|
| New Yelp reviews | Marketing → Secretary | Include in daily briefing |
| Traffic alerts | Marketing → Secretary | Escalate drops to owner |
| GBP review drafts | Marketing → Secretary | Approval coordination |

### With Storefront Agent

| Data | Direction | Purpose |
|------|-----------|---------|
| Popular products | Storefront → Marketing | Promotion candidates |
| Customer queries | Storefront → Marketing | Content ideas |

## Security Considerations

- All API tokens stored in `.env`, never logged
- Read-only access for Google Ads and Yelp (no write operations)
- Review responses require owner approval before posting
- No customer PII exposed in analytics reports
- Rate limiting on all API calls
- Service account with minimal required scopes

## Monitoring and Alerts

| Alert | Threshold | Channel |
|-------|-----------|---------|
| Traffic drop | >20% WoW | #secretary-inbox |
| Feed sync failure | Any error | #sqtools-ops |
| New Yelp review | 1-3 stars | #secretary-inbox (priority) |
| GBP post failure | Any error | #sqtools-ops |
| Google Ads spend anomaly | >50% daily increase | #secretary-inbox |

## Metrics and KPIs

The Marketing agent tracks and reports on:

| Metric | Target | Frequency |
|--------|--------|-----------|
| Google Search impressions | +10% MoM | Weekly |
| GBP profile views | +5% MoM | Weekly |
| Merchant Center clicks | Track baseline | Weekly |
| Yelp rating | Maintain 4.5+ | Monthly |
| Website sessions | +10% MoM | Weekly |
| Conversion rate | >2% | Weekly |

## Activation Checklist

See `agents/activation-checklists.json` for detailed setup tasks:

1. Enable Google Business Profile API
2. Create Merchant Center account and link to Square
3. Set up Google Analytics Data API access
4. Obtain Yelp Fusion API key
5. Configure service account permissions
6. Create #marketing Slack channel
7. Test each integration independently
