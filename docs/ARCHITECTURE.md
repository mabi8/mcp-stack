# mcp-stack — Architecture Documentation

> **Last updated:** 2026-03-21 · **Repo:** `github.com/mabi8/mcp-stack` (private)
> **Bastion:** `sss.makkib.com` (Hetzner, Ubuntu 24) — MCP gateway + SSH jump host
> **Worker:** `box.makkib.com` (Hetzner CPX22, 4 vCPU, 8 GB RAM, Ubuntu 24)

---

## Overview

mcp-stack is a monorepo containing MCP (Model Context Protocol) servers that connect Claude.ai to external services. Each MCP server exposes a set of tools that Claude can call during conversations.

Currently deployed:

| Service | Package | Tools | Runs On | What It Connects To |
|---------|---------|-------|---------|---------------------|
| **CenterDevice MCP** | `@mcp-stack/centerdevice` | 46 | box | CenterDevice document management system |
| **Bidrento MCP** | `@mcp-stack/bidrento` | 40 | box | Bidrento property management platform |
| **VPS Command MCP** | `@mcp-stack/vps-cmd` | 7 | sss | Worker VPS via SSH (tiered command execution) |

A shared core package (`@mcp-stack/core`) provides logging, caching, OAuth 2.1, tool registration helpers, and audit logging — used by all MCPs.

Additional services on box (separate repos, not in monorepo):
- **bcl-telegram-claude** — Telegram bot for BCL team (`@bclai_bot`)
- **log-mcp** — Journald log querying MCP (`logs.makkib.com`)

---

## Infrastructure Architecture

```
                    ┌────────────────────────────────────────────────┐
                    │              sss.makkib.com (bastion)          │
                    │                                                │
  Claude.ai ──HTTPS──▶ nginx :443                                   │
                    │     │                                          │
                    │     ▼                                          │
                    │  :9445 (mcp-vps-cmd)                           │
                    │     │  OAuth 2.1 + passphrase gate             │
                    │     │  Tier engine → command classification     │
                    │     │                                          │
  Markus ────SSH────▶ sshd (mb user)                                │
                    │     │                                          │
                    │     │──── SSH (ops user) ──────────────┐       │
                    │     │                                  │       │
                    └─────│──────────────────────────────────│───────┘
                          │                                  │
                          ▼                                  ▼
                    ┌────────────────────────────────────────────────┐
                    │              box.makkib.com (worker)           │
                    │                                                │
  Claude.ai ──HTTPS──▶ nginx :443                                   │
                    │     ├──▶ :9443 (mcp-centerdevice)              │
                    │     │      └──▶ api.centerdevice.de/v2         │
                    │     ├──▶ :9444 (mcp-bidrento)                  │
                    │     │      └──▶ pro.bidrento.com               │
                    │     ├──▶ :3842 (bcl-telegram-claude)           │
                    │     └──▶ :3850 (log-mcp)                       │
                    │                                                │
                    │  All services run as 'ops' user                │
                    │  SSH inbound: sss + Markus IP only             │
                    └────────────────────────────────────────────────┘
```

### Bastion Model (sss.makkib.com)

sss is the single point of entry for both human and AI operations. It runs:

1. **VPS Command MCP** (`mcp-vps-cmd`, port 9445) — the only MCP on this host
2. **SSH jump host** — Markus SSHes through sss to reach worker VPS
3. **Audit logger** — captures every command from both channels

Worker VPS (box, future hosts) accept SSH only from sss's IP. No direct SSH from the internet except sss.

### User Model

**sss.makkib.com:**
| User | Purpose |
|------|---------|
| `ops` | MCP execution + outbound SSH to workers |
| `mb` | Markus interactive SSH + sudo |
| `root` | System admin (key-only) |

**box.makkib.com:**
| User | Purpose |
|------|---------|
| `ops` | All services (mcp-centerdevice, mcp-bidrento, bcl-telegram, log-mcp) |
| `root` | System admin |

