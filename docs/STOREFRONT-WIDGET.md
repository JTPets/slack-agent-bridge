# Storefront Chat Widget

The Storefront Chat Widget is a customer-facing AI chat interface for JT Pets. It provides product inquiries, pet nutrition consultations, and order assistance through an embeddable widget.

## Architecture

```
                    ┌─────────────────┐
                    │   Customer's    │
                    │    Browser      │
                    └────────┬────────┘
                             │
                             ▼
┌────────────────────────────────────────────────┐
│              bots/storefront.js                │
│  ┌──────────────┐  ┌──────────────────────┐   │
│  │ GET /widget  │  │ POST /api/chat       │   │
│  │ (serve HTML) │  │ (process messages)   │   │
│  └──────────────┘  └──────────┬───────────┘   │
│                               │               │
│                               ▼               │
│                    ┌──────────────────┐       │
│                    │ lib/llm-runner   │       │
│                    │ (Claude CLI)     │       │
│                    └──────────────────┘       │
│                               │               │
│                               ▼               │
│                    ┌──────────────────┐       │
│                    │ Slack #store-    │       │
│                    │ inbox logging    │       │
│                    └──────────────────┘       │
└────────────────────────────────────────────────┘
```

## Components

### Express Server (`bots/storefront.js`)

The Express server provides two main endpoints:

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/widget` | GET | Serves the embeddable chat widget HTML |
| `/api/chat` | POST | Processes chat messages and returns AI responses |
| `/health` | GET | Health check endpoint |

### Chat Widget (`public/widget.html`)

A self-contained, mobile-responsive chat widget that:
- Floats in the bottom-right corner
- Maintains conversation history via session storage
- Handles typing indicators and loading states
- Works across all modern browsers

## Configuration

### Environment Variables

| Variable | Description | Default |
|----------|-------------|---------|
| `STOREFRONT_PORT` | Port for the Express server | `3001` |
| `STORE_INBOX_CHANNEL_ID` | Slack channel for conversation logs | `C0APPBSAP4H` |
| `STOREFRONT_ALLOWED_ORIGINS` | Comma-separated allowed CORS origins | `http://localhost:3000,https://jtpets.ca` |
| `STOREFRONT_SESSION_TTL_MS` | Session expiry time in ms | `3600000` (1 hour) |
| `SLACK_BOT_TOKEN` | Slack bot token for logging | Required for logging |

## Running the Server

> **Corrected 2026-09-14.** This section used to give `pm2 start/logs/restart`
> commands. **There is no PM2 anywhere in this deployment** — the `jt-agent`
> container has no process manager and `pm2` is not on its PATH (`CLAUDE.md` →
> Tech Stack). Following those commands produced `pm2: not found`, which reads as
> a broken machine rather than a stale document. SqTools, at the read-only `/repo`
> mount, *is* PM2-managed; that is a different stack and a different repository.
>
> **Unverified: how, or whether, this server is deployed at all.** `bots/storefront.js`
> is an entry point (`docs/WIRING-AND-SEAMS.md` §1) but the `jt-agent` container's
> `command:` starts only `node bridge-agent.js`, and no compose service, cron entry or
> npm script in this repository starts the storefront. Regenerate that claim:
> `grep -rn "storefront" --include=*.json --include=*.yml . | grep -v node_modules`.
> On the NAS: `grep -n storefront /share/CACHEDEV1_DATA/jt-agent/docker-compose.yml`
> and `crontab -l`. Until that is answered, only the direct command below is known
> to work.

### Development

```bash
node bots/storefront.js
```

### Production

Run it the way every other process in this deployment runs: as a container command
under `restart: unless-stopped`, or from the host. There is no supervisor inside the
image.

```bash
node bots/storefront.js

# Logs, if it runs inside the jt-agent container:
docker compose logs -f jt-agent
```

## Embedding the Widget

### Option 1: Iframe Embed

The simplest way to embed the widget on any website:

