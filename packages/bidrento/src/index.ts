/**
 * Bidrento MCP Server
 *
 * OAuth 2.1 DCR+PKCE for Claude.ai authentication.
 * API key auth (X-API-TOKEN) toward Bidrento.
 *
 * Simpler than CenterDevice — no third-party OAuth bridge needed.
 * The /oauth/authorize endpoint shows a simple "Grant Access" page
 * (the API key is server-side, not per-user).
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import express from "express";
import crypto from "node:crypto";
import { createServer as createHttpsServer } from "https";
import { readFileSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";
import { config as loadEnv } from "dotenv";

import {
  createLogger,
  Cache,
  TTL,
  SessionStore,
  PendingCodeStore,
  ClientRegistry,
  isAllowedRedirectUri,
  createDiscoveryHandlers,
  createDCRHandler,
  createTokenHandler,
  bearerAuth,
} from "@mcp-stack/core";

import { BidrentoClient } from "./client.js";
import { registerTools } from "./tools.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
loadEnv({ path: resolve(__dirname, "..", ".env") });

// ─── Configuration ─────────────────────────────────────────────────

const PORT = parseInt(process.env.MCP_PORT || "9444", 10);
const TLS_CERT = process.env.TLS_CERT || "";
const TLS_KEY = process.env.TLS_KEY || "";
const SERVER_ORIGIN = process.env.SERVER_ORIGIN || "https://box.makkib.com/bidrento";
const ALLOWED_REDIRECT_DOMAINS = ["claude.ai", "claude.com", "box.makkib.com"];

const BIDRENTO_API_KEY = process.env.BIDRENTO_API_KEY || "";
const BIDRENTO_BASE_URL = process.env.BIDRENTO_BASE_URL || "https://pro.bidrento.com";

// ─── Shared Infrastructure ──────────────────────────────────────────

const log = createLogger("mcp-bidrento");

if (!BIDRENTO_API_KEY) {
  log.error("fatal", { message: "BIDRENTO_API_KEY is not set" });
  process.exit(1);
}

const bidrento = new BidrentoClient({ baseUrl: BIDRENTO_BASE_URL, apiKey: BIDRENTO_API_KEY, logger: log });
const sessions = new SessionStore({ file: resolve(__dirname, "..", ".sessions.json"), logger: log });
const pendingCodes = new PendingCodeStore();
const clients = new ClientRegistry({ file: resolve(__dirname, "..", ".clients.json"), logger: log });

// ─── Express App ────────────────────────────────────────────────────

const app = express();
app.use(express.json());
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
// OpenID-compat alias
app.get("/.well-known/openid-configuration", discovery.authorizationServer);

// ─── DCR ────────────────────────────────────────────────────────────

app.post("/oauth/register", createDCRHandler({
  allowedDomains: ALLOWED_REDIRECT_DOMAINS,
  clients,
  logger: log,
}));

// ─── Authorization ──────────────────────────────────────────────────
// Bidrento uses a shared API key (not per-user OAuth), so the authorize
// endpoint just shows a "Grant Access" button and issues a code immediately.

app.get("/oauth/authorize", (req, res) => {
  const { client_id, redirect_uri, state, code_challenge, code_challenge_method, response_type } = req.query;

  if (response_type !== "code") {
    res.status(400).json({ error: "unsupported_response_type" }); return;
  }

  const client = clients.get(client_id as string);
  if (!client) { res.status(400).json({ error: "invalid_client" }); return; }

  const redirectUri = redirect_uri as string;
  if (!client.redirectUris.includes(redirectUri) || !isAllowedRedirectUri(redirectUri, ALLOWED_REDIRECT_DOMAINS)) {
    log.warn("oauth_redirect_mismatch", { uri: redirectUri });
    res.status(400).json({ error: "invalid_request" }); return;
  }

  // Show a simple grant page
  const formAction = `${SERVER_ORIGIN}/oauth/grant`;
  res.type("html").send(`<!DOCTYPE html><html><body style="font-family:sans-serif;max-width:400px;margin:80px auto;text-align:center">
<h2>Bidrento MCP</h2>
<p>Grant Claude access to Bidrento property data?</p>
<form method="POST" action="${formAction}">
  <input type="hidden" name="client_id" value="${client_id}">
  <input type="hidden" name="redirect_uri" value="${redirectUri}">
  <input type="hidden" name="state" value="${state || ""}">
  <input type="hidden" name="code_challenge" value="${code_challenge || ""}">
  <input type="hidden" name="code_challenge_method" value="${code_challenge_method || ""}">
  <button type="submit" style="padding:12px 32px;font-size:16px;cursor:pointer;background:#2563eb;color:white;border:none;border-radius:6px">Grant Access</button>
</form>
</body></html>`);
});

app.post("/oauth/grant", (req, res) => {
  const { client_id, redirect_uri, state, code_challenge, code_challenge_method } = req.body;

  const code = pendingCodes.create({
    clientId: client_id,
    codeChallenge: code_challenge || undefined,
    codeChallengeMethod: code_challenge_method || undefined,
    data: {},  // No per-user data for Bidrento — shared API key
  });

  const callback = new URL(redirect_uri);
  callback.searchParams.set("code", code);
  if (state) callback.searchParams.set("state", state);

  log.info("oauth_grant_approved");
  res.redirect(302, callback.toString());
});

// ─── Token Endpoint ─────────────────────────────────────────────────

app.post("/oauth/token", createTokenHandler({
  sessions, pendingCodes, clients, logger: log,
}));

// ─── Health ─────────────────────────────────────────────────────────

const healthCache = new Cache();

app.get("/health", async (_req, res) => {
  const cached = healthCache.get<{ status: string }>("health");
  if (cached) {
    res.status(cached.status === "ok" ? 200 : 503).json(cached);
    return;
  }

  try {
    await bidrento.listBuildings();
    const result = { status: "ok", service: "mcp-bidrento", upstream: "ok" };
    healthCache.set("health", result, TTL.MIN_1);
    res.json(result);
  } catch (e: unknown) {
    const reason = e instanceof Error ? e.message : String(e);
    log.warn("health_check_failed", { reason });
    const result = { status: "down", service: "mcp-bidrento", upstream: "error", reason };
    healthCache.set("health", result, TTL.SEC_30);
    res.status(503).json(result);
  }
});

// ─── MCP Endpoint ───────────────────────────────────────────────────

app.post("/mcp", bearerAuth(sessions, SERVER_ORIGIN), async (req, res) => {
  const server = new McpServer({ name: "bidrento", version: "1.0.0" });
  registerTools(server, bidrento, log);

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

function shutdown(signal: string) {
  log.info("shutdown", { signal });
  sessions.destroy();
  log.info("shutdown_complete");
  process.exit(0);
}

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
