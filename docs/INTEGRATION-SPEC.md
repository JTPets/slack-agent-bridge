# SqTools Integration Specification

This document defines the integration interface between bridge-agent (Slack polling agent) and SqTools (Square Dashboard Tool) running on the same Raspberry Pi.

---

## Overview

Both applications run on the same Pi:
- **bridge-agent**: Slack polling agent that executes tasks via Claude Code CLI
- **SqTools**: Square dashboard providing business data via REST API

The bridge-agent queries SqTools for business metrics to include in morning digests, accountability checks, and on-demand reports.

---

## Security

### Authentication

| Requirement | Details |
|-------------|---------|
| **API Key Required** | All SqTools API endpoints MUST require API key authentication |
| **Header Format** | `X-API-Key: <api-key>` |
| **Key Generation** | Generate one API key per client (one for bridge-agent, one for future bots) |
| **Key Storage** | API keys stored in `.env` files only, never in code or committed files |
| **Key Validation** | SqTools validates API key against a local allowlist file (not hardcoded in code) |

### Rate Limiting

| Limit | Value |
|-------|-------|
| **Requests per minute** | 60 per API key |
| **Enforcement** | SqTools rejects requests exceeding limit with HTTP 429 |
| **Reset** | Rolling window, not fixed minute boundaries |

### Access Control

| Control | Policy |
|---------|--------|
| **Read-only endpoints** | All external API access is read-only by default |
| **Write access** | No write access from external agents without explicit approval flow |
| **Approval flow** | TBD - may involve Slack confirmation or separate admin API |

### Network Security

| Control | Configuration |
|---------|---------------|
| **CORS** | Reject all origins except `localhost` (both apps run on same Pi) |
| **IP Allowlist** | Only `127.0.0.1` by default (both apps on same Pi) |
| **External access** | Explicitly denied unless allowlist is expanded |

### Logging

| Requirement | Details |
|-------------|---------|
| **Request logging** | Log all API requests with timestamp, endpoint, and key identifier |
| **Key identifier** | Log a hash or prefix of the key (e.g., first 8 chars), NEVER the full key |
| **Response logging** | Log response status codes, NOT response bodies |
| **Retention** | Follow standard log rotation policies |

### Response Sanitization

All API responses MUST be sanitized:
- ❌ No stack traces in error responses
- ❌ No internal file paths
- ❌ No database connection details
- ❌ No environment variable values
- ✅ Generic error messages with error codes
- ✅ Request ID for debugging (correlates to server logs)

**Example error response:**
```json
{
  "error": "Invalid request",
  "code": "ERR_INVALID_REQUEST",
  "request_id": "abc123"
}
```

### Security Model

> **Both repos are public/open source. Assume attackers can read the code.**

Security is achieved through:
- ✅ Authentication (API keys)
- ✅ Authorization (per-key permissions, read-only default)
- ✅ Network controls (IP allowlist, localhost only)
- ✅ Rate limiting
- ❌ NOT security through obscurity

---

## API Endpoints (Planned)

*To be defined as integration develops. All endpoints will follow the security requirements above.*

| Endpoint | Method | Description | Auth Required |
|----------|--------|-------------|---------------|
| `/api/health` | GET | Health check | No |
| `/api/v1/metrics/daily` | GET | Daily business metrics | Yes |
| `/api/v1/metrics/weekly` | GET | Weekly summary | Yes |
| `/api/v1/inventory/low-stock` | GET | Low stock alerts | Yes |

---

## Environment Variables

### bridge-agent (client)

| Variable | Description |
|----------|-------------|
| `SQTOOLS_API_KEY` | API key for authenticating with SqTools |
| `SQTOOLS_BASE_URL` | SqTools API base URL (default: `http://127.0.0.1:3000`) |

### SqTools (server)

| Variable | Description |
|----------|-------------|
| `API_KEY_ALLOWLIST_PATH` | Path to file containing valid API keys (one per line) |
| `RATE_LIMIT_RPM` | Requests per minute limit (default: 60) |
| `ALLOWED_IPS` | Comma-separated IP allowlist (default: `127.0.0.1`) |

---

## Implementation Checklist

### SqTools (Server Side)
- [ ] Add API key middleware validating `X-API-Key` header
- [ ] Create allowlist file loader (not hardcoded keys)
- [ ] Implement rate limiting (60 req/min per key)
- [ ] Configure CORS to reject non-localhost origins
- [ ] Add IP allowlist middleware
- [ ] Sanitize all error responses
- [ ] Add request logging with key identifier (not full key)

### bridge-agent (Client Side)
- [ ] Add `SQTOOLS_API_KEY` to `.env` handling
- [ ] Add SqTools client module with API key header
- [ ] Handle 401/403/429 responses gracefully
- [ ] Add SqTools integration to morning digest (optional)

---

## Revision History

| Date | Change |
|------|--------|
| 2026-03-26 | Initial security specification |