```html
<iframe
    src="https://your-server.com/widget"
    style="position: fixed; bottom: 0; right: 0; width: 420px; height: 600px; border: none; z-index: 9999;"
    allow="clipboard-write"
></iframe>
```

### Option 2: Direct Script Embed

For more control, copy the widget HTML contents directly into your page:

```html
<!-- Add this to your page's <head> -->
<script>
    // Configure API endpoint before widget loads
    window.JTPETS_CHAT_API_URL = 'https://your-server.com/api/chat';
</script>

<!-- Include widget HTML/CSS/JS from public/widget.html -->
```

### Option 3: Cloudflare Tunnel

If running on a local server (like Raspberry Pi), use Cloudflare Tunnel:

```bash
# Install cloudflared
# Then run:
cloudflared tunnel --url http://localhost:3001
```

## API Reference

### POST /api/chat

Send a message to the storefront agent.

**Request:**
```json
{
    "message": "What food do you recommend for senior dogs?",
    "sessionId": "optional-session-uuid"
}
```

**Response:**
```json
{
    "response": "For senior dogs, I'd recommend our premium senior formula...",
    "sessionId": "abc12345-1234-5678-abcd-123456789012"
}
```

**Error Response:**
```json
{
    "error": "Message is required",
    "code": "INVALID_MESSAGE"
}
```

### Error Codes

| Code | HTTP Status | Description |
|------|-------------|-------------|
| `INVALID_MESSAGE` | 400 | Message is empty or invalid |
| `RATE_LIMITED` | 429 | API rate limit reached |
| `INTERNAL_ERROR` | 500 | Server error |
| `UNEXPECTED_ERROR` | 500 | Unhandled exception |

## Session Management

- Sessions are stored in-memory on the server
- Each session has a 1-hour TTL (configurable via `STOREFRONT_SESSION_TTL_MS`)
- Sessions include up to 10 messages of conversation history for context
- Client-side session ID is stored in localStorage for persistence across page reloads

## Slack Integration

All conversations are logged to the `#store-inbox` Slack channel:

```
*Chat Session abc12345*
> *Customer:* What food is best for puppies?
> *Agent:* For puppies, I recommend our premium puppy formula...
```

This allows staff to:
- Monitor customer inquiries in real-time
- Identify common questions for FAQ development
- Follow up on complex inquiries manually

## Security Considerations

- All user input is sanitized before processing
- Messages are limited to 2000 characters
- CORS is configured to only allow specified origins
- Session IDs are UUIDs, not predictable sequences
- No customer PII is stored permanently

## Customization

### Styling

The widget uses CSS custom properties for easy theming:

```css
:root {
    --primary-color: #2563eb;      /* Main brand color */
    --primary-hover: #1d4ed8;      /* Hover state */
    --bg-color: #ffffff;           /* Background */
    --text-color: #1f2937;         /* Text */
    --user-bubble: #2563eb;        /* User message bubble */
    --agent-bubble: #f3f4f6;       /* Agent message bubble */
}
```

### Agent Personality

The storefront agent's personality is configured in `bots/storefront.js`:

```javascript
const STOREFRONT_AGENT_CONFIG = {
    name: 'Storefront Agent',
    systemPrompt: `You are the Storefront Agent for JT Pets...`,
    maxTurns: 15,
};
```

## Troubleshooting

### Widget not loading
- Check CORS configuration in `STOREFRONT_ALLOWED_ORIGINS`
- Verify the server is running on the correct port
- Check browser console for errors

### No responses from agent
- Verify Claude CLI is installed and configured
- Check the process's own output for errors (`docker compose logs -f jt-agent` if it runs in the container)
- Ensure `SLACK_BOT_TOKEN` is set (required for some functionality)

### Slack logging not working
- Verify `SLACK_BOT_TOKEN` is set
- Confirm bot has access to `STORE_INBOX_CHANNEL_ID`
- Check for Slack API errors in server logs
