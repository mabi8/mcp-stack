/**
 * VPS Command Audit Formatter
 *
 * Formats command execution events for the audit trail.
 * Produces human-readable details for the markdown audit log.
 */

import type { AuditDetailFormatter } from "@mcp-stack/core";

export const vpsCmdAuditFormatter: AuditDetailFormatter = (
  tool: string,
  params: Record<string, unknown>,
): string => {
  const host = (params.host as string) || "?";

  switch (tool) {
    case "run_command":
      return `[${host}] \`${params.command}\``;

    case "check_service":
      return `[${host}] status ${params.service}`;

    case "deploy_service":
      return `[${host}] deploy ${params.service}`;

    case "confirm_execution":
      return `[${host}] approved ${params.approval_id}`;

    case "read_file":
      return `[${host}] read ${params.path}`;

    case "write_file":
      return `[${host}] write ${params.path} (${((params.content as string) || "").length} bytes)`;

    default: {
      const brief = JSON.stringify(params).slice(0, 120);
      return `[${host}] ${brief}`;
    }
  }
};
