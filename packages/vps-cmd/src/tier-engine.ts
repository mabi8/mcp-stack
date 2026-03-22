/**
 * Tier Engine — command parser + permission classifier
 *
 * Parses raw command strings into tokens (no shell interpretation),
 * classifies them into permission tiers, and validates against host allowlists.
 *
 * Tier 1: Auto-execute (read-only, safe)
 * Tier 2: Execute after "deploy" approval (scoped writes)
 * Tier 3: Always ask (destructive/sensitive)
 *
 * Security: Commands run via execFile (no sh -c), so shell metacharacters
 * (pipes, redirects, semicolons, backticks, $()) are rejected at parse time.
 */

import type { HostConfig } from "./host-registry.js";

// ─── Types ───────────────────────────────────────────────────────────

export type Tier = 1 | 2 | 3;

export interface ClassifiedCommand {
  tier: Tier;
  executable: string;
  args: string[];
  raw: string;
  reason: string;              // human-readable explanation of classification
  requiresSudo: boolean;
}

export interface ClassificationResult {
  ok: boolean;
  command?: ClassifiedCommand;
  error?: string;              // why it was rejected outright
}

// ─── Shell Metacharacter Detection ───────────────────────────────────

const SHELL_METACHAR = /[;|&`$(){}\\<>!\n\r]/;
const DANGEROUS_PATTERNS = [
  /\beval\b/,
  /\bexec\b/,
  /\bsource\b/,
  /\b\.\s+\//,                // . /path (source shorthand)
  />\s*>/,                     // >> redirect
  /<<</,                       // heredoc
];

function containsShellMeta(raw: string): boolean {
  if (SHELL_METACHAR.test(raw)) return true;
  for (const pat of DANGEROUS_PATTERNS) {
    if (pat.test(raw)) return true;
  }
  return false;
}

// ─── Tokenizer ───────────────────────────────────────────────────────

/**
 * Simple tokenizer that handles quoted strings but rejects shell metacharacters.
 * Not a full shell parser — intentionally limited.
 */
function tokenize(raw: string): string[] {
  const tokens: string[] = [];
  let current = "";
  let inQuote: string | null = null;

  for (let i = 0; i < raw.length; i++) {
    const ch = raw[i];

    if (inQuote) {
      if (ch === inQuote) {
        inQuote = null;
      } else {
        current += ch;
      }
    } else if (ch === '"' || ch === "'") {
      inQuote = ch;
    } else if (ch === " " || ch === "\t") {
      if (current) {
        tokens.push(current);
        current = "";
      }
    } else {
      current += ch;
    }
  }

  if (current) tokens.push(current);
  return tokens;
}

// ─── Tier 1 Rules (Read-Only) ────────────────────────────────────────

interface Tier1Rule {
  cmd: string;
  validator: (args: string[], host: HostConfig) => string | null; // null = ok, string = rejection reason
}

const TIER1_RULES: Tier1Rule[] = [
  {
    cmd: "journalctl",
    validator: (args, host) => {
      const uIdx = args.indexOf("-u");
      if (uIdx === -1 || !args[uIdx + 1]) return "journalctl requires -u <service>";
      const service = args[uIdx + 1];
      if (!host.services.includes(service)) return `Service '${service}' not in host allowlist`;
      // Must have --no-pager
      if (!args.includes("--no-pager")) return "journalctl requires --no-pager flag";
      // Check line limit
      const nIdx = args.indexOf("-n");
      if (nIdx !== -1) {
        const n = parseInt(args[nIdx + 1], 10);
        if (isNaN(n) || n > 500) return "Max 500 lines for journalctl";
      }
      return null;
    },
  },
  {
    cmd: "systemctl",
    validator: (args, host) => {
      if (args[0] !== "status") return null; // only 'status' is tier 1
      const service = args[1];
      if (!service) return "systemctl status requires a service name";
      if (!host.services.includes(service)) return `Service '${service}' not in host allowlist`;
      return null;
    },
  },
  {
    cmd: "git",
    validator: (args, host) => {
      // Allow: git -C <path> log|status|diff [...]
      if (args[0] === "-C") {
        const path = args[1];
        if (!path) return "git -C requires a path";
        const repoPaths = Object.values(host.repos);
        if (!repoPaths.some(rp => path.startsWith(rp))) return `Path '${path}' not in repo allowlist`;
        const subCmd = args[2];
        if (!["log", "status", "diff", "branch", "show"].includes(subCmd)) return null; // non-tier1 git falls through
        return null;
      }
      return null; // non -C form is not tier 1
    },
  },
  {
    cmd: "cat",
    validator: (args, host) => {
      const path = args[0];
      if (!path) return "cat requires a file path";
      // Check readability via host config
      const repoPaths = Object.values(host.repos);
      const allReadable = [...host.readablePaths, ...repoPaths];
      const isAllowed = allReadable.some(rp => path.startsWith(rp));
      if (!isAllowed) return `Path '${path}' not readable on this host`;
      // Check blocked patterns
      for (const blocked of host.blockedPaths) {
        if (path.includes(blocked)) return `Path '${path}' matches blocked pattern '${blocked}'`;
      }
      return null;
    },
  },
  { cmd: "ls",      validator: () => null },
  { cmd: "df",      validator: () => null },
  { cmd: "free",    validator: () => null },
  { cmd: "uptime",  validator: () => null },
  { cmd: "whoami",  validator: () => null },
  { cmd: "hostname",validator: () => null },
  { cmd: "date",    validator: () => null },
  { cmd: "head",    validator: (args, host) => {
    const path = args.find(a => !a.startsWith("-"));
    if (!path) return "head requires a file path";
    for (const blocked of host.blockedPaths) {
      if (path.includes(blocked)) return `Path '${path}' matches blocked pattern`;
    }
    return null;
  }},
  { cmd: "tail",    validator: (args, host) => {
    const path = args.find(a => !a.startsWith("-"));
    if (!path) return "tail requires a file path";
    for (const blocked of host.blockedPaths) {
      if (path.includes(blocked)) return `Path '${path}' matches blocked pattern`;
    }
    return null;
  }},
  { cmd: "wc",      validator: () => null },
  { cmd: "du",      validator: () => null },
  { cmd: "curl",    validator: (args) => {
    // Only allow localhost health checks
    const url = args.find(a => a.startsWith("http"));
    if (!url) return "curl requires a URL";
    if (!url.startsWith("http://localhost") && !url.startsWith("http://127.0.0.1")) {
      return "curl only allowed for localhost health checks";
    }
    return null;
  }},
  { cmd: "docker",  validator: (args) => {
    // Bare docker read commands: ps, logs, inspect, stats
    if (["ps", "logs", "inspect", "stats"].includes(args[0])) return null;
    // docker compose read commands: compose ps, compose logs
    if (args[0] === "compose" && ["ps", "logs"].includes(args[1])) return null;
    // Everything else (compose pull/up/down, run, exec, etc.) falls through to tier 2/3
    return null;
  }},
  { cmd: "npm",     validator: (args) => {
    if (args[0] === "test") return null;
    if (args[0] === "run" && args.some(a => a.includes("dry-run"))) return null;
    return null; // other npm commands fall through
  }},
];

// ─── Tier 2 Rules (Scoped Writes — Deploy Flow) ─────────────────────

const TIER2_COMMANDS = new Set(["git pull", "npm install", "npm run build", "systemctl restart"]);

function isTier2(executable: string, args: string[], host: HostConfig): { match: boolean; requiresSudo: boolean } {
  const fullCmd = `${executable} ${args[0] || ""}`.trim();

  if (fullCmd === "git pull") {
    // Must be in a whitelisted repo
    if (args.includes("-C")) {
      const pathIdx = args.indexOf("-C") + 1;
      const path = args[pathIdx];
      if (!Object.values(host.repos).some(rp => path?.startsWith(rp))) {
        return { match: false, requiresSudo: false };
      }
    }
    return { match: true, requiresSudo: false };
  }

  if (executable === "npm" && ["install", "ci"].includes(args[0])) {
    return { match: true, requiresSudo: false };
  }

  if (executable === "npm" && args[0] === "run" && args[1] === "build") {
    return { match: true, requiresSudo: false };
  }

  if (fullCmd === "systemctl restart") {
    const service = args[1];
    if (service && host.services.includes(service)) {
      return { match: true, requiresSudo: true };
    }
  }

  // Deploy script
  if (executable === "bash" && args[0] === host.deployScript) {
    return { match: true, requiresSudo: true };
  }

  // Docker compose deploy commands (pull, up)
  if (executable === "docker" && args[0] === "compose") {
    if (["pull", "up"].includes(args[1])) {
      return { match: true, requiresSudo: false }; // ops is in docker group
    }
  }

  return { match: false, requiresSudo: false };
}

// ─── Tier 3 Markers (Always Dangerous) ──────────────────────────────

const ALWAYS_TIER3 = new Set([
  "rm", "rmdir", "mv", "chmod", "chown", "chgrp",
  "iptables", "ip6tables", "ufw", "nft",
  "systemctl enable", "systemctl disable", "systemctl stop", "systemctl mask",
  "docker compose down", "docker compose rm", "docker volume",
  "nano", "vim", "vi", "sed", "awk", "tee", "dd",
  "useradd", "userdel", "usermod", "groupadd", "groupdel",
  "passwd", "chpasswd",
  "reboot", "shutdown", "halt", "poweroff",
  "mount", "umount",
  "crontab",
  "kill", "killall", "pkill",
]);

// ─── Main Classifier ────────────────────────────────────────────────

export function classify(raw: string, host: HostConfig): ClassificationResult {
  // Step 1: Reject shell metacharacters
  if (containsShellMeta(raw)) {
    return {
      ok: false,
      error: `Rejected: command contains shell metacharacters. Commands run via execFile (no shell). Pipes, redirects, semicolons, backticks not supported.`,
    };
  }

  // Step 2: Tokenize
  const tokens = tokenize(raw.trim());
  if (tokens.length === 0) {
    return { ok: false, error: "Empty command" };
  }

  const executable = tokens[0];
  const args = tokens.slice(1);

  // Step 3: Check if always tier 3
  const fullCmdCheck = `${executable} ${args[0] || ""}`.trim();
  const fullCmdCheck3 = args.length >= 2 ? `${executable} ${args[0]} ${args[1]}` : "";
  if (ALWAYS_TIER3.has(executable) || ALWAYS_TIER3.has(fullCmdCheck) || (fullCmdCheck3 && ALWAYS_TIER3.has(fullCmdCheck3))) {
    return {
      ok: true,
      command: {
        tier: 3,
        executable,
        args,
        raw,
        reason: `'${executable}' is classified as destructive/sensitive (tier 3 — always requires explicit approval)`,
        requiresSudo: ["iptables", "ip6tables", "ufw", "nft", "reboot", "shutdown", "mount", "umount",
                       "useradd", "userdel", "usermod", "groupadd", "groupdel", "passwd"].includes(executable),
      },
    };
  }

  // Step 4: Check tier 1 rules
  const tier1Rule = TIER1_RULES.find(r => r.cmd === executable);
  if (tier1Rule) {
    const rejection = tier1Rule.validator(args, host);
    if (rejection === null) {
      // Matched tier 1 — but verify the specific subcommand is actually read-only
      // For systemctl, only 'status' is tier 1
      if (executable === "systemctl" && args[0] !== "status") {
        // Falls through to tier 2/3 check
      }
      // For git, only specific subcommands are tier 1
      else if (executable === "git") {
        const subCmd = args[0] === "-C" ? args[2] : args[0];
        if (!["log", "status", "diff", "branch", "show"].includes(subCmd)) {
          // Falls through
        } else {
          return {
            ok: true,
            command: { tier: 1, executable, args, raw, reason: `Read-only command (tier 1)`, requiresSudo: false },
          };
        }
      }
      // For npm, only test and dry-run are tier 1
      else if (executable === "npm") {
        if (args[0] === "test" || args.some(a => a.includes("dry-run"))) {
          return {
            ok: true,
            command: { tier: 1, executable, args, raw, reason: `Read-only command (tier 1)`, requiresSudo: false },
          };
        }
        // Falls through to tier 2
      }
      // For docker, only read commands are tier 1
      else if (executable === "docker") {
        if (["ps", "logs", "inspect", "stats"].includes(args[0])) {
          return {
            ok: true,
            command: { tier: 1, executable, args, raw, reason: `Read-only docker command (tier 1)`, requiresSudo: false },
          };
        }
        // docker compose read commands
        if (args[0] === "compose" && ["ps", "logs"].includes(args[1])) {
          return {
            ok: true,
            command: { tier: 1, executable, args, raw, reason: `Read-only docker compose command (tier 1)`, requiresSudo: false },
          };
        }
        // Falls through
      }
      else {
        return {
          ok: true,
          command: { tier: 1, executable, args, raw, reason: `Read-only command (tier 1)`, requiresSudo: false },
        };
      }
    } else {
      // Tier 1 rule matched executable but rejected args — this is an error, not a fallthrough
      return { ok: false, error: rejection };
    }
  }

  // Step 5: Check tier 2
  const tier2 = isTier2(executable, args, host);
  if (tier2.match) {
    return {
      ok: true,
      command: {
        tier: 2,
        executable,
        args,
        raw,
        reason: `Deploy-flow command (tier 2 — requires 'deploy' approval)`,
        requiresSudo: tier2.requiresSudo,
      },
    };
  }

  // Step 6: Everything else is tier 3
  return {
    ok: true,
    command: {
      tier: 3,
      executable,
      args,
      raw,
      reason: `Unknown command — classified as tier 3 (requires explicit approval)`,
      requiresSudo: false,
    },
  };
}

/**
 * Classify a list of commands (e.g., a deploy sequence).
 * Returns the highest tier found across all commands.
 */
export function classifySequence(
  commands: string[],
  host: HostConfig,
): { tier: Tier; commands: ClassifiedCommand[]; errors: string[] } {
  let maxTier: Tier = 1;
  const classified: ClassifiedCommand[] = [];
  const errors: string[] = [];

  for (const raw of commands) {
    const result = classify(raw, host);
    if (!result.ok) {
      errors.push(result.error!);
    } else if (result.command) {
      classified.push(result.command);
      if (result.command.tier > maxTier) maxTier = result.command.tier;
    }
  }

  return { tier: maxTier, commands: classified, errors };
}
