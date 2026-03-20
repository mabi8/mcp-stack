# mcp-stack — Architecture Documentation

> **Last updated:** 2026-03-20 · **Repo:** `github.com/mabi8/mcp-stack` (private)
> **VPS:** `box.makkib.com` (Hetzner CPX22, 4 vCPU, 8 GB RAM, Ubuntu 24)

---

## Overview

mcp-stack is a monorepo containing MCP (Model Context Protocol) servers that connect Claude.ai to external services. Each MCP server exposes a set of tools that Claude can call during conversations.

Currently deployed:

| Service | Package | Tools | What It Connects To |
|---------|---------|-------|---------------------|
| **CenterDevice MCP** | `@mcp-stack/centerdevice` | 46 | CenterDevice document management system |
| **Bidrento MCP** | `@mcp-stack/bidrento` | 40 | Bidrento property management platform |

A shared core package (`@mcp-stack/core`) provides logging, caching, OAuth 2.1, tool registration helpers, and audit logging — used by both MCPs and available for future services.

A separate Telegram bot (`bcl-telegram-claude`, own repo) also runs on the same VPS but is not part of this monorepo.

---

## Repository Structure

```
mcp-stack/
├── packages/
│   ├── core/                         @mcp-stack/core (1,084 lines)
│   │   ├── src/
│   │   │   ├── logger.ts             Structured JSON logging (190 lines, zero deps)
│   │   │   ├── oauth.ts              OAuth 2.1 DCR+PKCE building blocks (435 lines)
│   │   │   ├── cache.ts              In-memory TTL cache (76 lines)
│   │   │   ├── tool-helpers.ts       One-liner MCP tool registration (136 lines)
│   │   │   ├── audit-logger.ts       Write-action audit trail (188 lines)
│   │   │   └── index.ts              Re-exports
│   │   ├── __tests__/                47 tests (logger, cache, oauth)
│   │   ├── package.json
│   │   └── tsconfig.json
│   │
│   ├── centerdevice/                 @mcp-stack/centerdevice (2,428 lines)
│   │   ├── src/
│   │   │   ├── client.ts             CenterDevice REST API client (1,298 lines)
│   │   │   ├── tools.ts              46 MCP tools (637 lines)
│   │   │   ├── audit-formatter.ts    CD-specific audit log formatting (90 lines)
│   │   │   └── index.ts              Server bootstrap + CD OAuth bridge (403 lines)
│   │   ├── package.json
│   │   └── tsconfig.json
│   │
│   └── bidrento/                     @mcp-stack/bidrento (687 lines)
│       ├── src/
│       │   ├── client.ts             Bidrento API client (native fetch, 155 lines)
│       │   ├── tools.ts              40 MCP tools (322 lines)
│       │   └── index.ts              Server bootstrap + grant page (210 lines)
│       ├── package.json
│       └── tsconfig.json
│
├── docs/
│   └── ARCHITECTURE.md               This file
│
├── deploy/
│   ├── nginx/
│   │   ├── box.makkib.com.conf       Main server block (TLS + includes)
│   │   └── mcp.d/
│   │       ├── centerdevice.conf      /mcp, /.well-known/, /oauth/ → :9443
│   │       ├── bidrento.conf          /bidrento/ → :9444
│   │       └── telegram.conf          /bclai/ → :3842
│   ├── systemd/
│   │   ├── mcp-centerdevice.service
│   │   └── mcp-bidrento.service
│   ├── migrate.sh                     One-time migration script (completed)
│   └── update.sh                      Ongoing deploy script
│
├── package.json                       npm workspaces root
├── package-lock.json
├── tsconfig.base.json                 Shared TypeScript config
└── vitest.config.ts                   Test runner config
```

---

## Network Architecture

