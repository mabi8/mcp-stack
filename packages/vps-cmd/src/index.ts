/**
 * VPS Command MCP Server
 *
 * Secure remote command execution via SSH with tiered permissions.
 * Runs on the bastion host (sss.makkib.com), SSHes into worker VPS.
 *
 * OAuth 2.1 DCR+PKCE flow (simplified — no upstream service to bridge):
 *   Claude → /oauth/register (DCR) → /oauth/authorize (auto-approve)
 *   → redirect with code → /oauth/token → Bearer token for /mcp
 *
 * Unlike centerdevice/bidrento, there's no upstream OAuth to bridge.
 * The authorize step auto-approves since the MCP itself is the service.
 * Security comes from SSH keys + tier engine, not OAuth scoping.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import express from "express";
import { createServer as createHttpsServer } from "https";
import { readFileSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";
import { config as loadEnv } from "dotenv";
import crypto from "node:crypto";

import {
  createLogger,
  SessionStore,
  PendingCodeStore,
  ClientRegistry,
  AuditLogger,
  isAllowedRedirectUri,
  verifyPKCE,
  createDiscoveryHandlers,
  createDCRHandler,
  createTokenHandler,
  bearerAuth,
  type OAuthSession,
} from "@mcp-stack/core";

import { HostRegistry } from "./host-registry.js";
import { SSHPool } from "./ssh-client.js";
import { ApprovalStore } from "./approval-store.js";
import { registerTools } from "./tools.js";
import { vpsCmdAuditFormatter } from "./audit-formatter.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
loadEnv({ path: resolve(__dirname, "..", ".env") });

// ─── Configuration ─────────────────────────────────────────────────

const PORT = parseInt(process.env.MCP_PORT || "9445", 10);
const TLS_CERT = process.env.TLS_CERT || "";
const TLS_KEY = process.env.TLS_KEY || "";
const SERVER_ORIGIN = process.env.SERVER_ORIGIN || `https://sss.makkib.com`;
const SSH_KEY_PATH = process.env.SSH_KEY_PATH || resolve("/home/ops/.ssh/id_ed25519");
const AUDIT_LOG_DIR = process.env.AUDIT_LOG_DIR || resolve(__dirname, "..", "logs");
const RATE_LIMIT_PER_MIN = parseInt(process.env.RATE_LIMIT_PER_MIN || "10", 10);
const ALLOWED_REDIRECT_DOMAINS = ["claude.ai", "claude.com"];

// ─── Shared Infrastructure ──────────────────────────────────────────

const log = createLogger("mcp-vps-cmd");
const sessions = new SessionStore({ file: resolve(__dirname, "..", ".sessions.json"), logger: log });
const pendingCodes = new PendingCodeStore();
const clients = new ClientRegistry();

const hosts = new HostRegistry();
const sshPool = new SSHPool(SSH_KEY_PATH, log);
const approvals = new ApprovalStore();

log.info("config_loaded", {
  port: PORT,
  origin: SERVER_ORIGIN,
  hosts: hosts.size,
  registeredHosts: hosts.list().map(h => h.alias),
});

// ─── Express App ────────────────────────────────────────────────────

const app = express();
app.use(express.json({ limit: "1mb" }));
app.use(express.urlencoded({ extended: true }));
app.use((req, _res, next) => {
  log.debug("http_request", { method: req.method, path: req.path });
  next();
});

// ─── OAuth Discovery ────────────────────────────────────────────────

const discovery = createDiscoveryHandlers(SERVER_ORIGIN);
app.get("/.well-known/oauth-protected-resource", discovery.protectedResource);
app.get("/.well-known/oauth-protected-resource/mcp", discovery.protectedResource);
app.get("/.well-known/oauth-authorization-server", discovery.authorizationServer);
app.get("/.well-known/oauth-authorization-server/mcp", discovery.authorizationServer);

// ─── DCR ────────────────────────────────────────────────────────────

app.post("/oauth/register", createDCRHandler({
  allowedDomains: ALLOWED_REDIRECT_DOMAINS,
  clients,
  logger: log,
}));

// ─── Authorization (auto-approve — no upstream service) ─────────────
// This MCP IS the service. No user login needed. Claude authenticates
// via the OAuth flow, and the tier engine provides access control.

app.get("/oauth/authorize", (req, res) => {
  const { client_id, redirect_uri, state, response_type, code_challenge, code_challenge_method } = req.query;

  if (response_type !== "code") {
    res.status(400).json({ error: "unsupported_response_type" });
    return;
  }

  const client = clients.get(client_id as string);
  if (!client) {
    res.status(400).json({ error: "invalid_client" });
    return;
  }

  const redirectUri = redirect_uri as string;
  if (!client.redirectUris.includes(redirectUri) || !isAllowedRedirectUri(redirectUri, ALLOWED_REDIRECT_DOMAINS)) {
    log.warn("oauth_redirect_mismatch", { uri: redirectUri });
    res.status(400).json({ error: "invalid_request", error_description: "redirect_uri mismatch" });
    return;
  }

  // Auto-approve: create code immediately and redirect back
  const mcpCode = pendingCodes.create({
    clientId: client_id as string,
    codeChallenge: (code_challenge as string) || undefined,
    codeChallengeMethod: (code_challenge_method as string) || undefined,
    data: {
      authorizedAt: Date.now(),
      clientIp: req.ip,
    },
  });

  const callback = new URL(redirectUri);
  callback.searchParams.set("code", mcpCode);
  if (state) callback.searchParams.set("state", state as string);

  log.info("oauth_auto_approved", { clientId: client_id });
  res.redirect(302, callback.toString());
});

// ─── Token Endpoint ─────────────────────────────────────────────────

app.post("/oauth/token", createTokenHandler({
  sessions, pendingCodes, clients, logger: log,
}));

// ─── Health ─────────────────────────────────────────────────────────

app.get("/health", (_req, res) => {
  res.json({
    status: "ok",
    service: "mcp-vps-cmd",
    sessions: sessions.size,
    hosts: hosts.list().map(h => h.alias),
  });
});

// ─── Per-User MCP Sessions ──────────────────────────────────────────

interface UserMcpContext {
  audit: AuditLogger;
  lastUsed: number;
}

const userContexts = new Map<string, UserMcpContext>();
const SESSION_TTL = 30 * 60 * 1000;

function getOrCreateContext(session: OAuthSession): UserMcpContext {
  const existing = userContexts.get(session.mcpToken);
  if (existing) {
    existing.lastUsed = Date.now();
    return existing;
  }

  const audit = new AuditLogger({
    service: "mcp-vps-cmd",
    logsDir: AUDIT_LOG_DIR,
    formatDetails: vpsCmdAuditFormatter,
  });
  audit.setUser(session.mcpClientId || "claude-session");

  const ctx: UserMcpContext = { audit, lastUsed: Date.now() };
  userContexts.set(session.mcpToken, ctx);
  log.info("mcp_session_created", { active: userContexts.size });
  return ctx;
}

// Audit flusher: write to local file (on sss, audit logs stay local + append-only)
function createLocalAuditUploader() {
  return async (content: string, filename: string) => {
    const { appendFileSync, mkdirSync, existsSync } = await import("node:fs");
    const auditDir = resolve(AUDIT_LOG_DIR, "archive");
    if (!existsSync(auditDir)) mkdirSync(auditDir, { recursive: true });
    const filepath = resolve(auditDir, filename);
    appendFileSync(filepath, content, "utf-8");
    log.info("audit_flushed", { filename, path: filepath });
  };
}

// Periodic cleanup
setInterval(async () => {
  const now = Date.now();
  const uploader = createLocalAuditUploader();
  for (const [token, ctx] of userContexts) {
    if (ctx.audit.shouldFlush()) {
      await ctx.audit.flush(uploader).catch((e) =>
        log.error("audit_flush_error", { error: e instanceof Error ? e.message : String(e) }),
      );
    }
    if (now - ctx.lastUsed > SESSION_TTL) {
      await ctx.audit.flush(uploader).catch(() => {});
      userContexts.delete(token);
      log.info("mcp_session_closed_idle", { active: userContexts.size });
    }
  }
}, 15_000);

// ─── MCP Endpoint ───────────────────────────────────────────────────

app.post("/mcp", bearerAuth(sessions, SERVER_ORIGIN), async (req, res) => {
  const session = (req as any).oauthSession as OAuthSession;
  const ctx = getOrCreateContext(session);

  const server = new McpServer({ name: "vps-cmd", version: "1.0.0" });
  registerTools(server, hosts, sshPool, approvals, log, ctx.audit, RATE_LIMIT_PER_MIN);

  try {
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
    res.on("close", () => { transport.close(); server.close(); });
  } catch (e: unknown) {
    log.error("mcp_error", { error: e instanceof Error ? e.message : String(e) });
    if (!res.headersSent) {
      res.status(500).json({ jsonrpc: "2.0", error: { code: -32603, message: "Internal server error" }, id: null });
    }
  }
});

app.get("/mcp", bearerAuth(sessions, SERVER_ORIGIN), (_req, res) => {
  res.writeHead(405).end(JSON.stringify({ jsonrpc: "2.0", error: { code: -32000, message: "Method not allowed." }, id: null }));
});

app.delete("/mcp", bearerAuth(sessions, SERVER_ORIGIN), (_req, res) => {
  res.writeHead(405).end(JSON.stringify({ jsonrpc: "2.0", error: { code: -32000, message: "Method not allowed." }, id: null }));
});

// ─── Start ──────────────────────────────────────────────────────────

if (TLS_CERT && TLS_KEY) {
  createHttpsServer({ cert: readFileSync(TLS_CERT), key: readFileSync(TLS_KEY) }, app)
    .listen(PORT, "0.0.0.0", () => {
      log.info("server_started", { origin: SERVER_ORIGIN, port: PORT, tls: true });
    });
} else {
  log.warn("server_no_tls");
  app.listen(PORT, "0.0.0.0", () => {
    log.info("server_started", { origin: `http://0.0.0.0:${PORT}`, port: PORT, tls: false });
  });
}

// ─── Graceful Shutdown ──────────────────────────────────────────────

async function shutdown(signal: string) {
  log.info("shutdown", { signal });
  const uploader = createLocalAuditUploader();
  for (const [, ctx] of userContexts) {
    await ctx.audit.flush(uploader).catch((e) =>
      log.error("audit_flush_shutdown_error", { error: e instanceof Error ? e.message : String(e) }),
    );
  }
  await sshPool.shutdown();
  sessions.destroy();
  log.info("shutdown_complete");
  process.exit(0);
}

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
