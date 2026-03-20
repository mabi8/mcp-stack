/**
 * @mcp-stack/core — Audit Logger
 *
 * Buffers write operations in a local markdown file, then flushes
 * to a configurable destination (e.g., CenterDevice collection/folder)
 * after an idle timeout or on graceful shutdown.
 *
 * Usage:
 *   const audit = new AuditLogger({
 *     service: "mcp-centerdevice",
 *     logsDir: "./logs",
 *     flushIdleMs: 60_000,
 *     formatDetails: myFormatter,  // optional, service-specific
 *   });
 *
 *   audit.setUser("markus.binder@bcliving.de");
 *   audit.log("rename_document", { document_id: "abc", filename: "new.pdf" }, "✅ (120ms)", "Triage filing");
 *
 *   // When shutting down:
 *   await audit.flush(uploadFn);
 */

import { appendFileSync, readFileSync, unlinkSync, existsSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";

// ─── Types ───────────────────────────────────────────────────────────

/**
 * Function to upload the flushed log file to a remote destination.
 * Receives the file content and a suggested filename.
 * Must throw on failure (audit logger will keep the local file for retry).
 */
export type AuditUploadFn = (content: string, filename: string) => Promise<void>;

/**
 * Formats tool parameters into a human-readable details string for the log.
 * If not provided, falls back to a generic JSON excerpt.
 */
export type AuditDetailFormatter = (tool: string, params: Record<string, unknown>) => string;

export interface AuditLoggerOptions {
  /** Service name (used in log filenames) */
  service: string;
  /** Directory for buffered log files (default: ./logs) */
  logsDir?: string;
  /** Idle time in ms before triggering a flush (default: 60000) */
  flushIdleMs?: number;
  /** Optional service-specific detail formatter */
  formatDetails?: AuditDetailFormatter;
}

// ─── Default Formatter ───────────────────────────────────────────────

function defaultFormatDetails(_tool: string, params: Record<string, unknown>): string {
  const ids = params.document_ids;
  const docs = params.documents;
  const docId = params.document_id
    || (Array.isArray(ids) ? ids[0] : undefined)
    || (Array.isArray(docs) ? docs[0] : undefined)
    || "";
  const docRef = docId ? `\`${docId}\`` : "";
  const brief = JSON.stringify(params).slice(0, 120);
  return docRef ? `${docRef} ${brief}` : brief;
}

// ─── Audit Logger ────────────────────────────────────────────────────

export class AuditLogger {
  private readonly logFile: string;
  private readonly service: string;
  private readonly flushIdleMs: number;
  private readonly formatDetails: AuditDetailFormatter;

  private flushTimer: ReturnType<typeof setTimeout> | null = null;
  private flushTimerFired = false;
  private currentUser = "unknown";
  private sessionStart = "";
  private hasEntries = false;

  constructor(options: AuditLoggerOptions) {
    this.service = options.service;
    this.flushIdleMs = options.flushIdleMs ?? 60_000;
    this.formatDetails = options.formatDetails ?? defaultFormatDetails;

    const logsDir = resolve(options.logsDir ?? "./logs");
    if (!existsSync(logsDir)) {
      mkdirSync(logsDir, { recursive: true });
    }
    this.logFile = resolve(logsDir, "current.md");
  }

  /** Set the current user for log entries. */
  setUser(user: string): void {
    this.currentUser = user;
  }

  /**
   * Log a write action.
   *
   * @param tool    Tool name (e.g., "rename_document")
   * @param params  Tool parameters (will be formatted via formatDetails)
   * @param result  Result summary (e.g., "✅ (120ms)" or "❌ Upload failed")
   * @param reason  Optional reason provided by the user
   */
  log(
    tool: string,
    params: Record<string, unknown>,
    result: string,
    reason?: string,
  ): void {
    const now = new Date();
    const time = now.toTimeString().slice(0, 5);

    // Start new file with header if needed
    if (!this.hasEntries) {
      this.sessionStart = now.toISOString().slice(0, 16).replace("T", " ");
      const header =
        `<!-- BCLAI_LOG_V2 -->\n` +
        `# ${this.service} Log — ${now.toISOString().slice(0, 10)} ${time} — ${this.currentUser}\n\n`;
      appendFileSync(this.logFile, header, "utf-8");
      this.hasEntries = true;
    }

    const details = this.formatDetails(tool, params);
    const reasonStr = reason || "(no reason)";
    const line = `- ${time} | ${tool} | ${details} | ${result} | ${reasonStr}\n`;
    appendFileSync(this.logFile, line, "utf-8");

    this.resetFlushTimer();
  }

  /** Check if flush is pending (called from periodic cleanup). */
  shouldFlush(): boolean {
    return this.flushTimerFired && this.hasEntries;
  }

  /**
   * Flush the current log to a remote destination and delete the local file.
   * Pass the upload function — this keeps the audit logger decoupled from
   * any specific storage backend (CenterDevice, S3, filesystem, etc.).
   */
  async flush(upload: AuditUploadFn): Promise<void> {
    if (!existsSync(this.logFile) || !this.hasEntries) return;

    this.flushTimerFired = false;
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }

    try {
      const content = readFileSync(this.logFile, "utf-8");
      if (!content.trim()) return;

      // Generate filename
      const now = new Date();
      const dateStr = now.toISOString().slice(0, 10);
      const timeStr = now.toTimeString().slice(0, 5).replace(":", "");
      const user = this.currentUser.split("@")[0] || "system";
      const filename = `${this.service}_Log_${dateStr}_${timeStr}_${user}.md`;

      await upload(content, filename);

      // Delete local file only on success
      unlinkSync(this.logFile);
      this.hasEntries = false;
    } catch {
      // Keep local file for retry on next flush
    }
  }

  /**
   * Flush any leftover log from a previous crash.
   */
  async flushLeftover(upload: AuditUploadFn): Promise<void> {
    if (existsSync(this.logFile)) {
      this.hasEntries = true;
      await this.flush(upload);
    }
  }

  private resetFlushTimer(): void {
    if (this.flushTimer) clearTimeout(this.flushTimer);
    this.flushTimer = setTimeout(() => {
      this.flushTimerFired = true;
    }, this.flushIdleMs);
  }
}