All services on box run as `ops` from `/home/ops/`. Service isolation comes from systemd (working directories, environment files), not from separate Unix users.

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
│   ├── bidrento/                     @mcp-stack/bidrento (687 lines)
│   │   ├── src/
│   │   │   ├── client.ts             Bidrento API client (native fetch, 155 lines)
│   │   │   ├── tools.ts              40 MCP tools (322 lines)
│   │   │   └── index.ts              Server bootstrap + grant page (210 lines)
│   │   ├── package.json
│   │   └── tsconfig.json
│   │
│   └── vps-cmd/                      @mcp-stack/vps-cmd (~1,900 lines)
│       ├── src/
│       │   ├── index.ts              Server bootstrap + passphrase-gated OAuth (364 lines)
│       │   ├── tools.ts              7 MCP tools (330 lines)
│       │   ├── tier-engine.ts        Command parser + permission classifier (280 lines)
│       │   ├── ssh-client.ts         SSH connection pool via ssh2 (180 lines)
│       │   ├── host-registry.ts      Host config loader (80 lines)
│       │   ├── approval-store.ts     Approval IDs + deploy locks (130 lines)
│       │   └── audit-formatter.ts    VPS-cmd specific audit formatting (40 lines)
│       ├── hosts.json                Registered hosts + allowlists
│       ├── .env.example
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
│   │       ├── telegram.conf          /bclai/ → :3842
│   │       └── vps-cmd.conf           /mcp (on sss) → :9445
│   ├── systemd/
│   │   ├── mcp-centerdevice.service   (box, ops user)
│   │   ├── mcp-bidrento.service       (box, ops user)
│   │   └── mcp-vps-cmd.service        (sss, ops user)
│   ├── sudoers.d/
│   │   └── ops                        Passwordless restart/status/journal for ops
│   ├── migrate.sh                     One-time migration script (completed)
│   └── update.sh                      Ongoing deploy script
│
├── package.json                       npm workspaces root
├── package-lock.json
├── tsconfig.base.json                 Shared TypeScript config
└── vitest.config.ts                   Test runner config
```

---

## Authentication

### Claude.ai → MCP Servers (OAuth 2.1 DCR + PKCE)

All MCPs implement the OAuth 2.1 flow that Claude.ai uses to authenticate with remote MCP servers. The shared implementation lives in `@mcp-stack/core/oauth.ts`.

**Flow:**

1. Claude discovers the MCP via `/.well-known/oauth-authorization-server`
2. Claude registers dynamically via `POST /oauth/register` (DCR)
3. Claude redirects the user to `GET /oauth/authorize` with PKCE challenge
4. **CenterDevice MCP:** Redirects to CenterDevice login → user authenticates → callback with CD tokens → issues MCP code
5. **Bidrento MCP:** Shows a simple "Grant Access" page (shared API key, not per-user) → issues MCP code
6. **VPS Command MCP:** Shows a passphrase login form → user enters `AUTH_PASSPHRASE` from `.env` → timing-safe comparison → issues MCP code
7. Claude exchanges the code at `POST /oauth/token` for a bearer token
8. All subsequent `/mcp` requests use `Authorization: Bearer <token>`

**Session persistence:** All services persist sessions to `.sessions.json` (mode 0600) via the shared `SessionStore`. Sessions survive service restarts.

**Security:**
- Redirect URIs restricted to `claude.ai`, `claude.com` (vps-cmd) or + `box.makkib.com` (centerdevice/bidrento)
- PKCE S256 challenge verification on all token exchanges
- VPS Command MCP: passphrase gate with timing-safe comparison, failed attempts logged with IP
- HTML error pages use XSS-safe escaping
- Session files mode 0600, owned by service user

### MCP Servers → Upstream APIs / Backends

| MCP | Backend | Auth Details |
|-----|---------|-------------|
| CenterDevice | CenterDevice API (`api.centerdevice.de/v2`) | OAuth 2.0 Bearer, per-user tokens from CD login. Client ID `56ece2a8`. Auto-refresh on 401. |
| Bidrento | Bidrento API (`pro.bidrento.com`) | API Key, `X-API-TOKEN` header. Shared key in `.env`. |
| VPS Command | Worker VPS via SSH | Ed25519 key from sss `ops` user. No upstream API. |

---

## Service Deployment

All services on box run as the `ops` user. VPS Command MCP runs on sss as `ops`.

| Service | Host | User | Port | Working Directory | systemd Unit |
|---------|------|------|------|-------------------|-------------|
| CenterDevice MCP | box | `ops` | 9443 | `/home/ops/mcp-stack/packages/centerdevice` | `mcp-centerdevice.service` |
| Bidrento MCP | box | `ops` | 9444 | `/home/ops/mcp-stack/packages/bidrento` | `mcp-bidrento.service` |
| VPS Command MCP | sss | `ops` | 9445 | `/home/ops/mcp-stack/packages/vps-cmd` | `mcp-vps-cmd.service` |
| Telegram Bot | box | `ops` | 3842 | `/home/ops/bcl-telegram-claude` | `bcl-telegram.service` |
| Log MCP | box | `ops` | 3850 | `/home/ops/log-mcp` | `log-mcp.service` |

TLS certs for box services: `/home/ops/tls/fullchain.pem` and `/home/ops/tls/privkey.pem`
TLS for sss: Let's Encrypt via certbot + nginx, auto-renewed.

### Firewall

Both VPS use iptables (v4 + v6, no ufw anywhere).

**sss.makkib.com (iptables v4):**
```
Chain INPUT (policy DROP)
1  ACCEPT  lo (loopback)
2  ACCEPT  state ESTABLISHED,RELATED
3  ACCEPT  tcp dpt:22    (SSH — open, bastion is the entry point)
4  ACCEPT  tcp dpt:80    (HTTP — certbot redirect)
5  ACCEPT  tcp dpt:443   (HTTPS — MCP endpoint)
6  DROP    all
```

**sss.makkib.com (ip6tables v6):**
```
Chain INPUT (policy DROP)
1  ACCEPT  lo (loopback)
2  ACCEPT  state ESTABLISHED,RELATED
3  ACCEPT  icmpv6         (required for IPv6 neighbor discovery / path MTU)
4  ACCEPT  tcp dpt:22
5  ACCEPT  tcp dpt:80
6  ACCEPT  tcp dpt:443
7  DROP    all
```

**box.makkib.com (iptables v4):**
```
Chain INPUT (policy DROP)
1  ACCEPT  tcp dpt:22 src 178.104.87.127  (SSH from sss ONLY)
2  ACCEPT  state ESTABLISHED,RELATED
3  ACCEPT  lo (loopback)
4  ACCEPT  tcp dpt:80    (HTTP — certbot redirect)
5  ACCEPT  tcp dpt:443   (HTTPS — nginx → all MCPs)
6  ACCEPT  tcp dpt:9443  (CenterDevice OAuth callback)
7  DROP    all
```

**box.makkib.com (ip6tables v6):**
```
Chain INPUT (policy DROP)
1  ACCEPT  lo (loopback)
2  ACCEPT  state ESTABLISHED,RELATED
3  ACCEPT  icmpv6
4  DROP    tcp dpt:22    (all IPv6 SSH blocked — sss connects via v4)
5  ACCEPT  tcp dpt:80
6  ACCEPT  tcp dpt:443
7  ACCEPT  tcp dpt:9443
8  DROP    all
```

**Hardening standard for all VPS (iptables, always v4+v6, no ufw):**
- Flush, allow loopback, allow established/related, allow icmpv6 (v6 only)
- Allow 22/80/443 (plus service-specific ports)
- DROP all else, save to `/etc/iptables/rules.v4` and `rules.v6`
- Always apply both v4 and v6 together

### SSH Hardening (sss)

```
PermitRootLogin prohibit-password
PasswordAuthentication no
PubkeyAuthentication yes
AuthenticationMethods publickey
MaxAuthTries 3
LogLevel VERBOSE
AllowUsers root ops mb
X11Forwarding no
Subsystem sftp /usr/lib/openssh/sftp-server -l VERBOSE
```

---

## VPS Command MCP — 7 Tools

The VPS Command MCP is fundamentally different from centerdevice/bidrento — it doesn't proxy to an upstream API. It executes commands on registered worker VPS via SSH, with a tiered permission system.

### Permission Tiers

| Tier | Behavior | Examples |
|------|----------|---------|
| **1 — Auto-execute** | Read-only, runs immediately | `systemctl status`, `journalctl`, `cat`, `ls`, `df`, `uptime`, `git log/status/diff`, `curl localhost` |
| **2 — Deploy-flow** | Returns approval_id, executes on `confirm_execution` | `git pull`, `npm install`, `npm run build`, `systemctl restart`, deploy scripts |
| **3 — Always ask** | Returns approval_id, always requires explicit approval | `rm`, `mv`, `chmod`, `iptables`, `systemctl stop/enable/disable`, file writes, anything unknown |

### Security Model

- **No shell interpretation:** Commands parsed into tokens, run via `execFile`. Shell metacharacters (`;`, `|`, `&`, `` ` ``, `$()`) rejected at parse time.
- **Host allowlists:** Each registered host defines whitelisted services, repos, readable paths, and blocked path patterns (`.env`, SSH keys, `/etc/shadow`).
- **Approval IDs:** Tier 2/3 commands return an ID valid for 5 minutes. A second `confirm_execution` call is needed to actually run the command.
- **Deploy locks:** One deploy per host at a time. Second caller gets "deploy in progress" error.
- **Rate limiting:** Max 10 commands per minute per session (configurable).
- **Passphrase gate:** OAuth authorize requires a passphrase from `.env`, timing-safe comparison.

