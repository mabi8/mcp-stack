/**
 * VPS Command MCP — Tool Definitions
 *
 * Tools:
 *   run_command        — Execute a command on a registered host (tier-classified)
 *   check_service      — Convenience: systemctl status + recent logs (tier 1)
 *   deploy_service     — Convenience: full deploy flow (tier 2)
 *   list_services      — List registered hosts and their services (tier 1)
 *   read_file          — Read a file from whitelisted paths (tier 1)
 *   write_file         — Write content to a file (tier 3)
 *   confirm_execution  — Confirm a pending approval for tier 2/3 commands
 */

import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Logger } from "@mcp-stack/core";
import { createToolRegistrar, type AuditLogger } from "@mcp-stack/core";
import { classify, classifySequence, type ClassifiedCommand, type Tier } from "./tier-engine.js";
import type { HostRegistry } from "./host-registry.js";
import type { SSHPool, ExecResult } from "./ssh-client.js";
import type { ApprovalStore } from "./approval-store.js";

// ─── Rate Limiter ────────────────────────────────────────────────────

class RateLimiter {
  private counts = new Map<string, { count: number; resetAt: number }>();
  private maxPerMin: number;

  constructor(maxPerMin: number) {
    this.maxPerMin = maxPerMin;
  }

  check(key: string): boolean {
    const now = Date.now();
    const entry = this.counts.get(key);

    if (!entry || now > entry.resetAt) {
      this.counts.set(key, { count: 1, resetAt: now + 60_000 });
      return true;
    }

    if (entry.count >= this.maxPerMin) return false;
    entry.count++;
    return true;
  }
}

// ─── Write Tools (for audit logging) ─────────────────────────────────

const WRITE_TOOLS = new Set([
  "run_command",
  "deploy_service",
  "confirm_execution",
  "write_file",
]);

// ─── Registration ────────────────────────────────────────────────────