```
Internet
  │
  ▼
HTTPS :443 ─── nginx (box.makkib.com) ─── TLS termination
  │                │
  │  ┌─────────────┼──────────────────────────────────┐
  │  │             │         include mcp.d/*.conf      │
  │  │             ▼                                   │
  │  │  /mcp, /oauth/, /.well-known/                   │
  │  │         │                                       │
  │  │         ▼                                       │
  │  │  :9443 (mcp-centerdevice)                       │
  │  │         │                                       │
  │  │         ▼                                       │
  │  │  CenterDevice API ── api.centerdevice.de/v2     │
  │  │         (OAuth 2.0, per-user tokens)            │
  │  │                                                 │
  │  │  /bidrento/                                     │
  │  │         │                                       │
  │  │         ▼                                       │
  │  │  :9444 (mcp-bidrento)                           │
  │  │         │                                       │
  │  │         ▼                                       │
  │  │  Bidrento API ── pro.bidrento.com               │
  │  │         (API key, X-API-TOKEN header)           │
  │  │                                                 │
  │  │  /bclai/                                        │
  │  │         │                                       │
  │  │         ▼                                       │
  │  │  :3842 (bcl-telegram-claude)                    │
  │  │         (separate repo, not in monorepo)        │
  │  └─────────────────────────────────────────────────┘
```

---

## Authentication

### Claude.ai → MCP Servers (OAuth 2.1 DCR + PKCE)

Both MCPs implement the OAuth 2.1 flow that Claude.ai uses to authenticate with remote MCP servers. The shared implementation lives in `@mcp-stack/core/oauth.ts`.

**Flow:**

1. Claude discovers the MCP via `/.well-known/oauth-authorization-server`
2. Claude registers dynamically via `POST /oauth/register` (DCR)
3. Claude redirects the user to `GET /oauth/authorize` with PKCE challenge
4. **CenterDevice MCP:** Redirects to CenterDevice login → user authenticates → callback with CD tokens → issues MCP code
5. **Bidrento MCP:** Shows a simple "Grant Access" page (shared API key, not per-user) → issues MCP code
6. Claude exchanges the code at `POST /oauth/token` for a bearer token
7. All subsequent `/mcp` requests use `Authorization: Bearer <token>`

**Session persistence:** Both services persist sessions to `.sessions.json` (mode 0600) via the shared `SessionStore`. Sessions survive service restarts. Token lifetime: 24 hours with refresh token rotation.

**Backward compatibility:** Old sessions from the pre-refactor `cd-mcp` may lack the `session.data` wrapper. The CenterDevice server detects this and falls back gracefully, prompting re-authentication if CD tokens are missing.

**Security:**
- Redirect URIs restricted to `claude.ai`, `claude.com`, `box.makkib.com`
- PKCE S256 challenge verification on all token exchanges
- HTML error pages use XSS-safe escaping
- Session files mode 0600, owned by service user

### MCP Servers → Upstream APIs

| MCP | Upstream Auth | Details |
|-----|--------------|---------|
| CenterDevice | OAuth 2.0 Bearer | Per-user tokens from CD login. Client ID `56ece2a8`. Auto-refresh on 401. |
| Bidrento | API Key | `X-API-TOKEN` header. Shared key in `.env`. POST bodies `application/x-www-form-urlencoded`. |

---

## Service Isolation

Each MCP runs as a separate Linux user with its own systemd unit:

| Service | User | Port | Home | systemd Unit |
|---------|------|------|------|-------------|
| CenterDevice MCP | `cdapi` | 9443 | `/home/cdapi/mcp-stack/` | `mcp-centerdevice.service` |
| Bidrento MCP | `bdroapi` | 9444 | `/home/bdroapi/mcp-stack/` | `mcp-bidrento.service` |
| Telegram Bot | `bclai` | 3842 | `/home/bclai/` | `bclai.service` |

Each user has their own clone of the monorepo, their own `.env`, their own `.sessions.json`, and their own TLS certs in `~/tls/`.

### Firewall

| Port | Rule | Why |
|------|------|-----|
| 443 | ACCEPT | nginx — all external HTTPS |
| 9443 | ACCEPT | CenterDevice OAuth callback hits directly |
| 9444 | DROP | Localhost only via nginx |
| 3842 | DROP | Localhost only via nginx |

---

## Shared Core (`@mcp-stack/core`)

The core package provides five modules that all MCP services share. It has zero runtime dependencies beyond Node.js built-ins (logger, cache, audit-logger) or Express types (OAuth).

### Logger

Structured JSON logging to stderr, captured by journald.

```typescript
import { createLogger } from "@mcp-stack/core";
const log = createLogger("mcp-centerdevice");

log.info("tool_call", { tool: "search_documents", duration_ms: 342 });
log.error("api_failure", { status: 401, path: "/documents" });
```

