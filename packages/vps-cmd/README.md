# @mcp-stack/vps-cmd

> **Package:** `@mcp-stack/vps-cmd` · **Port:** 9445 · **Host:** `sss.makkib.com` (bastion)
> **MCP endpoint:** `https://sss.makkib.com/vps/mcp`

---

## Overview

VPS Command MCP is a secure remote command execution server that runs on the bastion host (`sss.makkib.com`) and SSHes into registered worker VPS nodes. Every command is parsed, classified into a permission tier, and either executed immediately or held for explicit approval before running.

Unlike the other MCP packages (CenterDevice, Bidrento) which bridge to upstream REST APIs, vps-cmd has no upstream service. It _is_ the service — security comes from SSH keys, the tier engine, and host-level allowlists rather than OAuth scoping to a third-party API.

---

## Architecture

```
Claude.ai
  │
  ▼  MCP over HTTPS (OAuth 2.1 DCR+PKCE)
┌──────────────────────────────────────┐
│  sss.makkib.com (bastion)            │
│  nginx :443 → /vps/* → :9445        │
│                                      │
│  ┌────────────────────────────────┐  │
│  │  mcp-vps-cmd                   │  │
│  │  ┌──────────┐  ┌───────────┐  │  │
│  │  │ Tier     │  │ Approval  │  │  │
│  │  │ Engine   │  │ Store     │  │  │
│  │  └────┬─────┘  └─────┬─────┘  │  │
│  │       │              │         │  │
│  │  ┌────▼──────────────▼──────┐  │  │
│  │  │ SSH Pool                 │  │  │
│  │  │ (pooled, keyed, exec)    │  │  │
│  │  └──────────┬───────────────┘  │  │
│  └─────────────┼──────────────────┘  │
└────────────────┼─────────────────────┘
                 │ SSH (ed25519 key)
                 ▼
         ┌───────────────┐
         │ box.makkib.com│  (worker VPS)
         │ user: ops     │
         └───────────────┘
```

**Key constraint:** The bastion host only holds the SSH private key. Worker VPS nodes only accept SSH from the bastion. Commands run as the configured user (`ops`) on each target host — never as root directly.

---

## Package Structure

```
packages/vps-cmd/
├── src/
│   ├── index.ts              Server bootstrap, OAuth flow, Express app (~340 lines)
│   ├── tools.ts              7 MCP tools: run_command, check_service, deploy_service, etc. (~430 lines)
│   ├── tier-engine.ts        Command parser + permission classifier (~410 lines)
│   ├── ssh-client.ts         SSH connection pool with exec (~200 lines)
│   ├── host-registry.ts      Host config loader from hosts.json (~90 lines)
│   ├── approval-store.ts     In-memory approval IDs with TTL + deploy locks (~140 lines)
│   └── audit-formatter.ts    VPS-specific audit log formatting (~40 lines)
├── hosts.json                Host definitions (SSH targets, allowlists, blocked paths)
├── package.json
└── tsconfig.json
```

---

## Tools

| Tool | Tier | Description |
|------|------|-------------|
| `run_command` | 1/2/3 | Execute a command on a registered host. Tier depends on what the command is. |
| `check_service` | 1 | `systemctl status` + last 30 journal lines for a whitelisted service. |
| `deploy_service` | 2 | Full deploy flow via `update.sh` — git pull, build, restart. |
| `confirm_execution` | — | Confirm a pending tier 2/3 approval. Executes the held command(s). |
| `list_services` | 1 | List registered hosts and their whitelisted services. |
| `read_file` | 1 | Read a file from whitelisted paths. Blocked paths (secrets, keys, `.env`) rejected. |
| `write_file` | 3 | Write content to a file. Always requires approval. Uses base64 pipe to avoid escaping. |

All write tools (`run_command`, `deploy_service`, `confirm_execution`, `write_file`) accept an optional `reason` parameter that flows into the audit log.

---

## Tier Engine

The tier engine is the security core. Every raw command string goes through a four-step pipeline before anything touches SSH:

### Step 1 — Shell metacharacter rejection

