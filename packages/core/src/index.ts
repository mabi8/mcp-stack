/**
 * @mcp-stack/core — Shared infrastructure for MCP services
 *
 * Modules:
 *   logger       — Structured JSON logging with levels, request correlation, secret redaction
 *   cache        — In-memory TTL cache
 *   tool-helpers — MCP tool registration with automatic error handling, timing, audit
 *   audit-logger — Write-action audit trail with buffered flush
 *   oauth        — OAuth 2.1 DCR+PKCE building blocks (sessions, DCR, tokens, bearer auth)
 */

// Logger
export {
  createLogger,
  runWithRequestId,
  getRequestId,
  type Logger,
  type LogLevel,
  type LogEntry,
} from "./logger.js";

// Cache
export {
  Cache,
  TTL,
} from "./cache.js";

// Tool Helpers
export {
  createToolRegistrar,
  type ToolRegistrar,
  type ToolRegistrarOptions,
  type ToolHandler,
} from "./tool-helpers.js";

// Audit Logger
export {
  AuditLogger,
  type AuditUploadFn,
  type AuditDetailFormatter,
  type AuditLoggerOptions,
} from "./audit-logger.js";

// OAuth 2.1 Building Blocks
export {
  SessionStore,
  PendingCodeStore,
  ClientRegistry,
  type ClientRegistryOptions,
  isAllowedRedirectUri,
  escapeHtml,
  verifyPKCE,
  createDiscoveryHandlers,
  createDCRHandler,
  createTokenHandler,
  bearerAuth,
  type OAuthSession,
  type PendingCode,
  type SessionStoreOptions,
} from "./oauth.js";