Output (one JSON object per line):
```json
{"ts":"2026-03-20T10:15:32.123Z","level":"info","service":"mcp-centerdevice","event":"tool_call","tool":"search_documents","duration_ms":342}
```

**Features:**
- Levels: `error | warn | info | debug | trace` (controlled by `LOG_LEVEL` env var)
- Child loggers: `log.child({ tool: "search" })` adds persistent fields
- Request ID propagation via `AsyncLocalStorage`
- Automatic secret redaction (tokens, keys, passwords — recursively in nested objects)
- Pretty-print in development (`NODE_ENV=development`)

### Cache

In-memory TTL cache with prefix invalidation. Used by the CenterDevice client to cache metadata, folder listings, and user info.

### Tool Helpers

Eliminates boilerplate from MCP tool handlers. One-liner registration with automatic try/catch, JSON serialization, timing, logging, `reason` parameter injection, and audit logging.

### Audit Logger

Buffers write operations in a local markdown file, then flushes to a configurable remote destination after 60 seconds of idle time or on graceful shutdown. The upload function is pluggable.

### OAuth

Composable building blocks for the OAuth 2.1 DCR+PKCE flow: `SessionStore`, `PendingCodeStore`, `ClientRegistry`, `createDiscoveryHandlers()`, `createDCRHandler()`, `createTokenHandler()`, `bearerAuth()`, `verifyPKCE()`.

---

## Nginx Configuration

Nginx uses an include-based pattern — one file per service:

```
/etc/nginx/sites-enabled/box.makkib.com    ← server block + TLS + include
/etc/nginx/mcp.d/
  centerdevice.conf                         ← /mcp, /.well-known/, /oauth/ → :9443
  bidrento.conf                             ← /bidrento/ → :9444
  telegram.conf                             ← /bclai/ → :3842
```

Adding a new MCP service = drop a `.conf` in `mcp.d/` and `systemctl reload nginx`.

---

## Logging & Monitoring

All services emit structured JSON logs to stderr, captured by systemd/journald.

```bash
# Real-time tool calls
journalctl -u mcp-centerdevice -f | jq 'select(.event=="tool_call")'

# Errors in the last hour
journalctl -u mcp-centerdevice --since "1 hour ago" | jq 'select(.level=="error")'

# Tool usage stats today
journalctl -u mcp-centerdevice --since today | jq -r 'select(.event=="tool_call") | .tool' | sort | uniq -c | sort -rn
```

| Level | Default | What Gets Logged |
|-------|---------|-----------------|
| `error` | Yes | API failures, auth failures, unhandled exceptions |
| `warn` | Yes | Token refresh, missing config, TLS issues, invalid sessions |
| `info` | Yes | Tool calls (name, duration), server start/stop, OAuth events |
| `debug` | No | Tool inputs, API request summaries, HTTP requests, cache hits |
| `trace` | No | Full API request/response bodies |

### Logs MCP Integration

The Logs MCP at `logs.makkib.com` queries journald. Service names need updating:

| Old Unit Name | New Unit Name |
|--------------|---------------|
| `cd-mcp` | `mcp-centerdevice` |
| `bidrento-mcp` | `mcp-bidrento` |
| `bclai` | `bclai` (unchanged) |

---

## CenterDevice MCP — 46 Tools

### Design Principle: Unified Tools

Batch and single-document operations are merged into unified tools that accept one-or-many. Claude always calls the same tool name regardless of how many items it operates on. Internally, the tool picks the most efficient CenterDevice API strategy.

**Collapsed pairs:**

| Old (separate tools) | New (unified) | Strategy |
|---------------------|---------------|----------|
| `rename_document` + `batch_rename_documents` | `rename_documents` | Parallel execution |
| `rename_folder` + `batch_rename_folders` | `rename_folders` | Parallel execution |
| `delete_document` + `batch_delete_documents` | `delete_documents` | Native bulk API (1 HTTP call) |
| `add_tags` + `batch_add_tags` | `add_tags` | Native bulk API (1 HTTP call) |
| `remove_tags` + `batch_remove_tags` | `remove_tags` | Native bulk API (1 HTTP call) |
| `share_document` + `batch_share_documents` | `share_documents` | Native bulk API (1 HTTP call) |
| `create_folder` + `batch_create_folders` | `create_folders` | Parallel execution |
| `add_documents_to_folder` + `batch_move_to_folders` | `move_to_folders` | Parallel execution |