Commands containing `;`, `|`, `&`, `` ` ``, `$()`, `{}`, `<>`, `!`, newlines, or dangerous patterns (`eval`, `exec`, `source`, heredocs) are rejected outright. Commands run via SSH `exec` (no shell), so metacharacters would either fail silently or indicate injection attempts.

### Step 2 — Tokenization

A simple tokenizer splits on whitespace, handles single/double quotes, but does not interpret shell grammar. The first token becomes the executable, the rest are args.

### Step 3 — Tier classification

Each command is matched against three rule sets in order:

**Tier 1 — Read-only, auto-execute:**

| Command | Constraints |
|---------|-------------|
| `journalctl` | Must have `-u <service>` (service in allowlist), `--no-pager`, max 500 lines |
| `systemctl status` | Service must be in host allowlist |
| `git log/status/diff/branch/show` | Must use `-C <path>`, path in repo allowlist |
| `cat` | Path must be in `readablePaths`, not match `blockedPaths` |
| `ls`, `df`, `free`, `uptime`, `whoami`, `hostname`, `date`, `wc`, `du` | Unrestricted |
| `head`, `tail` | Path must not match blocked patterns |
| `curl` | Only `localhost` / `127.0.0.1` URLs |
| `docker ps/logs/inspect/stats` | Read-only docker subcommands only |
| `npm test`, `npm run --dry-run` | Read-only npm subcommands only |

**Tier 2 — Deploy-flow, requires approval:**

`git pull` (in whitelisted repo), `npm install`, `npm ci`, `npm run build`, `systemctl restart <service>` (service in allowlist), `bash <deployScript>`.

**Tier 3 — Destructive, always requires approval:**

`rm`, `rmdir`, `mv`, `chmod`, `chown`, `iptables`, `ip6tables`, `systemctl stop/enable/disable/mask`, `sed`, `awk`, `tee`, `dd`, `useradd`, `userdel`, `reboot`, `shutdown`, `kill`, `killall`, `pkill`, `crontab`, `mount`, `umount`, `passwd`, `nano`, `vim`.

### Step 4 — Default

Any command not matched by tier 1 or tier 2 rules, and not in the tier 3 blocklist, is classified as **tier 3** (requires explicit approval). Unknown commands are never auto-executed.

---

## Approval Flow

Tier 2 and tier 3 commands are not executed immediately. Instead:

1. `run_command` (or `deploy_service`, `write_file`) classifies the command and returns an `approval_id` with a human-readable explanation of what will happen and why it needs approval.
2. Claude presents this to the user and asks for confirmation.
3. The user confirms, and Claude calls `confirm_execution` with the `approval_id`.
4. The approval store validates the ID (not expired, not already consumed) and executes the command(s).

Approvals expire after **5 minutes**. Each approval is single-use — consumed on confirmation and deleted.

### Deploy locks

`deploy_service` acquires a per-host deploy lock before execution. Only one deploy can run per host at a time. Locks auto-expire after 10 minutes (safety net for crashed deploys). If a deploy is already running, `deploy_service` returns the lock details (what's running, how long) instead of queuing.

---

## Host Registry

Hosts are defined in `hosts.json`. Each host specifies:

```jsonc
{
  "box": {
    "hostname": "box.makkib.com",   // SSH target
    "port": 22,
    "username": "ops",              // SSH user on the remote host
    "services": [                   // Whitelisted systemd services
      "mcp-centerdevice", "mcp-bidrento", "bcl-telegram",
      "bcl-wa-bot", "log-mcp", "mcp-vps-cmd"
    ],
    "repos": {                      // Whitelisted git repo paths
      "mcp-stack": "/home/ops/mcp-stack",
      "bcl-telegram-claude": "/home/ops/bcl-telegram-claude",
      "log-mcp": "/home/ops/log-mcp"
    },
    "readablePaths": [              // Allowed for cat/read_file
      "/home/ops/mcp-stack", "/etc/nginx/sites-enabled/",
      "/etc/systemd/system/", "/var/log/"
    ],
    "blockedPaths": [               // Substring match → always rejected
      ".env", ".sessions.json", "/root", "/etc/shadow",
      "/etc/ssh/ssh_host_", "id_rsa", "id_ed25519", ".gnupg"
    ],
    "deployScript": "/home/ops/mcp-stack/deploy/update.sh"
  }
}
```

The tier engine validates every command against these allowlists. A `journalctl -u nginx` call would be rejected because `nginx` is not in the `services` array. A `cat /home/ops/.env` would be rejected because `.env` matches `blockedPaths`.

---

## SSH Pool

The SSH client maintains a connection pool keyed by host alias. Connections are reused across requests and cleaned up after 5 minutes of idle. Key properties:

- **One SSH key** at `/home/ops/.ssh/id_ed25519` on the bastion.
- **No shell interpretation** — commands go through SSH `exec`, not `sh -c`. The tier engine's metacharacter rejection makes this safe.
- **Output truncation** — stdout capped at 100 KB, stderr at 50 KB.
- **Timeouts** — 30s default, 120s for tier 2 deploy commands, 10s for health checks.
- **Sudo** — tier 2 commands that need it (`systemctl restart`, deploy scripts) are automatically prefixed with `sudo`.

---

## Logging

Three layers, each capturing different things:

### 1. Structured application log (journald)

Every tool call is logged automatically via `createToolRegistrar` from `@mcp-stack/core`:

| Event | Level | Content |
|-------|-------|---------|
| `tool_input` | debug | Full params for every tool invocation |
| `tool_call` | info | Duration, result size (on success) |
| `tool_error` | error | Error message, duration (on failure) |
| `http_request` | debug | Method + path for every HTTP request |
| `ssh_connected` | info | Host alias + hostname on new SSH connection |
| `ssh_closed` | debug | Host alias on connection close |

All structured JSON on stderr, captured by journald:

```bash
journalctl -u mcp-vps-cmd -f | jq 'select(.event=="tool_call")'
```

### 2. Audit log (markdown files)

Write tools (`run_command`, `deploy_service`, `confirm_execution`, `write_file`) get an additional audit trail via `AuditLogger`. Each entry records:

```
- 14:30 | run_command | [box] `systemctl restart mcp-centerdevice` | ✅ (2340ms) | Deploy after config fix
```

Format: `time | tool | [host] command | status (duration) | reason`

The audit buffer flushes after 60 seconds of idle or on shutdown. Files are written to `logs/archive/` with names like `mcp-vps-cmd_Log_2026-03-21_1430_claude-session.md`. Unlike CenterDevice MCP (which flushes audit logs to CenterDevice itself), vps-cmd keeps audit logs local on the bastion — append-only files on disk.

### 3. Tier classification reason

Every classified command carries a `reason` string explaining the classification decision. This flows into both the audit log and the tool response back to Claude, so the user always sees _why_ a command needs approval (or doesn't).

---

## Authentication

OAuth 2.1 DCR+PKCE, but simplified since there's no upstream service to bridge:

1. Claude.ai initiates DCR → server registers client.
2. Claude.ai redirects to `/oauth/authorize` → user sees a passphrase form.
3. User enters `AUTH_PASSPHRASE` (set in `.env`) → timing-safe comparison.
4. On success, server issues an authorization code → Claude exchanges for a bearer token.
5. All `/mcp` requests carry the bearer token → `bearerAuth` middleware validates.

The passphrase is a shared secret — simple but sufficient since the real security boundary is the tier engine + SSH key, not the OAuth token.

---

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `MCP_PORT` | `9445` | Express listen port |
| `TLS_CERT` | — | Path to TLS certificate (optional, nginx terminates TLS in production) |
| `TLS_KEY` | — | Path to TLS private key |
| `SERVER_ORIGIN` | `https://sss.makkib.com` | Public origin for OAuth discovery |
| `SSH_KEY_PATH` | `/home/ops/.ssh/id_ed25519` | Path to SSH private key on the bastion |
| `AUDIT_LOG_DIR` | `./logs` | Directory for audit log buffer and archive |
| `RATE_LIMIT_PER_MIN` | `10` | Max commands per minute per host |
| `AUTH_PASSPHRASE` | — | **Required.** Passphrase for OAuth authorize form |
| `LOG_LEVEL` | `info` | `error`, `warn`, `info`, `debug`, `trace` |

