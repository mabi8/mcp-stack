/**
 * CenterDevice MCP Server
 *
 * OAuth 2.1 DCR+PKCE flow:
 *   Claude → /oauth/register (DCR) → /oauth/authorize → CenterDevice login
 *   → /auth/callback → /oauth/token → Bearer token for /mcp
 *
 * Each user gets their own CenterDevice OAuth tokens, stored in the session.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import express from "express";
import { createServer as createHttpsServer } from "https";
import { readFileSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";
import { config as loadEnv } from "dotenv";

import {
  createLogger,
  SessionStore,
  PendingCodeStore,
  ClientRegistry,
  AuditLogger,
  isAllowedRedirectUri,
  escapeHtml,
  verifyPKCE,
  createDiscoveryHandlers,
  createDCRHandler,
  createTokenHandler,
  bearerAuth,
  type OAuthSession,
} from "@mcp-stack/core";

import { CenterDeviceClient, type CDTokens, type CDConfig } from "./client.js";
import { registerTools } from "./tools.js";
import { cdAuditFormatter } from "./audit-formatter.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
loadEnv({ path: resolve(__dirname, "..", ".env") });

// ─── Configuration ─────────────────────────────────────────────────

const PORT = parseInt(process.env.MCP_PORT || "9443", 10);
const TLS_CERT = process.env.TLS_CERT || "";
const TLS_KEY = process.env.TLS_KEY || "";
const SERVER_ORIGIN = process.env.SERVER_ORIGIN || `https://box.makkib.com:${PORT}`;
const ALLOWED_REDIRECT_DOMAINS = ["claude.ai", "claude.com", "box.makkib.com"];

const cdConfig: CDConfig = {
  baseUrl: process.env.CD_BASE_URL || "https://api.centerdevice.de/v2",
  authUrl: process.env.CD_AUTH_URL || "https://auth.centerdevice.de",
  clientId: process.env.CD_CLIENT_ID || "",
  clientSecret: process.env.CD_CLIENT_SECRET || "",
};

const CD_CALLBACK_URL = process.env.CD_CALLBACK_URL || `https://box.makkib.com:9443/auth/callback`;

// Audit log destination in CenterDevice
const AUDIT_COLLECTION = process.env.AUDIT_COLLECTION || "d20fd9d1-a3e6-4369-9fae-30cb33d51bb5";
const AUDIT_FOLDER = process.env.AUDIT_FOLDER || "8ef6f1ca-9a09-46d5-83de-f20b149335b5";

// ─── Shared Infrastructure ──────────────────────────────────────────

const log = createLogger("mcp-centerdevice");
const sessions = new SessionStore({ file: resolve(__dirname, "..", ".sessions.json"), logger: log });
const pendingCodes = new PendingCodeStore();
const clients = new ClientRegistry();

const cdEncodedCredentials = Buffer.from(
  `${cdConfig.clientId}:${cdConfig.clientSecret}`,
).toString("base64");

// ─── Pending CenterDevice Auth Flows ────────────────────────────────
// Tracks the Claude ↔ CenterDevice OAuth bridge (not in core — CD-specific)

interface PendingCDAuth {
  claudeClientId: string;
  claudeRedirectUri: string;
  claudeState: string;
  claudeCodeChallenge?: string;
  claudeCodeChallengeMethod?: string;
  expiresAt: number;
}

const pendingCDAuths = new Map<string, PendingCDAuth>();

// ─── Express App ────────────────────────────────────────────────────

const app = express();
app.use(express.json({ limit: "50mb" }));
app.use(express.urlencoded({ extended: true, limit: "50mb" }));
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

// ─── Authorization: redirect to CenterDevice login ──────────────────

app.get("/oauth/authorize", (req, res) => {
  const { client_id, redirect_uri, state, code_challenge, code_challenge_method } = req.query;

  if (req.query.response_type !== "code") {
    res.status(400).json({ error: "unsupported_response_type" }); return;
  }

  const client = clients.get(client_id as string);
  if (!client) { res.status(400).json({ error: "invalid_client" }); return; }

  const redirectUri = redirect_uri as string;
  if (!client.redirectUris.includes(redirectUri) || !isAllowedRedirectUri(redirectUri, ALLOWED_REDIRECT_DOMAINS)) {
    log.warn("oauth_redirect_mismatch", { uri: redirectUri });
    res.status(400).json({ error: "invalid_request", error_description: "redirect_uri mismatch" });
    return;
  }

  // Create a CD-specific auth state linking Claude's request to the CD login
  const cdState = crypto.randomBytes(32).toString("hex");
  pendingCDAuths.set(cdState, {
    claudeClientId: client_id as string,
    claudeRedirectUri: redirectUri,
    claudeState: (state as string) || "",
    claudeCodeChallenge: (code_challenge as string) || undefined,
    claudeCodeChallengeMethod: (code_challenge_method as string) || undefined,
    expiresAt: Date.now() + 10 * 60 * 1000,
  });

  const cdAuthUrl = `${cdConfig.authUrl}/authorize?` +
    `client_id=${encodeURIComponent(cdConfig.clientId)}` +
    `&redirect_uri=${encodeURIComponent(CD_CALLBACK_URL)}` +
    `&response_type=code&state=${cdState}`;

  log.info("oauth_cd_redirect");
  res.redirect(302, cdAuthUrl);
});

// ─── CenterDevice OAuth Callback ────────────────────────────────────

import crypto from "node:crypto";

app.get("/auth/callback", async (req, res) => {
  const { code, state, error } = req.query;

  if (error) {
    log.warn("oauth_cd_denied", { error });
    res.status(403).type("html").send(`<!DOCTYPE html><html><body>
<h2>CenterDevice authorization denied.</h2><p>${escapeHtml(String(error))}</p></body></html>`);
    return;
  }

  if (!state || !code) {
    res.status(400).json({ error: "Missing state or code" }); return;
  }

  const pending = pendingCDAuths.get(state as string);
  if (!pending || pending.expiresAt < Date.now()) {
    pendingCDAuths.delete(state as string);
    res.status(400).type("html").send(`<!DOCTYPE html><html><body>
<h2>Authorization expired.</h2><p>Please try connecting again from Claude.</p></body></html>`);
    return;
  }
  pendingCDAuths.delete(state as string);

  try {
    // Exchange CD auth code for CD tokens
    const tokenRes = await fetch(`${cdConfig.authUrl}/token`, {
      method: "POST",
      headers: {
        Authorization: `Basic ${cdEncodedCredentials}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        redirect_uri: CD_CALLBACK_URL,
        code: code as string,
      }).toString(),
    });

    if (!tokenRes.ok) {
      const text = await tokenRes.text();
      log.error("oauth_cd_token_exchange_failed", { status: tokenRes.status, body: text.slice(0, 200) });
      res.status(500).type("html").send(`<!DOCTYPE html><html><body>
<h2>CenterDevice token exchange failed.</h2></body></html>`);
      return;
    }

    const cdTokenData = await tokenRes.json() as {
      access_token: string; refresh_token: string; expires_in: number;
    };

    log.info("oauth_cd_tokens_obtained", { expires_in: cdTokenData.expires_in });

    // Store CD tokens in the pending code so they flow into the session
    const mcpCode = pendingCodes.create({
      clientId: pending.claudeClientId,
      codeChallenge: pending.claudeCodeChallenge,
      codeChallengeMethod: pending.claudeCodeChallengeMethod,
      data: {
        cdAccessToken: cdTokenData.access_token,
        cdRefreshToken: cdTokenData.refresh_token,
        cdExpiresAt: Date.now() + cdTokenData.expires_in * 1000,
      },
    });

    // Redirect back to Claude
    const claudeCallback = new URL(pending.claudeRedirectUri);
    claudeCallback.searchParams.set("code", mcpCode);
    if (pending.claudeState) claudeCallback.searchParams.set("state", pending.claudeState);

    log.info("oauth_complete");
    res.redirect(302, claudeCallback.toString());
  } catch (e: unknown) {
    log.error("oauth_cd_callback_error", { error: e instanceof Error ? e.message : String(e) });
    res.status(500).type("html").send(`<!DOCTYPE html><html><body>
<h2>Error during authentication.</h2></body></html>`);
  }
});

// ─── Token Endpoint ─────────────────────────────────────────────────

app.post("/oauth/token", createTokenHandler({
  sessions, pendingCodes, clients, logger: log,
}));

// ─── Health ─────────────────────────────────────────────────────────

app.get("/health", (_req, res) => {
  res.json({ status: "ok", service: "mcp-centerdevice", sessions: sessions.size });
});

// ─── Per-User MCP Sessions ──────────────────────────────────────────

interface UserMcpContext {
  cdClient: CenterDeviceClient;
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

  // Guard: old sessions from pre-refactor cd-mcp may lack session.data
  const data = session.data || (session as any);
  if (!data.cdAccessToken) {
    throw new Error("Session missing CenterDevice tokens — user must reconnect");
  }

  const tokens: CDTokens = {
    access_token: data.cdAccessToken as string,
    refresh_token: data.cdRefreshToken as string,
    expires_at: data.cdExpiresAt as number,
  };
  const cdClient = new CenterDeviceClient(cdConfig, tokens);

  const audit = new AuditLogger({
    service: "mcp-centerdevice",
    formatDetails: cdAuditFormatter,
  });
  audit.setUser(session.mcpClientId || "unknown");

  // Resolve actual CD user name
  cdClient.jsonRequest("/user/current").then((user: any) => {
    const email = user?.email || user?.["e-mail"] || "";
    const name = email || user?.name || session.mcpClientId || "unknown";
    audit.setUser(name);
    log.info("user_resolved", { user: name });
  }).catch(() => {
    log.debug("user_resolve_failed");
  });

  const ctx: UserMcpContext = { cdClient, audit, lastUsed: Date.now() };
  userContexts.set(session.mcpToken, ctx);
  log.info("mcp_session_created", { active: userContexts.size });
  return ctx;
}

// Create audit upload function for a given CD client
function createAuditUploader(cdClient: CenterDeviceClient) {
  return async (content: string, filename: string) => {
    await cdClient.uploadDocument({
      filename,
      data: Buffer.from(content, "utf-8"),
      contentType: "text/markdown",
      collections: [AUDIT_COLLECTION],
      folders: [AUDIT_FOLDER],
    });
    log.info("audit_flushed", { filename });
  };
}

// Periodic cleanup — flush audit logs, close idle sessions
setInterval(async () => {
  const now = Date.now();
  for (const [token, ctx] of userContexts) {
    if (ctx.audit.shouldFlush()) {
      await ctx.audit.flush(createAuditUploader(ctx.cdClient)).catch((e) =>
        log.error("audit_flush_error", { error: e instanceof Error ? e.message : String(e) }),
      );
    }
    if (now - ctx.lastUsed > SESSION_TTL) {
      await ctx.audit.flush(createAuditUploader(ctx.cdClient)).catch(() => {});
      userContexts.delete(token);
      log.info("mcp_session_closed_idle", { active: userContexts.size });
    }
  }
}, 15_000);

// ─── MCP Endpoint ───────────────────────────────────────────────────

app.post("/mcp", bearerAuth(sessions, SERVER_ORIGIN), async (req, res) => {
  const session = (req as any).oauthSession as OAuthSession;

  let ctx: UserMcpContext;
  try {
    ctx = getOrCreateContext(session);
  } catch (e: unknown) {
    // Invalid session (e.g., old format missing CD tokens) — force re-auth
    log.warn("mcp_invalid_session", { error: e instanceof Error ? e.message : String(e) });
    sessions.delete(session.mcpToken);
    res.status(401)
      .set("WWW-Authenticate", `Bearer resource_metadata="${SERVER_ORIGIN}/.well-known/oauth-protected-resource"`)
      .json({ error: "invalid_token", error_description: "Session expired — please reconnect" });
    return;
  }

  const server = new McpServer({ name: "centerdevice", version: "1.0.0" });
  registerTools(server, ctx.cdClient, log, ctx.audit);

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
  for (const [, ctx] of userContexts) {
    await ctx.audit.flush(createAuditUploader(ctx.cdClient)).catch((e) =>
      log.error("audit_flush_shutdown_error", { error: e instanceof Error ? e.message : String(e) }),
    );
  }
  sessions.destroy();
  log.info("shutdown_complete");
  process.exit(0);
}

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