Also removed: `list_trash` (redundant — `search_trash` with no params does the same thing).

### Tool Listing (46 tools)

| Category | Tools |
|----------|-------|
| **Search & Read** | `search_documents`, `get_document_metadata`, `list_documents`, `get_document_fulltext`, `find_and_read` |
| **Collections** | `get_collection`, `list_collections`, `create_collection`, `browse_collection` |
| **Folders** | `get_folder`, `list_folders`, `get_folder_contents`, `create_folders`, `rename_folders`, `move_folder`, `delete_folder` |
| **Document Ops** | `rename_documents`, `delete_documents`, `copy_document`, `move_documents`, `move_to_folders`, `remove_documents_from_folder`, `add_documents_to_collection`, `remove_documents_from_collection` |
| **Upload** | `upload_document`, `upload_text_document`, `upload_new_version`, `update_text_document` |
| **Tags** | `add_tags`, `remove_tags` |
| **Sharing** | `share_documents`, `unshare_document` |
| **Comments** | `get_comments`, `add_comment`, `delete_comment` |
| **Users** | `get_current_user`, `list_users` |
| **Workflows** | `list_workflows`, `get_workflow`, `create_workflow`, `respond_to_workflow`, `delete_workflow` |
| **PDF Ops** | `split_document`, `merge_documents` |
| **Trash** | `search_trash`, `restore_from_trash` |

### Write Tools & Audit Trail

All write operations are logged with timing and result status. Destructive operations (`move_documents`, `delete_documents`, `rename_documents`, `split_document`, `delete_folder`) require a `reason` parameter.

### CenterDevice API Quirks

| Quirk | Handling |
|-------|---------|
| `add_tags` / `remove_tags` returns 204 with empty body | Client treats 204 as success, no JSON parse |
| `rename_documents` creates a new version (v+1) per doc | Returns 201 for rename, 204 for no-op |
| DATEV locks files in Datev Upload folders | 403 on rename after move — always **rename → move → tag** |
| `move_to_folders` doesn't work across collections | Use `add_documents_to_collection` + `remove_documents_from_collection` |
| `copy_document` does NOT inherit tags | Apply tags separately with follow-up `add_tags` |
| `/` not allowed in folder names | Use `+` as substitute (tags can use `/`) |

---

## Bidrento MCP — 40 Tools

### Tool Listing (40 tools)

| Category | Tools |
|----------|-------|
| **Buildings** | `list_buildings` |
| **Units** | `list_rental_objects`, `list_rental_objects_by_building`, `check_objects_available`, `check_objects_available_for_building`, `report_event_for_rental_object` |
| **Tenants** | `list_tenants`, `check_tenant_email`, `check_email`, `add_tenant` |
| **Agreements** | `list_rental_agreements`, `get_rental_agreement`, `list_rental_agreements_by_object`, `update_rental_agreement`, `add_rental_agreement`, `terminate_rental_agreement` |
| **Price Changes** | `get_rental_agreement_price_changes`, `add_rental_agreement_price_change`, `update_rental_agreement_price_change` |
| **Invoices** | `list_invoices`, `create_invoice` |
| **Meters** | `list_meters`, `list_meters_by_rental_object`, `list_meter_types`, `list_meter_unit_types`, `add_meter_reading`, `add_meter_for_rental_object`, `add_meter_for_building` |
| **Listings** | `list_listings`, `list_listings_by_locale`, `get_listing_availability`, `list_listing_statuses`, `get_listing_status`, `get_listing_application_settings`, `get_listing_campaign_prices`, `apply_for_listings` |
| **Services** | `list_extra_services_by_building`, `list_extra_services_by_rental_agreement`, `add_service_request` |
| **Users** | `list_users` |

### Bidrento API Quirks

| Quirk | Handling |
|-------|---------|
| `list_invoices` returns 404 when no invoices exist | Client returns `[]` instead of throwing |
| POST bodies are `application/x-www-form-urlencoded` | Client converts all POST params to URL-encoded form |
| Buildings/units are read-only via API | Can only be created through Bidrento web UI |

---

## Operations

### Deploying Updates

