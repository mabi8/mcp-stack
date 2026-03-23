/**
 * @mcp-stack/core — OAuth 2.1 Building Blocks
 *
 * Composable helpers for the OAuth 2.1 DCR+PKCE flow that Claude.ai
 * uses to authenticate with MCP servers. Both cd-mcp and bidrento-mcp
 * share ~70% of the OAuth logic — this module extracts that.
 *
 * NOT a monolithic "OAuth server" — it provides building blocks that
 * each service composes into its own Express routes. The authorization
 * step (what happens when the user clicks "connect") is service-specific.
 *
 * Usage:
 *   import { SessionStore, createDiscoveryRoutes, createDCRHandler,
 *            createTokenHandler, bearerAuth } from "@mcp-stack/core";
 *
 *   const sessions = new SessionStore({ file: ".sessions.json", logger });
 *   app.use(createDiscoveryRoutes(serverOrigin));
 *   app.post("/oauth/register", createDCRHandler({ allowedDomains, logger }));
 *   app.post("/oauth/token", createTokenHandler({ sessions, pendingCodes, registeredClients, logger }));
 *   app.post("/mcp", bearerAuth(sessions), mcpHandler);
 */

import crypto from "node:crypto";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import type { Request, Response, NextFunction, RequestHandler } from "express";
import type { Logger } from "./logger.js";

// ─── Session Types ───────────────────────────────────────────────────

export interface OAuthSession {
  /** The MCP bearer token issued to Claude */
  mcpToken: string;
  mcpRefreshToken: string;
  mcpClientId: string;
  mcpExpiresAt: number;
  createdAt: number;
  /** Service-specific data (e.g., CD tokens, user info) */
  data: Record<string, unknown>;
}

// ─── Session Store ───────────────────────────────────────────────────

export interface SessionStoreOptions {
  /** Path to persist sessions (e.g., ".sessions.json"). If omitted, in-memory only. */
  file?: string;
  /** Session lifetime in seconds (default: 86400 = 24h) */
  tokenLifetimeSec?: number;
  /** Cleanup interval in ms (default: 3600000 = 1h) */
  cleanupIntervalMs?: number;
  logger?: Logger;
}

export class SessionStore {
  private sessions = new Map<string, OAuthSession>();
  private readonly file?: string;
  private readonly tokenLifetimeSec: number;
  private readonly logger?: Logger;
  private cleanupTimer?: ReturnType<typeof setInterval>;

  constructor(options: SessionStoreOptions = {}) {
    this.file = options.file;
    this.tokenLifetimeSec = options.tokenLifetimeSec ?? 86400;
    this.logger = options.logger;

    // Load from disk
    if (this.file && existsSync(this.file)) {
      try {
        const saved = JSON.parse(readFileSync(this.file, "utf-8")) as [string, OAuthSession][];
        this.sessions = new Map(saved);
        this.logger?.info("sessions_loaded", { count: this.sessions.size });
      } catch {
        this.logger?.warn("sessions_load_failed");
      }
    }

    // Periodic cleanup
    const interval = options.cleanupIntervalMs ?? 3_600_000;
    this.cleanupTimer = setInterval(() => this.cleanup(), interval);
    this.cleanup(); // Initial cleanup
  }

  /** Look up a session by its MCP bearer token. Returns null if expired. */
  get(token: string): OAuthSession | null {
    const session = this.sessions.get(token);
    if (!session || session.mcpExpiresAt <= Date.now()) return null;
    return session;
  }

  /** Find a session by its refresh token. */
  findByRefresh(refreshToken: string): OAuthSession | undefined {
    for (const session of this.sessions.values()) {
      if (session.mcpRefreshToken === refreshToken) return session;
    }
    return undefined;
  }

  /**
   * Create a new session. Returns the token response fields.
   */
  create(clientId: string, data: Record<string, unknown> = {}): {
    access_token: string;
    refresh_token: string;
    expires_in: number;
    token_type: string;
    scope: string;
  } {
    const mcpToken = crypto.randomBytes(32).toString("hex");
    const mcpRefreshToken = crypto.randomBytes(32).toString("hex");

    const session: OAuthSession = {
      mcpToken,
      mcpRefreshToken,
      mcpClientId: clientId,
      mcpExpiresAt: Date.now() + this.tokenLifetimeSec * 1000,
      createdAt: Date.now(),
      data,
    };

    this.sessions.set(mcpToken, session);
    this.persist();
    this.logger?.info("session_created", { total: this.sessions.size });

    return {
      access_token: mcpToken,
      refresh_token: mcpRefreshToken,
      expires_in: this.tokenLifetimeSec,
      token_type: "bearer",
      scope: "mcp",
    };
  }

  /**
   * Refresh a session — rotates both tokens, preserves data.
   */
  refresh(oldSession: OAuthSession): {
    access_token: string;
    refresh_token: string;
    expires_in: number;
    token_type: string;
    scope: string;
  } | null {
    // Delete old token
    this.sessions.delete(oldSession.mcpToken);

    return this.create(oldSession.mcpClientId, oldSession.data);
  }