### Tool Listing (7 tools)

| Tool | Tier | Description |
|------|------|-------------|
| `list_services` | 1 | List registered hosts and their whitelisted services |
| `check_service` | 1 | `systemctl status` + last 30 log lines |
| `run_command` | 1/2/3 | Execute any command, classified by tier engine |
| `read_file` | 1 | Read a file from whitelisted paths |
| `deploy_service` | 2 | Full deploy flow: git pull → build → restart |
| `write_file` | 3 | Write content to a file (always requires approval) |
| `confirm_execution` | — | Confirm a pending tier 2/3 approval |

### Host Registry (`hosts.json`)

```json
{
  "hosts": {
    "box": {
      "hostname": "box.makkib.com",
      "port": 22,
      "username": "ops",
      "services": ["mcp-centerdevice", "mcp-bidrento", "bcl-telegram", ...],
      "repos": { "mcp-stack": "/home/ops/mcp-stack", ... },
      "readablePaths": ["/home/ops/mcp-stack", "/etc/nginx/", ...],
      "blockedPaths": [".env", ".sessions.json", "id_rsa", ...],
      "deployScript": "/home/ops/mcp-stack/deploy/update.sh"
    }
  }
}
```

Adding a new worker VPS = add an entry to `hosts.json`, authorize sss's SSH key on the new host, and lock SSH to sss-only.

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

