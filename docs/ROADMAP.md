# mcp-stack — Roadmap

> **Last updated:** 2026-03-22

---

## Known Issues

### ClientRegistry not persisted across restarts
**Severity:** Medium · **Affects:** All MCPs (core)

`ClientRegistry` in `@mcp-stack/core/oauth.ts` stores DCR registrations in an in-memory `Map()`. When a service restarts, all registered `client_id`s vanish. Active sessions survive (persisted in `.sessions.json`), but token refresh fails because the `client_id` can no longer be validated. Every connected user must re-authenticate after a restart.

**Fix:** Add file persistence to `ClientRegistry` (same pattern as `SessionStore` — JSON file, mode 0600, load on startup).

### Bidrento grant page captures no user identity
**Severity:** Low · **Affects:** Bidrento MCP

The "Grant Access" page issues an MCP session without recording who clicked the button. With multiple team members connecting, there's no audit trail of which person performed which action. CenterDevice doesn't have this problem (each user logs into CD with their own account).

**Fix:** Add a name/email field to the grant form, store in `session.data`, surface in logs.

---

## Planned

### Dockerize services
**Priority:** Medium

Replace the current bare-metal systemd deployment with Docker containers. Goals:
- Reproducible builds (no more `npm install` on prod VPS)
- Easier horizontal scaling if needed
- Cleaner isolation between services (currently all run as `ops`)
- Simpler onboarding for new services (Dockerfile + compose entry vs. systemd unit + sudoers + nginx conf)

Likely approach: `docker compose` on box with per-service containers, nginx as reverse proxy (either containerized or host-level). TLS termination stays at nginx.

### Grafana MCP server
**Priority:** Medium

Connect `grafana/mcp-grafana` to query Loki logs and Prometheus metrics conversationally via Claude. Infrastructure (Grafana Cloud + Alloy agents) already deployed on box + sss.

### VPS Command: per-user identity
**Priority:** Low

Add a username field to the passphrase login form. Store in `session.data` so audit logs show who ran each command, not just the client IP.

---

## Completed

| Date | Item |
|------|------|
| 2026-03-22 | VPS Command: Docker host support (`hostType: "docker"`, compose tier classification, bcl-vps1 registered) |
| 2026-03-21 | Grafana Cloud monitoring (Alloy agents on box + sss, log-mcp decommissioned) |
| 2026-03-21 | Service health endpoints (cached upstream probes, 200/503 structured JSON) |
| 2026-03-21 | Bastion model + VPS Command MCP (sss, tiered SSH, passphrase-gated OAuth) |
| 2026-03-20 | Monorepo migration (cd-mcp + bidrento-mcp → mcp-stack, shared core, 47 tests) |
| 2026-03-19 | CenterDevice audit trail, split/merge PDF, `update_text_document` |
| 2026-03-16 | Bidrento MCP: 40 tools, OAuth 2.1 DCR+PKCE |
| 2026-03-14 | CenterDevice MCP: initial deployment, 13 tools |