  /** Delete a session by token. */
  delete(token: string): void {
    this.sessions.delete(token);
    this.persist();
  }

  get size(): number {
    return this.sessions.size;
  }

  destroy(): void {
    if (this.cleanupTimer) clearInterval(this.cleanupTimer);
  }

  private cleanup(): void {
    const now = Date.now();
    let cleaned = 0;
    for (const [token, session] of this.sessions) {
      if (session.mcpExpiresAt <= now) {
        this.sessions.delete(token);
        cleaned++;
      }
    }
    if (cleaned > 0) {
      this.persist();
      this.logger?.info("sessions_cleanup", { cleaned, remaining: this.sessions.size });
    }
  }

  private persist(): void {
    if (!this.file) return;
    try {
      writeFileSync(this.file, JSON.stringify([...this.sessions], null, 2), { mode: 0o600 });
    } catch (e) {
      this.logger?.error("sessions_persist_failed", {
        error: e instanceof Error ? e.message : String(e),
      });
    }
  }
}

// ─── Pending Code Store ──────────────────────────────────────────────

export interface PendingCode {
  clientId: string;
  codeChallenge?: string;
  codeChallengeMethod?: string;
  expiresAt: number;
  /** Service-specific data to carry into the session */
  data: Record<string, unknown>;
}

export class PendingCodeStore {
  private codes = new Map<string, PendingCode>();

  /** Create a new authorization code. Returns the code string. */
  create(entry: Omit<PendingCode, "expiresAt">, ttlMs = 300_000): string {
    const code = crypto.randomBytes(32).toString("hex");
    this.codes.set(code, { ...entry, expiresAt: Date.now() + ttlMs });
    return code;
  }

  /** Consume a code (returns it and deletes). Returns null if invalid/expired. */
  consume(code: string, clientId: string): PendingCode | null {
    const pending = this.codes.get(code);
    if (!pending || pending.expiresAt <= Date.now() || pending.clientId !== clientId) {
      this.codes.delete(code);
      return null;
    }
    this.codes.delete(code);
    return pending;
  }
}

// ─── Client Registry ─────────────────────────────────────────────────

export interface ClientRegistryOptions {
  /** Path to persist clients (e.g., ".clients.json"). If omitted, in-memory only. */
  file?: string;
  logger?: Logger;
}

export class ClientRegistry {
  private clients = new Map<string, { clientSecret: string; redirectUris: string[] }>();
  private readonly file?: string;
  private readonly logger?: Logger;

  constructor(options: ClientRegistryOptions = {}) {
    this.file = options.file;
    this.logger = options.logger;

    // Load from disk
    if (this.file && existsSync(this.file)) {
      try {
        const saved = JSON.parse(readFileSync(this.file, "utf-8")) as
          [string, { clientSecret: string; redirectUris: string[] }][];
        this.clients = new Map(saved);
        this.logger?.info("clients_loaded", { count: this.clients.size });
      } catch {
        this.logger?.warn("clients_load_failed");
      }
    }
  }

  register(redirectUris: string[]): { clientId: string; clientSecret: string } {
    const clientId = `client_${crypto.randomUUID()}`;
    const clientSecret = crypto.randomBytes(32).toString("hex");
    this.clients.set(clientId, { clientSecret, redirectUris });
    this.persist();
    return { clientId, clientSecret };
  }

  get(clientId: string): { clientSecret: string; redirectUris: string[] } | undefined {
    return this.clients.get(clientId);
  }

  validate(clientId: string, clientSecret?: string): boolean {
    const client = this.clients.get(clientId);
    if (!client) return false;
    if (clientSecret && client.clientSecret !== clientSecret) return false;
    return true;
  }

  get size(): number {
    return this.clients.size;
  }

  private persist(): void {
    if (!this.file) return;
    try {
      writeFileSync(this.file, JSON.stringify([...this.clients], null, 2), { mode: 0o600 });
    } catch (e) {
      this.logger?.error("clients_persist_failed", {
        error: e instanceof Error ? e.message : String(e),
      });
    }
  }
}

// ─── Redirect URI Validation ─────────────────────────────────────────

export function isAllowedRedirectUri(uri: string, allowedDomains: string[]): boolean {
  try {
    const url = new URL(uri);
    return allowedDomains.some(
      (d) => url.hostname === d || url.hostname.endsWith(`.${d}`),
    );
  } catch {
    return false;
  }
}

// ─── HTML Escaping (prevent XSS in error pages) ──────────────────────