export function registerTools(
  server: McpServer,
  hosts: HostRegistry,
  ssh: SSHPool,
  approvals: ApprovalStore,
  logger: Logger,
  audit: AuditLogger,
  rateLimitPerMin: number,
): void {
  const reg = createToolRegistrar(server, {
    logger,
    audit,
    writeTools: WRITE_TOOLS,
  });
  const limiter = new RateLimiter(rateLimitPerMin);

  // ── Helper: resolve and validate host ──────────────────────────

  function resolveHost(alias: string) {
    const host = hosts.get(alias);
    if (!host) {
      const available = hosts.list().map(h => h.alias).join(", ");
      throw new Error(`Unknown host '${alias}'. Available: ${available}`);
    }
    return host;
  }

  // ── Helper: execute a classified command ───────────────────────

  async function executeCommand(
    hostAlias: string,
    cmd: ClassifiedCommand,
  ): Promise<ExecResult> {
    const host = resolveHost(hostAlias);
    return ssh.exec(hostAlias, host, cmd.raw, {
      sudo: cmd.requiresSudo,
      timeoutMs: cmd.tier === 2 ? 120_000 : 30_000, // longer timeout for deploys
    });
  }

  // ── run_command ────────────────────────────────────────────────

  reg.tool(
    "run_command",
    "Execute a command on a registered VPS host. Commands are classified into tiers: " +
    "Tier 1 (read-only) executes immediately. " +
    "Tier 2 (deploy-flow) and Tier 3 (destructive) return an approval_id — " +
    "call confirm_execution to proceed.",
    {
      host: z.string().describe("Host alias from the registry (e.g., 'box')"),
      command: z.string().describe("The command to execute"),
    },
    async (params) => {
      const { host: hostAlias, command } = params;

      if (!limiter.check(hostAlias)) {
        throw new Error(`Rate limit exceeded for host '${hostAlias}'. Max ${rateLimitPerMin} commands/min.`);
      }

      const host = resolveHost(hostAlias);
      const result = classify(command, host);

      if (!result.ok) {
        return { rejected: true, error: result.error };
      }

      const cmd = result.command!;

      // Tier 1: execute immediately
      if (cmd.tier === 1) {
        const execResult = await executeCommand(hostAlias, cmd);
        return {
          tier: 1,
          executed: true,
          command: cmd.raw,
          exitCode: execResult.exitCode,
          stdout: execResult.stdout,
          stderr: execResult.stderr,
          durationMs: execResult.durationMs,
        };
      }

      // Tier 2 or 3: create approval
      const approvalId = approvals.create(hostAlias, [cmd], cmd.tier, cmd.raw);
      return {
        tier: cmd.tier,
        executed: false,
        approval_required: true,
        approval_id: approvalId,
        command: cmd.raw,
        reason: cmd.reason,
        instruction: `Call confirm_execution with approval_id '${approvalId}' to proceed. Expires in 5 minutes.`,
      };
    },
  );

  // ── check_service ─────────────────────────────────────────────

  reg.tool(
    "check_service",
    "Check the health of a service: systemctl status + last 30 log lines. " +
    "Tier 1 — executes immediately. Only works for whitelisted services.",
    {
      host: z.string().describe("Host alias"),
      service: z.string().describe("Service name (e.g., 'mcp-centerdevice')"),
    },
    async (params) => {
      const { host: hostAlias, service } = params;
      const host = resolveHost(hostAlias);

      if (!host.services.includes(service)) {
        throw new Error(`Service '${service}' not registered on host '${hostAlias}'. Available: ${host.services.join(", ")}`);
      }

      const [statusResult, logResult] = await Promise.all([
        ssh.exec(hostAlias, host, `systemctl status ${service}`, { timeoutMs: 10_000 }),
        ssh.exec(hostAlias, host, `journalctl -u ${service} --no-pager -n 30`, { timeoutMs: 10_000 }),
      ]);

      return {
        service,
        host: hostAlias,
        status: {
          exitCode: statusResult.exitCode,
          output: statusResult.stdout,
        },
        recentLogs: logResult.stdout,
      };
    },
  );

  // ── deploy_service ────────────────────────────────────────────

  reg.tool(
    "deploy_service",
    "Deploy a service: git pull → build core → build package → restart service. " +
    "Tier 2 — returns an approval_id. Call confirm_execution to proceed. " +
    "Only one deploy per host at a time.",
    {
      host: z.string().describe("Host alias"),
      service: z.string().describe("Service name to deploy"),
    },
    async (params) => {
      const { host: hostAlias, service } = params;
      const host = resolveHost(hostAlias);

      if (!host.services.includes(service)) {
        throw new Error(`Service '${service}' not registered on host '${hostAlias}'`);
      }

      // Check deploy lock
      const existingLock = approvals.getDeployLock(hostAlias);
      if (existingLock) {
        const elapsed = Math.round((Date.now() - existingLock.startedAt) / 1000);
        return {
          error: `Deploy in progress on '${hostAlias}': ${existingLock.description} (running for ${elapsed}s)`,
        };
      }

      // Build the deploy command sequence
      // Use the existing update.sh pattern
      const deployTarget = service
        .replace("mcp-", "")               // mcp-centerdevice → centerdevice
        .replace("bcl-telegram", "telegram")
        .replace("bcl-wa-bot", "wa-bot")
        .replace("log-mcp", "log");

      const description = `Deploy ${service} on ${hostAlias}: update.sh ${deployTarget}`;

      const commands: ClassifiedCommand[] = [
        {
          tier: 2,
          executable: "bash",
          args: [host.deployScript, deployTarget],
          raw: `bash ${host.deployScript} ${deployTarget}`,
          reason: "Deploy script execution",
          requiresSudo: true,
        },
      ];

      const approvalId = approvals.create(hostAlias, commands, 2, description);

      return {
        tier: 2,
        approval_required: true,
        approval_id: approvalId,
        plan: description,
        instruction: `Call confirm_execution with approval_id '${approvalId}' to proceed.`,
      };
    },
  );

  // ── confirm_execution ─────────────────────────────────────────

  reg.tool(
    "confirm_execution",
    "Confirm and execute a previously approved tier 2 or tier 3 command. " +
    "Provide the approval_id returned by run_command or deploy_service.",
    {
      approval_id: z.string().describe("The approval ID to confirm"),
    },
    async (params) => {
      const { approval_id } = params;
      const approval = approvals.consume(approval_id);

      if (!approval) {
        return { error: "Approval not found or expired. Request a new approval." };
      }

      const hostAlias = approval.hostAlias;

      // For deploy commands, acquire lock
      const isDeploy = approval.commands.some(c => c.executable === "bash" && c.args[0]?.includes("update.sh"));
      if (isDeploy) {
        const locked = approvals.acquireDeployLock(hostAlias, approval.id, approval.description);
        if (!locked) {
          return { error: `Deploy already in progress on '${hostAlias}'` };
        }
      }

      // Execute all commands sequentially
      const results: Array<{
        command: string;
        exitCode: number;
        stdout: string;
        stderr: string;
        durationMs: number;
      }> = [];

      let failed = false;

      try {
        for (const cmd of approval.commands) {
          if (failed) break;

          const execResult = await executeCommand(hostAlias, cmd);
          results.push({
            command: cmd.raw,
            exitCode: execResult.exitCode,
            stdout: execResult.stdout,
            stderr: execResult.stderr,
            durationMs: execResult.durationMs,
          });

          if (execResult.exitCode !== 0) {
            failed = true;
          }
        }
      } finally {
        if (isDeploy) {
          approvals.releaseDeployLock(hostAlias);
        }
      }

      return {
        executed: true,
        host: hostAlias,
        description: approval.description,
        success: !failed,
        results,
      };
    },
  );

  // ── list_services ─────────────────────────────────────────────

  reg.tool(
    "list_services",
    "List all registered VPS hosts and their whitelisted services. Tier 1.",
    {},
    async () => {
      return { hosts: hosts.list() };
    },
  );

  // ── read_file ─────────────────────────────────────────────────

  reg.tool(
    "read_file",
    "Read a file from a whitelisted path on a registered host. Tier 1. " +
    "Blocked paths (secrets, keys, .env) will be rejected.",
    {
      host: z.string().describe("Host alias"),
      path: z.string().describe("Absolute path to file"),
    },
    async (params) => {
      const { host: hostAlias, path } = params;
      const host = resolveHost(hostAlias);

      if (!hosts.isPathReadable(hostAlias, path)) {
        throw new Error(`Path '${path}' is not readable on host '${hostAlias}' (not in allowlist or matches blocked pattern)`);
      }

      const result = await ssh.exec(hostAlias, host, `cat ${path}`, { timeoutMs: 10_000 });

      if (result.exitCode !== 0) {
        throw new Error(`Failed to read file: ${result.stderr}`);
      }

      return {
        host: hostAlias,
        path,
        content: result.stdout,
        bytes: result.stdout.length,
      };
    },
  );

  // ── write_file ────────────────────────────────────────────────

  reg.tool(
    "write_file",
    "Write content to a file on a registered host. Tier 3 — always requires explicit approval. " +
    "Returns an approval_id; call confirm_execution to proceed.",
    {
      host: z.string().describe("Host alias"),
      path: z.string().describe("Absolute path to write"),
      content: z.string().describe("File content to write"),
    },
    async (params) => {
      const { host: hostAlias, path, content } = params;
      resolveHost(hostAlias); // validate host exists

      // Check blocked paths
      const host = resolveHost(hostAlias);
      for (const blocked of host.blockedPaths) {
        if (path.includes(blocked)) {
          throw new Error(`Path '${path}' matches blocked pattern '${blocked}'`);
        }
      }

      // Write is always tier 3 — create approval
      // The actual write will use a base64 pipe to avoid escaping issues
      const cmd: ClassifiedCommand = {
        tier: 3,
        executable: "tee",
        args: [path],
        raw: `write ${content.length} bytes to ${path}`,
        reason: "File write (tier 3 — always requires approval)",
        requiresSudo: false,
      };

      const approvalId = approvals.create(hostAlias, [cmd], 3,
        `Write ${content.length} bytes to ${path} on ${hostAlias}`);

      // Store the content in the approval for later execution
      // (We extend the command's raw field to carry it — hacky but functional)
      const approval = approvals.consume(approvalId);
      if (approval) {
        // Re-create with content embedded
        // For the actual execution, we'll base64-encode and pipe
        const b64 = Buffer.from(content).toString("base64");
        const writeCmd: ClassifiedCommand = {
          tier: 3,
          executable: "bash",
          args: ["-c", `echo '${b64}' | base64 -d > ${path}`],
          raw: `base64 -d > ${path} (${content.length} bytes)`,
          reason: "File write",
          requiresSudo: false,
        };
        const newId = approvals.create(hostAlias, [writeCmd], 3,
          `Write ${content.length} bytes to ${path} on ${hostAlias}`);

        return {
          tier: 3,
          approval_required: true,
          approval_id: newId,
          description: `Write ${content.length} bytes to ${path}`,
          instruction: `Call confirm_execution with approval_id '${newId}' to proceed.`,
        };
      }

      return { error: "Failed to create approval" };
    },
  );
}
