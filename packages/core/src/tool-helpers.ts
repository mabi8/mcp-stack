/**
 * @mcp-stack/core — MCP Tool Registration Helper
 *
 * Eliminates boilerplate from MCP tool handlers. Instead of 15-20 lines
 * per tool (try/catch, JSON.stringify, error formatting), you write one line.
 *
 * Usage:
 *   const reg = createToolRegistrar(server, {
 *     logger: log,
 *     audit: auditLogger,              // optional
 *     writeTools: WRITE_TOOLS,          // Set<string> of tool names that modify data
 *     reasonRequired: REASON_REQUIRED,  // Set<string> of tools requiring a reason
 *   });
 *
 *   // Read tool — 1 line:
 *   reg.tool("search_documents", "Search...", schema, (p) => cd.searchDocuments(p));
 *
 *   // Write tool — identical syntax, but gets reason param + audit logging automatically:
 *   reg.tool("rename_document", "Rename...", schema, (p) => cd.renameDocument(p.document_id, p.filename));
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { Logger } from "./logger.js";
import type { AuditLogger } from "./audit-logger.js";

// ─── Types ───────────────────────────────────────────────────────────

/**
 * The user-supplied handler: takes zod-validated params, returns any JSON-serializable value.
 * Params are typed as `any` because zod validates them at the SDK level before the handler runs.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type ToolHandler = (params: any) => Promise<unknown> | unknown;

export interface ToolRegistrarOptions {
  logger: Logger;
  audit?: AuditLogger;
  /** Tool names that modify data (get optional/required `reason` param + audit logging) */
  writeTools?: Set<string>;
  /** Subset of writeTools where `reason` is required (not optional) */
  reasonRequired?: Set<string>;
}

export interface ToolRegistrar {
  /**
   * Register an MCP tool with automatic error handling, JSON serialization,
   * timing, logging, and (for write tools) audit logging.
   */
  tool(
    name: string,
    description: string,
    schema: Record<string, z.ZodTypeAny>,
    handler: ToolHandler,
  ): void;
}

// ─── Factory ─────────────────────────────────────────────────────────

export function createToolRegistrar(
  server: McpServer,
  options: ToolRegistrarOptions,
): ToolRegistrar {
  const { logger, audit, writeTools, reasonRequired } = options;

  return {
    tool(name, description, schema, handler) {
      const isWrite = writeTools?.has(name) ?? false;
      const isReasonRequired = reasonRequired?.has(name) ?? false;

      // For write tools, inject a `reason` param into the schema
      const finalSchema = { ...schema };
      if (isWrite) {
        finalSchema.reason = isReasonRequired
          ? z.string().describe("Why this action is being taken (required for audit trail)")
          : z.string().optional().describe("Why this action is being taken (for audit trail)");
      }

      // The wrapped handler
      const wrappedHandler = async (params: Record<string, unknown>) => {
        const start = Date.now();
        const toolLog = logger.child({ tool: name });

        // Extract reason before passing to user handler
        let reason: string | undefined;
        if (isWrite && "reason" in params) {
          reason = params.reason as string;
          // Create a copy without reason for the actual handler
          const { reason: _r, ...rest } = params;
          params = rest;
        }

        toolLog.debug("tool_input", { params });

        let resultText: string;
        let isError = false;

        try {
          const result = await handler(params);
          resultText = JSON.stringify(result, null, 2);
        } catch (e: unknown) {
          const message = e instanceof Error ? e.message : String(e);
          resultText = `Error: ${message}`;
          isError = true;

          toolLog.error("tool_error", {
            error: message,
            duration_ms: Date.now() - start,
          });
        }

        const duration = Date.now() - start;

        if (!isError) {
          toolLog.info("tool_call", {
            duration_ms: duration,
            result_size: resultText.length,
          });
        }

        // Audit log for write tools
        if (isWrite && audit) {
          const status = isError ? `❌ ${resultText.slice(0, 100)}` : "✅";
          audit.log(name, params, `${status} (${duration}ms)`, reason);
        }

        return {
          content: [{ type: "text" as const, text: resultText }],
          ...(isError ? { isError: true } : {}),
        };
      };

      server.tool(name, description, finalSchema, wrappedHandler);
    },
  };
}
