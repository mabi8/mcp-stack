# mcp-stack

Monorepo for MCP (Model Context Protocol) servers and shared infrastructure.

## Structure

```
packages/
  core/           @mcp-stack/core — Logger, OAuth 2.1, cache, tool helpers, audit
  centerdevice/   @mcp-stack/centerdevice — CenterDevice DMS (55 tools)
  bidrento/       @mcp-stack/bidrento — Bidrento property management (40 tools)

deploy/
  nginx/          Nginx config (main server block + per-service includes)
  systemd/        systemd unit files
```

## Quick Start

```bash
npm install
npm run build -w packages/core        # Build core first
npm test                               # Run all tests (47 tests)
```

## Documentation

- **[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)** — Full architecture reference: network layout, auth flows, tool listings, operations runbook.
- **[docs/ROADMAP.md](docs/ROADMAP.md)** — Known issues, planned work, completed milestones.

## Packages

### `@mcp-stack/core`

Shared infrastructure with zero external runtime dependencies (logger) or minimal deps (OAuth uses Express types):

| Module | Purpose |
|--------|---------|
| `logger` | Structured JSON logging. Levels, child loggers, request ID correlation, secret redaction. |
| `oauth` | OAuth 2.1 DCR+PKCE building blocks: SessionStore, PendingCodeStore, ClientRegistry, bearer middleware. |
| `cache` | In-memory TTL cache with prefix invalidation. |
| `tool-helpers` | `createToolRegistrar()` — one-liner MCP tool registration with auto error handling, timing, audit. |
| `audit-logger` | Write-action audit trail. Buffers locally, flushes via pluggable upload function. |

### `@mcp-stack/centerdevice`

55 MCP tools for CenterDevice document management. Search, read, upload, rename, move, tag, split/merge PDF, workflows, batch operations.

### `@mcp-stack/bidrento`

40 MCP tools for Bidrento property management. Buildings, units, tenants, agreements, invoices, meters, service requests, listings.

## Deploy

Each service runs as a systemd unit behind nginx on a single VPS:

```
HTTPS :443 → nginx
  /mcp        → :9443 (centerdevice)
  /bidrento/  → :9444 (bidrento)
```

Nginx uses `include /etc/nginx/mcp.d/*.conf` — adding a new MCP is one config file + reload.

## Logging

All services use `@mcp-stack/core` logger. JSON on stderr, captured by journald:

```bash
journalctl -u mcp-centerdevice -f | jq 'select(.event=="tool_call")'
```

Control verbosity via `LOG_LEVEL` env var: `error | warn | info | debug | trace`

## Tests

```bash
npm test                    # All tests
npx vitest run --reporter=verbose  # Verbose output
```