Buffers write operations in a local markdown file, then flushes to a configurable remote destination after 60 seconds of idle time or on graceful shutdown. The upload function is pluggable — CenterDevice MCP uploads to a CD collection, VPS Command MCP writes to local append-only files.

### OAuth

Composable building blocks for the OAuth 2.1 DCR+PKCE flow: `SessionStore`, `PendingCodeStore`, `ClientRegistry`, `createDiscoveryHandlers()`, `createDCRHandler()`, `createTokenHandler()`, `bearerAuth()`, `verifyPKCE()`, `escapeHtml()`.

---

## Nginx Configuration

### box.makkib.com

Nginx uses an include-based pattern — one file per service:

```
/etc/nginx/sites-enabled/box.makkib.com    ← server block + TLS + include
/etc/nginx/mcp.d/
  centerdevice.conf                         ← /mcp, /.well-known/, /oauth/ → :9443
  bidrento.conf                             ← /bidrento/ → :9444
  telegram.conf                             ← /bclai/ → :3842
```

Adding a new MCP service on box = drop a `.conf` in `mcp.d/` and `systemctl reload nginx`.

### sss.makkib.com

Single server block, includes location blocks directly from the repo:

```
/etc/nginx/sites-enabled/sss.makkib.com
  include /home/ops/mcp-stack/deploy/nginx/mcp.d/vps-cmd.conf
```

TLS via certbot with auto-renewal.

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

The Logs MCP at `logs.makkib.com` queries journald on box. Service names:

| Service | journald Unit |
|---------|--------------|
| CenterDevice MCP | `mcp-centerdevice` |
| Bidrento MCP | `mcp-bidrento` |
| Telegram Bot | `bcl-telegram` |
| Log MCP | `log-mcp` |

Note: VPS Command MCP runs on sss, not box — its logs are on sss's journald, not queryable from the Logs MCP.

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

**Via VPS Command MCP (preferred):**
Claude calls `deploy_service` → returns approval plan → Markus says "go" → Claude calls `confirm_execution` → deployed.