```bash
sudo bash /home/cdapi/mcp-stack/deploy/update.sh all          # Both
sudo bash /home/cdapi/mcp-stack/deploy/update.sh centerdevice # CD only
sudo bash /home/cdapi/mcp-stack/deploy/update.sh bidrento     # BD only
```

### Checking Status

```bash
systemctl status mcp-centerdevice mcp-bidrento
curl -s https://box.makkib.com/health | jq .
curl -s https://box.makkib.com/bidrento/health | jq .
```

### Adding a New MCP Service

1. Create `packages/{service}/` with `client.ts`, `tools.ts`, `index.ts`
2. Add `package.json` depending on `@mcp-stack/core`
3. Create `deploy/nginx/mcp.d/{service}.conf`
4. Create `deploy/systemd/mcp-{service}.service`
5. On VPS: create system user, clone repo, copy TLS certs, install systemd unit
6. Drop nginx conf in `/etc/nginx/mcp.d/`, reload nginx
7. Connect in Claude.ai settings

### Troubleshooting

| Problem | Fix |
|---------|-----|
| Claude can't connect | `systemctl status mcp-centerdevice`, check nginx, iptables |
| OAuth loops | Service restarted mid-flow. Remove + re-add MCP in Claude settings |
| CenterDevice 401 | CD tokens expired. User re-authenticates via Claude |
| "Session missing CD tokens" | Old pre-refactor session. Auto-prompts re-auth |
| Bidrento errors | Check `BIDRENTO_API_KEY` in `.env` |
| Build fails | Build `packages/core` first, then the service package |

---

## Testing

47 tests across 3 suites:

| Suite | Tests | Covers |
|-------|-------|--------|
| `logger.test.ts` | 10 | JSON structure, level filtering, secret redaction (nested), child loggers, request ID |
| `cache.test.ts` | 10 | CRUD, TTL expiry, prefix invalidation, overwrite |
| `oauth.test.ts` | 27 | PKCE S256, redirect URI validation (suffix attack), session lifecycle, pending code store, client registry, XSS escaping |

```bash
npm test                               # Run all
npx vitest run --reporter=verbose      # Verbose
```

---

## Environment Variables

### Shared

| Variable | Default | Description |
|----------|---------|------------|
| `MCP_PORT` | per-service | Listen port |
| `LOG_LEVEL` | `info` | `error\|warn\|info\|debug\|trace` |
| `NODE_ENV` | `production` | `production\|development` |
| `TLS_CERT` | — | Path to TLS certificate |
| `TLS_KEY` | — | Path to TLS private key |
| `SERVER_ORIGIN` | — | External URL for OAuth redirects |

### CenterDevice

| Variable | Description |
|----------|------------|
| `CD_BASE_URL` | API base (default: `https://api.centerdevice.de/v2`) |
| `CD_AUTH_URL` | Auth base (default: `https://auth.centerdevice.de`) |
| `CD_CLIENT_ID` | OAuth client ID (`56ece2a8-dbb7-4614-96ea-0d0d98c45588`) |
| `CD_CLIENT_SECRET` | OAuth client secret |
| `CD_CALLBACK_URL` | OAuth callback (`https://box.makkib.com:9443/auth/callback`) |
| `AUDIT_COLLECTION` | CenterDevice collection for audit logs |
| `AUDIT_FOLDER` | CenterDevice folder for audit logs |

### Bidrento

| Variable | Description |
|----------|------------|
| `BIDRENTO_API_KEY` | API key for X-API-TOKEN header |
| `BIDRENTO_BASE_URL` | API base (default: `https://pro.bidrento.com`) |

---

## Version History

| Date | What |
|------|------|
| 2026-03-20 | **Monorepo migration.** cd-mcp + bidrento-mcp → mcp-stack. Shared core extracted. CD tools 55 → 46 (batch/single unified). `list_trash` removed. Session crash fix for old sessions. Bidrento: axios → fetch, session persistence. Nginx split. 47 tests. Structured JSON logging live. |
| 2026-03-19 | cd-mcp: 55 tools. Audit trail. Split/merge PDF. `update_text_document`. |
| 2026-03-16 | bidrento-mcp: 40 tools. OAuth 2.1 DCR+PKCE. |
| 2026-03-14 | cd-mcp: Initial deployment. 13 tools. |
