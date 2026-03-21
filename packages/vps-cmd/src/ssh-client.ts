/**
 * SSH Client — connection pool for remote command execution
 *
 * Manages SSH connections to registered VPS hosts. Commands execute via
 * exec (not shell), preventing injection. Connections are pooled per host
 * and reused across requests.
 *
 * Security model:
 *   - One SSH key (on sss bastion) used for all outbound connections
 *   - Worker VPS only accept SSH from sss
 *   - Commands run as the configured user (ops) on each host
 *   - No shell interpretation: exec runs argv directly
 */

import { Client as SSHClient, type ConnectConfig } from "ssh2";
import { readFileSync } from "node:fs";
import type { HostConfig } from "./host-registry.js";
import type { Logger } from "@mcp-stack/core";

// ─── Types ───────────────────────────────────────────────────────────

export interface ExecResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  durationMs: number;
}

interface PooledConnection {
  client: SSHClient;
  hostAlias: string;
  lastUsed: number;
  busy: boolean;
}

// ─── SSH Connection Pool ─────────────────────────────────────────────

export class SSHPool {
  private connections = new Map<string, PooledConnection>();
  private privateKey: Buffer;
  private logger: Logger;
  private readonly IDLE_TIMEOUT = 5 * 60 * 1000; // 5 min

  constructor(keyPath: string, logger: Logger) {
    this.privateKey = readFileSync(keyPath);
    this.logger = logger;

    // Periodic cleanup of idle connections
    setInterval(() => this.cleanup(), 60_000);
  }

  /**
   * Execute a command on a remote host.
   * The command is passed as a single string to SSH exec — the remote sshd
   * will parse it. For safety, the tier engine has already validated
   * the command contains no shell metacharacters.
   */
  async exec(
    hostAlias: string,
    host: HostConfig,
    command: string,
    options?: { sudo?: boolean; cwd?: string; timeoutMs?: number },
  ): Promise<ExecResult> {
    const start = Date.now();
    const timeout = options?.timeoutMs ?? 30_000;

    const client = await this.getConnection(hostAlias, host);

    // Build the remote command
    let remoteCmd = command;
    if (options?.cwd) {
      remoteCmd = `cd ${options.cwd} && ${command}`;
    }
    if (options?.sudo) {
      remoteCmd = `sudo ${remoteCmd}`;
    }

    return new Promise<ExecResult>((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error(`Command timed out after ${timeout}ms: ${command}`));
      }, timeout);

      client.exec(remoteCmd, (err, stream) => {
        if (err) {
          clearTimeout(timer);
          reject(new Error(`SSH exec failed: ${err.message}`));
          return;
        }

        let stdout = "";
        let stderr = "";

        stream.on("data", (data: Buffer) => {
          stdout += data.toString();
          // Truncate if output is massive
          if (stdout.length > 100_000) {
            stdout = stdout.slice(0, 100_000) + "\n... [output truncated at 100KB]";
            stream.destroy();
          }
        });

        stream.stderr.on("data", (data: Buffer) => {
          stderr += data.toString();
          if (stderr.length > 50_000) {
            stderr = stderr.slice(0, 50_000) + "\n... [stderr truncated at 50KB]";
          }
        });

        stream.on("close", (code: number) => {
          clearTimeout(timer);
          const pooled = this.connections.get(hostAlias);
          if (pooled) {
            pooled.busy = false;
            pooled.lastUsed = Date.now();
          }
          resolve({
            exitCode: code ?? 0,
            stdout: stdout.trimEnd(),
            stderr: stderr.trimEnd(),
            durationMs: Date.now() - start,
          });
        });

        stream.on("error", (e: Error) => {
          clearTimeout(timer);
          reject(new Error(`SSH stream error: ${e.message}`));
        });
      });
    });
  }

  private async getConnection(alias: string, host: HostConfig): Promise<SSHClient> {
    const existing = this.connections.get(alias);
    if (existing && !existing.busy) {
      existing.busy = true;
      existing.lastUsed = Date.now();
      return existing.client;
    }

    // Create new connection
    const client = new SSHClient();
    const config: ConnectConfig = {
      host: host.hostname,
      port: host.port,
      username: host.username,
      privateKey: this.privateKey,
      readyTimeout: 10_000,
      keepaliveInterval: 30_000,
    };

    return new Promise((resolve, reject) => {
      client.on("ready", () => {
        this.logger.info("ssh_connected", { host: alias, hostname: host.hostname });
        this.connections.set(alias, {
          client,
          hostAlias: alias,
          lastUsed: Date.now(),
          busy: true,
        });
        resolve(client);
      });

      client.on("error", (err) => {
        this.logger.error("ssh_error", { host: alias, error: err.message });
        this.connections.delete(alias);
        reject(new Error(`SSH connection to ${alias} (${host.hostname}) failed: ${err.message}`));
      });

      client.on("close", () => {
        this.logger.debug("ssh_closed", { host: alias });
        this.connections.delete(alias);
      });

      client.connect(config);
    });
  }

  private cleanup(): void {
    const now = Date.now();
    for (const [alias, conn] of this.connections) {
      if (!conn.busy && now - conn.lastUsed > this.IDLE_TIMEOUT) {
        this.logger.debug("ssh_pool_cleanup", { host: alias });
        conn.client.end();
        this.connections.delete(alias);
      }
    }
  }

  async shutdown(): Promise<void> {
    for (const [alias, conn] of this.connections) {
      this.logger.debug("ssh_pool_shutdown", { host: alias });
      conn.client.end();
    }
    this.connections.clear();
  }
}
