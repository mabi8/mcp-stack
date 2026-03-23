/**
 * Host Registry — loads host configuration from hosts.json
 *
 * Each host defines:
 *   - SSH connection details (hostname, port, username)
 *   - Whitelisted services, repos, readable paths
 *   - Blocked path patterns (secrets, keys, etc.)
 *   - Deploy script path (systemd hosts) or deploy command (docker hosts)
 *   - Host type: "systemd" (default) or "docker"
 */

import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));

// ─── Types ───────────────────────────────────────────────────────────

export type HostType = "systemd" | "docker";

export interface HostConfig {
  hostname: string;
  port: number;
  username: string;
  services: string[];
  repos: Record<string, string>;            // name → absolute path
  readablePaths: string[];
  blockedPaths: string[];                    // substring patterns
  deployScript: string;                      // systemd hosts: path to update.sh
  hostType: HostType;                        // "systemd" (default) or "docker"
  deployCommand?: string;                    // docker hosts: e.g. "cd /opt/outline && docker compose pull && docker compose up -d"
  systemdServices?: string[];                // docker hosts: services to check via systemctl instead of docker inspect
}

export interface HostsFile {
  hosts: Record<string, HostConfig>;
}

// ─── Registry ────────────────────────────────────────────────────────

export class HostRegistry {
  private hosts: Map<string, HostConfig>;

  constructor(configPath?: string) {
    const file = configPath || resolve(__dirname, "..", "hosts.json");
    const raw = JSON.parse(readFileSync(file, "utf-8")) as HostsFile;

    // Normalize: apply defaults for optional fields
    const entries = Object.entries(raw.hosts).map(([alias, h]) => {
      const normalized: HostConfig = {
        ...h,
        hostType: h.hostType || "systemd",
        deployScript: h.deployScript || "",
        deployCommand: h.deployCommand || undefined,
      };
      return [alias, normalized] as [string, HostConfig];
    });

    this.hosts = new Map(entries);
  }

  get(alias: string): HostConfig | undefined {
    return this.hosts.get(alias);
  }

  list(): Array<{ alias: string; hostname: string; services: string[]; hostType: HostType }> {
    return Array.from(this.hosts.entries()).map(([alias, h]) => ({
      alias,
      hostname: h.hostname,
      services: h.services,
      hostType: h.hostType,
    }));
  }

  /** Check if a service is registered on a given host */
  hasService(alias: string, service: string): boolean {
    const host = this.hosts.get(alias);
    return host?.services.includes(service) ?? false;
  }

  /** Get the repo path for a given host + repo name */
  getRepoPath(alias: string, repo: string): string | undefined {
    const host = this.hosts.get(alias);
    return host?.repos[repo];
  }

  /** Check if a path is readable (not blocked) on a given host */
  isPathReadable(alias: string, path: string): boolean {
    const host = this.hosts.get(alias);
    if (!host) return false;

    // Check blocked patterns first
    for (const blocked of host.blockedPaths) {
      if (path.includes(blocked)) return false;
    }

    // Check if path is under any readable prefix
    for (const allowed of host.readablePaths) {
      if (path.startsWith(allowed)) return true;
    }

    return false;
  }

  get size(): number {
    return this.hosts.size;
  }
}
