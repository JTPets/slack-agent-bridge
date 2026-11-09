# Social Media Manager Agent Design

This document describes the design and implementation plan for the Social Media Manager agent.

## Overview

The Social Media Manager agent creates, schedules, and manages social media content for JT Pets across Instagram, Facebook, and Meta Business Suite. It generates pet nutrition tips, product highlights, delivery promotions, and community engagement posts while monitoring engagement and suggesting content strategy.

## Content Generation

### Product Spotlights
- Auto-generate "Product of the Day" posts from Square catalog
- Pull product name, description, price, and images via Square Catalog API
- Create compelling captions highlighting key features and benefits
- Include pricing and availability information

### Pet Nutrition Tips
- Leverage John's expertise with 200+ pet food brands
- Generate educational content about ingredient quality, species-appropriate diets
- Tips for common pet health concerns (allergies, weight management, coat health)
- Seasonal nutrition advice (summer hydration, winter calorie needs)

### Delivery Promotions
- "Free local delivery in Hamilton!" messaging
- Delivery zone maps and cutoff times
- Special delivery promotions (weekend specials, holiday schedules)
- Customer delivery testimonials and success stories

### Behind-the-Scenes Content
- Suggest store content opportunities (new product arrivals, staff picks)
- Feature customer pets (with permission) as "Pet of the Week"
- Store event coverage (adoption days, brand rep visits)

### Seasonal Content
- Flea/tick season awareness and prevention tips
- Winter coat care and cold weather safety
- Holiday pet safety (toxic foods, decoration hazards)
- Back-to-school pet adjustment tips
- Allergy season management

### Community Engagement
- "What does your pet eat? Comment below!"
- Pet photo contests and giveaways
- Poll-based content (favorite flavors, food toppers)
- Q&A sessions on pet nutrition

## Platform Strategy

### Instagram
- **Visual Focus**: High-quality product shots, lifestyle images
- **Reels**: Short nutrition tip videos, product demos, store tours
- **Stories**: Daily specials, limited inventory alerts, behind-the-scenes
- **Hashtags**: #HamiltonPets #PetNutrition #JTPets #LocalDelivery

### Facebook
- **Community Engagement**: Longer-form nutrition articles, discussions
- **Events**: Adoption days, brand events, store promotions
- **Groups**: Potential Hamilton pet owners community group
- **Local Targeting**: Hamilton-area audience focus

### Meta Business Suite
- **Unified Scheduling**: Single interface for both platforms
- **Analytics Dashboard**: Cross-platform performance tracking
- **Content Calendar**: Visual planning and scheduling

## Content Pipeline

### Draft Generation Flow

```
1. Agent generates content idea based on:
   - Square catalog (new products, popular items)
   - Seasonal calendar
   - Engagement trends
   - Owner input/requests

2. Agent creates draft post:
   - Caption text (platform-optimized)
   - Image prompt for generation (or catalog image)
   - Suggested hashtags
   - Optimal posting time recommendation

3. Draft posted to #social-media Slack channel:
   ---
   **Draft Post** [Instagram]

   Caption: "Did you know salmon is one of the best proteins for skin and coat health?
   Our new Wild Alaskan Salmon formula from Acana is packed with omega-3s!
   #PetNutrition #HealthyCoat #JTPets"

   Image: [Product photo or generated image]
   Suggested time: Tuesday 6pm (peak engagement)

   React: ✅ to approve | ✏️ to edit | ❌ to reject
   ---

4. Owner reviews and responds:
   - ✅ Approve: Agent schedules via Meta API
   - ✏️ Edit: Owner provides edits, agent resubmits
   - ❌ Reject: Agent generates alternative

5. Agent schedules approved content via Meta Graph API

6. Weekly: Agent posts engagement report to #social-media
```

### Approval Workflow

All posts require owner approval before scheduling. The agent NEVER auto-posts without explicit approval. This ensures:
- Brand voice consistency
- Accuracy of nutrition claims
- Appropriate pricing and promotions
- Compliance with pet food advertising guidelines

## What is built (2026-11-09)

The owner chose Facebook, Instagram, Google Business Profile and Bluesky, both posting and
reading (2026-11-09). The sections below this one are the original March design; where they
differ, this section is what the code does.

