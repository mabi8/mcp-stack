/**
 * @mcp-stack/core — Structured JSON Logger
 *
 * Zero external dependencies. Writes to stderr (systemd/journald captures it).
 * JSON in production, pretty-print in development.
 *
 * Usage:
 *   import { createLogger } from "@mcp-stack/core";
 *   const log = createLogger("mcp-centerdevice");
 *   log.info("tool_call", { tool: "search_documents", duration_ms: 342 });
 *   log.error("api_failure", { status: 401, path: "/documents" });
 *
 * Child loggers (adds persistent fields):
 *   const toolLog = log.child({ tool: "search_documents", req_id: "abc123" });
 *   toolLog.info("start");         // includes tool + req_id automatically
 *   toolLog.info("done", { ms: 42 });
 *
 * Request correlation:
 *   import { runWithRequestId, getRequestId } from "@mcp-stack/core";
 *   runWithRequestId("abc123", async () => { ... });
 *   // All log calls inside will include req_id automatically
 */

import { AsyncLocalStorage } from "node:async_hooks";

// ─── Types ───────────────────────────────────────────────────────────

export type LogLevel = "error" | "warn" | "info" | "debug" | "trace";

export interface LogEntry {
  ts: string;
  level: LogLevel;
  service: string;
  event: string;
  [key: string]: unknown;
}

export interface Logger {
  error(event: string, data?: Record<string, unknown>): void;
  warn(event: string, data?: Record<string, unknown>): void;
  info(event: string, data?: Record<string, unknown>): void;
  debug(event: string, data?: Record<string, unknown>): void;
  trace(event: string, data?: Record<string, unknown>): void;
  child(fields: Record<string, unknown>): Logger;
  /** Current effective log level */
  readonly level: LogLevel;
}

// ─── Level Ordering ──────────────────────────────────────────────────

const LEVEL_ORDER: Record<LogLevel, number> = {
  error: 0,
  warn: 1,
  info: 2,
  debug: 3,
  trace: 4,
};

// ─── Request ID Propagation ──────────────────────────────────────────

const requestStore = new AsyncLocalStorage<string>();

/**
 * Run a function with a request ID that will be automatically
 * included in all log entries within the async context.
 */
export function runWithRequestId<T>(reqId: string, fn: () => T): T {
  return requestStore.run(reqId, fn);
}

/** Get the current request ID (if inside a runWithRequestId context). */
export function getRequestId(): string | undefined {
  return requestStore.getStore();
}

// ─── Secret Redaction ────────────────────────────────────────────────

const SECRET_KEYS = new Set([
  "access_token", "refresh_token", "token", "secret", "password",
  "api_key", "apiKey", "authorization", "cookie", "client_secret",
  "cdAccessToken", "cdRefreshToken", "mcpToken", "mcpRefreshToken",
  "BIDRENTO_API_KEY", "CD_CLIENT_SECRET", "MCP_BEARER_TOKEN",
]);

function redactSecrets(obj: unknown, depth = 0): unknown {
  if (depth > 6 || obj === null || obj === undefined) return obj;
  if (typeof obj === "string") return obj;
  if (typeof obj !== "object") return obj;

  if (Array.isArray(obj)) {
    return obj.map((item) => redactSecrets(item, depth + 1));
  }

  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(obj as Record<string, unknown>)) {
    if (SECRET_KEYS.has(key)) {
      result[key] = typeof value === "string" && value.length > 0
        ? `[REDACTED:${value.length}chars]`
        : "[REDACTED]";
    } else {
      result[key] = redactSecrets(value, depth + 1);
    }
  }
  return result;
}

// ─── Pretty Formatting (development mode) ────────────────────────────

const LEVEL_COLORS: Record<LogLevel, string> = {
  error: "\x1b[31m", // red
  warn: "\x1b[33m",  // yellow
  info: "\x1b[36m",  // cyan
  debug: "\x1b[90m", // gray
  trace: "\x1b[90m", // gray
};
const RESET = "\x1b[0m";

function prettyFormat(entry: LogEntry): string {
  const color = LEVEL_COLORS[entry.level] || "";
  const time = entry.ts.slice(11, 23); // HH:MM:SS.mmm
  const { ts: _ts, level, service, event, ...rest } = entry;
  const extra = Object.keys(rest).length > 0
    ? " " + JSON.stringify(rest)
    : "";
  return `${color}${time} ${level.toUpperCase().padEnd(5)}${RESET} [${service}] ${event}${extra}`;
}

// ─── Logger Factory ──────────────────────────────────────────────────

export function createLogger(service: string, overrideLevel?: LogLevel): Logger {
  const configuredLevel: LogLevel =
    overrideLevel ||
    (process.env.LOG_LEVEL as LogLevel) ||
    "info";

  const isDev = process.env.NODE_ENV === "development";
  const minLevel = LEVEL_ORDER[configuredLevel] ?? LEVEL_ORDER.info;

  function shouldLog(level: LogLevel): boolean {
    return (LEVEL_ORDER[level] ?? 0) <= minLevel;
  }

  function emit(level: LogLevel, event: string, data?: Record<string, unknown>, extraFields?: Record<string, unknown>) {
    if (!shouldLog(level)) return;

    const entry: LogEntry = {
      ts: new Date().toISOString(),
      level,
      service,
      event,
      ...extraFields,
      ...data,
    };

    // Add request ID if available
    const reqId = requestStore.getStore();
    if (reqId && !entry.req_id) {
      entry.req_id = reqId;
    }

    // Redact secrets
    const safe = redactSecrets(entry) as LogEntry;

    const output = isDev
      ? prettyFormat(safe) + "\n"
      : JSON.stringify(safe) + "\n";

    process.stderr.write(output);
  }

  function makeLogger(parentFields?: Record<string, unknown>): Logger {
    const fields = parentFields || {};

    return {
      get level() { return configuredLevel; },

      error(event, data?) { emit("error", event, data, fields); },
      warn(event, data?)  { emit("warn", event, data, fields); },
      info(event, data?)  { emit("info", event, data, fields); },
      debug(event, data?) { emit("debug", event, data, fields); },
      trace(event, data?) { emit("trace", event, data, fields); },

      child(childFields: Record<string, unknown>): Logger {
        return makeLogger({ ...fields, ...childFields });
      },
    };
  }

  return makeLogger();
}