---

## Deployment

### systemd

```ini
# /etc/systemd/system/mcp-vps-cmd.service
[Service]
User=ops
WorkingDirectory=/home/ops/mcp-stack/packages/vps-cmd
ExecStart=/usr/bin/node dist/index.js
Environment=NODE_ENV=production
Environment=LOG_LEVEL=info
```

### nginx

```nginx
# /etc/nginx/mcp.d/vps-cmd.conf (on sss.makkib.com)
location /vps/mcp    { proxy_pass http://127.0.0.1:9445/mcp; }
location /vps/.well-known/ { proxy_pass http://127.0.0.1:9445/.well-known/; }
location /vps/oauth/ { proxy_pass http://127.0.0.1:9445/oauth/; }
location = /vps/health { proxy_pass http://127.0.0.1:9445/health; }
```

### Deploy command

```bash
su - ops -c "cd ~/mcp-stack && git pull && npm run build -w packages/core -w packages/vps-cmd" && systemctl restart mcp-vps-cmd
```

---

## Security Model Summary

| Layer | What It Prevents |
|-------|------------------|
| Shell metacharacter rejection | Injection via pipes, redirects, backticks, `$()`, semicolons |
| Tier engine allowlists | Running arbitrary executables, accessing unregistered services/paths |
| Blocked path patterns | Reading `.env`, SSH keys, `/etc/shadow`, `.gnupg` |
| Approval flow (tier 2/3) | Accidental destructive commands — human must confirm |
| 5-minute approval TTL | Stale approvals can't be replayed |
| Deploy locks | Concurrent deploys corrupting state |
| Rate limiter | Runaway loops — 10 commands/min per host |
| SSH exec (no shell) | Server-side shell interpretation of attacker-controlled input |
| SSH key isolation | Only the bastion holds the private key; workers only accept bastion SSH |
| Output truncation | Memory exhaustion from verbose commands (100 KB stdout, 50 KB stderr) |