**Manual on box:**
```bash
sudo bash /home/ops/mcp-stack/deploy/update.sh all          # All services
sudo bash /home/ops/mcp-stack/deploy/update.sh centerdevice # CD only
sudo bash /home/ops/mcp-stack/deploy/update.sh bidrento     # BD only
sudo bash /home/ops/mcp-stack/deploy/update.sh vps-cmd      # VPS Command only (on sss)
```

**Manual on sss:**
```bash
sudo -u ops bash -c "cd /home/ops/mcp-stack && git pull && npm run build -w packages/core && npm run build -w packages/vps-cmd" && systemctl restart mcp-vps-cmd
```

### Checking Status

**Via VPS Command MCP:**
Claude calls `check_service` with host and service name.

**Manual:**
```bash
systemctl status mcp-centerdevice mcp-bidrento bcl-telegram log-mcp  # on box
systemctl status mcp-vps-cmd                                          # on sss
curl -s https://box.makkib.com/health | jq .
curl -s https://sss.makkib.com/health | jq .
```

### Adding a New MCP Service (on box)

1. Create `packages/{service}/` with `client.ts`, `tools.ts`, `index.ts`
2. Add `package.json` depending on `@mcp-stack/core`
3. Create `deploy/nginx/mcp.d/{service}.conf`
4. Create `deploy/systemd/mcp-{service}.service` (User=ops)
5. On box: build, copy systemd unit, copy nginx conf, reload
6. Add to `hosts.json` services list, `update.sh`, sudoers
7. Connect in Claude.ai settings

### Adding a New Worker VPS

1. Provision VPS (Hetzner preferred), set up DNS
2. Create `ops` user, authorize sss's SSH public key
3. Lock SSH to sss IP only (iptables v4+v6)
4. Install sudoers fragment from `deploy/sudoers.d/ops`
5. Add entry to `packages/vps-cmd/hosts.json`
6. Restart mcp-vps-cmd on sss

### Troubleshooting

| Problem | Fix |
|---------|-----|
| Claude can't connect to MCP | `systemctl status mcp-{service}`, check nginx, iptables |
| OAuth loops | Service restarted mid-flow. Remove + re-add MCP in Claude settings |
| CenterDevice 401 | CD tokens expired. User re-authenticates via Claude |
| "Session missing CD tokens" | Old pre-refactor session. Auto-prompts re-auth |
| Bidrento errors | Check `BIDRENTO_API_KEY` in `.env` |
| VPS Command "approval expired" | Re-issue the command, confirm within 5 minutes |
| VPS Command SSH timeout | Check sss→box connectivity: `sudo -u ops ssh ops@box.makkib.com hostname` |
| Build fails | Build `packages/core` first, then the service package |
| "MCP not configured" on vps-cmd | `AUTH_PASSPHRASE` not set in `.env` on sss |

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

### VPS Command

| Variable | Description |
|----------|------------|
| `SSH_KEY_PATH` | Path to SSH private key (default: `/home/ops/.ssh/id_ed25519`) |
| `AUTH_PASSPHRASE` | Passphrase for OAuth authorize gate (required) |
| `AUDIT_LOG_DIR` | Directory for append-only audit logs (default: `./logs`) |
| `RATE_LIMIT_PER_MIN` | Max commands per minute per session (default: `10`) |

---

## Version History

| Date | What |
|------|------|
| 2026-03-21 | **Bastion + VPS Command MCP.** sss.makkib.com provisioned as bastion host. `@mcp-stack/vps-cmd` (7 tools) — tiered SSH command execution with passphrase-gated OAuth. All box services migrated from per-user (`cdapi`, `bdroapi`, `bclai`, `logmcp`) to single `ops` user. SSH hardened on sss (VERBOSE logging, key-only, allowlisted users). |
| 2026-03-20 | **Monorepo migration.** cd-mcp + bidrento-mcp → mcp-stack. Shared core extracted. CD tools 55 → 46 (batch/single unified). `list_trash` removed. Session crash fix for old sessions. Bidrento: axios → fetch, session persistence. Nginx split. 47 tests. Structured JSON logging live. |
| 2026-03-19 | cd-mcp: 55 tools. Audit trail. Split/merge PDF. `update_text_document`. |
| 2026-03-16 | bidrento-mcp: 40 tools. OAuth 2.1 DCR+PKCE. |
| 2026-03-14 | cd-mcp: Initial deployment. 13 tools. |
