# Story Bot Agent Design

This document describes the design and implementation plan for the Story Bot agent - John Alexander's personal brand storyteller for LinkedIn.

## Overview

The Story Bot manages John Alexander's LinkedIn personal profile and the SqTools business page. It crafts authentic build-in-public content that tells the story of a self-taught builder transforming pet retail with AI. The bot writes 3 high-quality posts per week maximum - quality over quantity.

## Content Strategy

### Personal LinkedIn (John Alexander)

**Build-in-Public Posts**
- "I built a 9-agent AI team on a Raspberry Pi in 48 hours. Here's what I learned."
- Real-time progress updates on technical builds
- Transparent sharing of wins and failures

**Founder Journey**
- Farmers market origins to brick-and-mortar
- AI-powered retail platform evolution
- District manager at Pet Valu to independent store owner
- Self-taught programming journey

**Industry Commentary**
- Pet retail trends and disruption
- Square ecosystem insights
- Small business AI adoption
- Franchise industry observations

**Technical Deep-Dives**
- How SqTools architecture works
- Raspberry Pi deployment decisions
- Self-improving agent systems
- Integration patterns and learnings

**Failures and Lessons**
- The PM2 crash that took down production
- Debugging sessions at 4am
- Wrong turns and course corrections
- What didn't work and why

**Square Developer Champion Content**
- API discoveries and tips
- Community contributions
- Developer ecosystem insights
- Integration case studies

**Pet Valu / Franchise Industry Insights**
- Position as industry expert
- Attract conversations like Rohan Cherian
- Franchise operational knowledge
- Industry transformation perspectives

### SqTools Business Page (sqtools.ca)

**Product Updates**
- New features and integrations
- Changelog highlights
- Roadmap previews

**Case Studies**
- How JT Pets uses SqTools
- Real-world results and metrics
- Before/after comparisons

**Developer Community**
- Square API tips and tutorials
- Integration guides
- Technical walkthroughs

**Hiring/Collaboration Posts**
- Future team expansion
- Partnership opportunities
- Community building

## Content Calendar

| Day | Theme |
|-----|-------|
| Monday | Founder story / lesson learned |
| Wednesday | Technical build-in-public |
| Friday | Industry commentary or Square ecosystem |

**Maximum 3 posts per week** - The Story Bot is NOT a content mill. Each post should feel like John wrote it himself.

## Voice and Style

### Writing Principles
- Direct and honest - no buzzwords
- ADHD-friendly short paragraphs
- Conversational, like talking to founders over coffee
- Never corporate, never cringe
- Find the human angle in every technical achievement

### Post Structure
Every post needs:
1. **Hook** - First line that stops the scroll
2. **Story** - The narrative that creates connection
3. **Takeaway** - Value the reader walks away with

### Examples

**Good Hook:**
> "I automated my entire pet store with $35 in hardware."

**Bad Hook:**
> "Excited to share our latest AI innovation!"

**Good Story:**
> "At 2am, the PM2 process crashed. All 9 agents went dark. The store opens in 6 hours. Here's how I fixed it without losing a single order..."

**Bad Story:**
> "We implemented a robust failover system to ensure maximum uptime."

## Workflow

```
1. Story Bot drafts post based on:
   - Recent achievements from task history
   - Backlog items and milestones
   - Calendar events (launches, anniversaries)
   - Seasonal themes

2. Draft posted to #social-media for approval:
   ---
   **LinkedIn Draft** [Personal/Company]

   [Post content here]

   ---
   React: :white_check_mark: to approve | :pencil: to edit
   ---

3. Owner reviews:
   - :white_check_mark: Approve → Bot publishes via LinkedIn API
   - :pencil: Edit → Owner provides edits, bot resubmits

4. On approval:
   - Bot publishes to LinkedIn
   - Confirms in #social-media with post link

5. Engagement tracking:
   - Likes, comments, shares
   - Profile views
   - Connection requests

6. Weekly report from Secretary:
   "LinkedIn recap: 3 posts, 245 impressions, 12 new connections"
```

## LinkedIn API Integration

### Endpoints

**Personal Posts**
```
POST /ugcPosts
Author: person URN (urn:li:person:XXXXX)
```

**Company Posts**
```
POST /ugcPosts
Author: organization URN (urn:li:organization:XXXXX)
```

### Required OAuth Scopes
- `w_member_social` - Post on behalf of user
- `r_liteprofile` - Read user profile
- `w_organization_social` - Post on company page

### Environment Variables

| Variable | Description | Required |
|----------|-------------|----------|
| `LINKEDIN_ACCESS_TOKEN` | OAuth access token | Yes |
| `LINKEDIN_PERSON_URN` | John's LinkedIn person URN | Yes |
| `LINKEDIN_ORG_URN` | SqTools company page URN | Yes |
| `LINKEDIN_CLIENT_ID` | OAuth app client ID | Yes |
| `LINKEDIN_CLIENT_SECRET` | OAuth app client secret | Yes |

**Note:** LinkedIn access tokens expire and require refresh token flow. See activation checklist for setup steps.

## Cross-Agent Coordination

### With Secretary
- Receives weekly engagement metrics
- Coordinates posting schedule with calendar
- Gets reminders for content deadlines

### With Social Media Manager
- Coordinates voice across platforms
- Shares engagement learnings
- Avoids content overlap

### With Bridge Agent
- Pulls recent task completions for content ideas
- References technical achievements
- Gets deployment milestones

## Implementation Phases

### Phase 1: Content Generation (Current)
- Generate post drafts based on themes
- Post to #social-media for approval
- Manual posting by owner after approval
- Track which posts were approved/edited

**Deliverables:**
- Post generation prompts
- Slack draft workflow
- Content calendar reminders

### Phase 2: Auto-Publishing
- LinkedIn API integration
- Auto-publish on approval reaction
- Retry logic for API failures
- Post confirmation messages

**Deliverables:**
- LinkedIn API module
- Publish queue with error handling
- Post URL tracking

### Phase 3: Engagement Tracking
- Fetch engagement metrics
- Weekly performance reports
- Content strategy optimization
- A/B testing for hooks

**Deliverables:**
- Engagement data fetching
- Weekly summary generation
- Performance insights

## Content Guidelines

### Topics to Cover
- AI in small business
- Self-taught programming
- Retail technology
- Pet industry trends
- Square developer ecosystem
- Founder mental health and ADHD
- Hamilton local business

### Topics to Avoid
- Political content
- Competitor criticism
- Unverified claims
- Sensitive customer data
- Confidential business metrics

### Compliance
- No fabricated quotes or stories
- Accurate technical claims
- Proper disclosure when needed
- Respect for customer privacy

## Key Principle

**Quality over quantity.** The Story Bot writes 3 high-quality posts per week maximum. Each post should feel like John wrote it himself because the bot knows his voice, his journey, and his values. If there's nothing worth saying, don't post.

## Security Considerations

- LinkedIn tokens stored in `.env`, never logged
- No direct access to customer data
- Approval workflow prevents unauthorized posting
- Rate limiting to prevent API abuse
- Token refresh handled securely