| Step | Where | What it does |
|------|-------|--------------|
| New items | `lib/catalog-new-items.js`, `lib/integrations/square-catalog-api.js` | Daily diff of the read-only Square catalog against the ids and category names seen before. First run is a baseline. Square has no brand field, so a new category stands in for a new brand |
| Drafts | `lib/social-drafts.js` | The agent's own model, one turn, no tools, the item's facts only, answers JSON: a post for Facebook/Instagram/Google and a 300-character Bluesky version. Posted in #social-media with Publish / Edit / Reject |
| Approval | `lib/social-buttons.js` | **The only path to a live post.** An allowlisted person presses Publish behind a confirm naming the platforms. The draft is claimed first, so it publishes once. Each platform's result (link or reason) is written on the post |
| Publishing | `lib/social-meta.js`, `lib/social-gbp.js`, `lib/social-bluesky.js`, `lib/social-platforms.js` | Graph API v26.0 (Page photo/feed post; Instagram container then publish), Business Profile v4 localPosts, Bluesky createRecord. An unconfigured platform is skipped and named |
| Reading | same, `lib/social-insights.js` | A daily snapshot per platform kept 400 days, because the platforms show today's numbers, not a history |
| Digest | `lib/social-insights.js` | Mondays (and `ASK: social`): followers this week, best post, Instagram comments nobody answered, repeat commenters, new and lost Bluesky followers, unanswered Google reviews, the listing's views/calls/directions against the week before. Computed, not written by a model |
| Schedule | `lib/social-daily.js` | `social-daily` at 09:00 Toronto; on demand with `ASK: social` |

**What the platforms do not give**, so nothing here claims it: Facebook and Instagram return no list
of followers (counts, aggregated demographics and commenters only). Bluesky's follower list is
public. LinkedIn and X are not built: LinkedIn company-page access needs LinkedIn's vetting, and X's
API is pay-per-use since 2026.

**Never auto-posts.** The model never sees a platform token: tokens live in `.env` and are used only
by the publishing code after a press.

## Environment Variables

The full table is in `CLAUDE.md` → "Social media". Names: `META_PAGE_ACCESS_TOKEN`, `META_PAGE_ID`,
`INSTAGRAM_BUSINESS_ID`, `META_GRAPH_VERSION`, `GBP_ACCOUNT_ID`, `GBP_LOCATION_ID`,
`GBP_REFRESH_TOKEN`, `BLUESKY_HANDLE`, `BLUESKY_APP_PASSWORD`, `BLUESKY_PDS`, plus
`SQUARE_ACCESS_TOKEN` for the new-item check. Setup steps are the social-media activation
checklist in `agents/activation-checklists.json`.

## Implementation Phases

### Phase 1: Content Generation (Current)
- Generate text content (captions, hashtags, posting times)
- Post drafts to #social-media Slack channel for approval
- Manual posting by owner after approval
- Basic content calendar suggestions

**Deliverables:**
- Content generation prompts and templates
- Slack integration for draft posting
- Product spotlight automation from Square catalog

### Phase 2: Auto-Scheduling
- Implement Meta Graph API integration
- Auto-schedule approved posts via API
- Handle API errors and rate limits
- Post scheduling confirmations to Slack

**Deliverables:**
- Meta API integration module
- Scheduling queue with retry logic
- Post preview before scheduling

### Phase 3: Engagement Monitoring
- Fetch engagement metrics (likes, comments, shares, reach)
- Weekly engagement report generation
- Content strategy optimization suggestions
- A/B testing for captions (same image, different captions)
- Follower growth tracking

**Deliverables:**
- Analytics dashboard data
- Weekly summary reports
- Content performance insights
- A/B test framework

## Content Guidelines

### Brand Voice
- Friendly and knowledgeable, not salesy
- Educational focus on pet health
- Local Hamilton community connection
- Emphasis on quality over price

### Compliance
- No unsubstantiated health claims
- Clear pricing and availability
- Proper disclosure for promotions
- Respect customer privacy (no photos without permission)

### Posting Frequency
- **Instagram**: 1 post/day, 2-3 stories/day
- **Facebook**: 1 post/day, shared Instagram content
- **Peak Times**: Tuesday-Thursday, 6-8pm local time

## Cross-Agent Coordination

### With Storefront Agent
- Share popular product data for content ideas
- Coordinate promotions and inventory alerts
- Customer feedback for testimonial content

### With Secretary Agent
- Coordinate delivery promotion timing
- Event scheduling and reminders
- Customer follow-up for engagement

## Security Considerations

- Meta access tokens stored in `.env`, never logged
- Read-only Square catalog access (no order manipulation)
- No direct customer data exposure
- Approval workflow prevents unauthorized posting
- Rate limiting to prevent API abuse

## Monitoring and Alerts

- Alert if Meta API token expires
- Alert if posting fails after approval
- Weekly engagement metric thresholds
- Follower count anomaly detection