export function escapeHtml(str: string): string {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

// ─── PKCE Verification ───────────────────────────────────────────────

export function verifyPKCE(codeVerifier: string, codeChallenge: string): boolean {
  const hash = crypto.createHash("sha256").update(codeVerifier).digest("base64url");
  return hash === codeChallenge;
}

// ─── Discovery Endpoint Handlers ─────────────────────────────────────

export function createDiscoveryHandlers(serverOrigin: string) {
  const protectedResource = (_req: Request, res: Response) => {
    res.json({
      resource: `${serverOrigin}/mcp`,
      authorization_servers: [serverOrigin],
      bearer_methods_supported: ["header"],
    });
  };

  const authorizationServer = (_req: Request, res: Response) => {
    res.json({
      issuer: serverOrigin,
      authorization_endpoint: `${serverOrigin}/oauth/authorize`,
      token_endpoint: `${serverOrigin}/oauth/token`,
      registration_endpoint: `${serverOrigin}/oauth/register`,
      response_types_supported: ["code"],
      grant_types_supported: ["authorization_code", "refresh_token"],
      token_endpoint_auth_methods_supported: ["client_secret_post", "none"],
      code_challenge_methods_supported: ["S256"],
      scopes_supported: ["mcp"],
    });
  };

  return { protectedResource, authorizationServer };
}

// ─── DCR Handler ─────────────────────────────────────────────────────

export function createDCRHandler(options: {
  allowedDomains: string[];
  clients: ClientRegistry;
  logger?: Logger;
}): RequestHandler {
  const { allowedDomains, clients, logger } = options;

  return (req: Request, res: Response) => {
    const { client_name, redirect_uris } = req.body;
    logger?.info("oauth_dcr", { client_name });

    const uris = (redirect_uris || []) as string[];
    if (uris.length === 0) {
      res.status(400).json({ error: "invalid_request", error_description: "redirect_uris required" });
      return;
    }

    for (const uri of uris) {
      if (!isAllowedRedirectUri(uri, allowedDomains)) {
        logger?.warn("oauth_dcr_rejected", { uri });
        res.status(400).json({ error: "invalid_request", error_description: "redirect_uri domain not allowed" });
        return;
      }
    }

    const { clientId, clientSecret } = clients.register(uris);

    res.status(201).json({
      client_id: clientId,
      client_secret: clientSecret,
      client_name: client_name || "Claude",
      redirect_uris: uris,
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "client_secret_post",
    });
  };
}

// ─── Token Handler ───────────────────────────────────────────────────

export function createTokenHandler(options: {
  sessions: SessionStore;
  pendingCodes: PendingCodeStore;
  clients: ClientRegistry;
  logger?: Logger;
}): RequestHandler {
  const { sessions, pendingCodes, clients, logger } = options;

  return (req: Request, res: Response) => {
    const { grant_type, code, client_id, client_secret, code_verifier } = req.body;
    logger?.debug("oauth_token", { grant_type, client_id });

    if (!clients.validate(client_id, client_secret)) {
      res.status(401).json({ error: "invalid_client" });
      return;
    }

    if (grant_type === "authorization_code") {
      const pending = pendingCodes.consume(code, client_id);
      if (!pending) {
        res.status(400).json({ error: "invalid_grant" });
        return;
      }

      // PKCE verification
      if (pending.codeChallenge && code_verifier) {
        if (!verifyPKCE(code_verifier, pending.codeChallenge)) {
          res.status(400).json({ error: "invalid_grant" });
          return;
        }
      }

      const tokenResponse = sessions.create(client_id, pending.data);
      logger?.info("oauth_session_created", { total: sessions.size });
      res.json(tokenResponse);
      return;
    }

    if (grant_type === "refresh_token") {
      const oldSession = sessions.findByRefresh(req.body.refresh_token);
      if (!oldSession) {
        res.status(400).json({ error: "invalid_grant" });
        return;
      }

      const tokenResponse = sessions.refresh(oldSession);
      if (!tokenResponse) {
        res.status(500).json({ error: "server_error" });
        return;
      }

      logger?.info("oauth_session_refreshed");
      res.json(tokenResponse);
      return;
    }

    res.status(400).json({ error: "unsupported_grant_type" });
  };
}

// ─── Bearer Auth Middleware ──────────────────────────────────────────

export function bearerAuth(
  sessions: SessionStore,
  serverOrigin: string,
): (req: Request, res: Response, next: NextFunction) => void {
  return (req: Request, res: Response, next: NextFunction) => {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith("Bearer ")) {
      res.status(401)
        .set("WWW-Authenticate", `Bearer resource_metadata="${serverOrigin}/.well-known/oauth-protected-resource"`)
        .json({ error: "unauthorized" });
      return;
    }

    const token = authHeader.slice(7);
    const session = sessions.get(token);
    if (!session) {
      res.status(401)
        .set("WWW-Authenticate", `Bearer resource_metadata="${serverOrigin}/.well-known/oauth-protected-resource"`)
        .json({ error: "unauthorized" });
      return;
    }

    (req as unknown as Record<string, unknown>).oauthSession = session;
    next();
  };
}
