/**
 * Approval Store — in-memory approval IDs with expiry + deploy locks
 *
 * When a tier 2 or tier 3 command is classified, an approval request is created
 * with an ID. The user confirms by calling confirm_execution with that ID.
 * IDs expire after 5 minutes.
 *
 * Deploy locks prevent concurrent deploys to the same host. Only one deploy
 * sequence can run at a time per host.
 */

import crypto from "node:crypto";
import type { ClassifiedCommand } from "./tier-engine.js";

// ─── Types ───────────────────────────────────────────────────────────

export interface PendingApproval {
  id: string;
  hostAlias: string;
  commands: ClassifiedCommand[];
  tier: number;
  createdAt: number;
  expiresAt: number;
  description: string;        // human-readable summary of what will happen
}

export interface DeployLock {
  hostAlias: string;
  approvalId: string;
  startedAt: number;
  description: string;
}

// ─── Store ───────────────────────────────────────────────────────────

const APPROVAL_TTL = 5 * 60 * 1000; // 5 minutes
const DEPLOY_LOCK_TTL = 10 * 60 * 1000; // 10 min max for a deploy

export class ApprovalStore {
  private pending = new Map<string, PendingApproval>();
  private deployLocks = new Map<string, DeployLock>(); // host alias → lock

  constructor() {
    // Cleanup expired approvals and stale deploy locks
    setInterval(() => this.cleanup(), 30_000);
  }

  /**
   * Create a new pending approval.
   * Returns the approval ID.
   */
  create(
    hostAlias: string,
    commands: ClassifiedCommand[],
    tier: number,
    description: string,
  ): string {
    const id = crypto.randomBytes(8).toString("hex");
    const now = Date.now();

    this.pending.set(id, {
      id,
      hostAlias,
      commands,
      tier,
      createdAt: now,
      expiresAt: now + APPROVAL_TTL,
      description,
    });

    return id;
  }

  /**
   * Consume an approval — returns it and deletes it.
   * Returns null if expired or not found.
   */
  consume(id: string): PendingApproval | null {
    const approval = this.pending.get(id);
    if (!approval) return null;

    if (Date.now() > approval.expiresAt) {
      this.pending.delete(id);
      return null;
    }

    this.pending.delete(id);
    return approval;
  }

  /**
   * Check if there's an active deploy lock for a host.
   */
  getDeployLock(hostAlias: string): DeployLock | null {
    const lock = this.deployLocks.get(hostAlias);
    if (!lock) return null;

    // Check if lock is stale
    if (Date.now() - lock.startedAt > DEPLOY_LOCK_TTL) {
      this.deployLocks.delete(hostAlias);
      return null;
    }

    return lock;
  }

  /**
   * Acquire a deploy lock for a host.
   * Returns false if already locked.
   */
  acquireDeployLock(hostAlias: string, approvalId: string, description: string): boolean {
    if (this.getDeployLock(hostAlias)) return false;

    this.deployLocks.set(hostAlias, {
      hostAlias,
      approvalId,
      startedAt: Date.now(),
      description,
    });
    return true;
  }

  /**
   * Release a deploy lock.
   */
  releaseDeployLock(hostAlias: string): void {
    this.deployLocks.delete(hostAlias);
  }

  private cleanup(): void {
    const now = Date.now();

    for (const [id, approval] of this.pending) {
      if (now > approval.expiresAt) this.pending.delete(id);
    }

    for (const [alias, lock] of this.deployLocks) {
      if (now - lock.startedAt > DEPLOY_LOCK_TTL) this.deployLocks.delete(alias);
    }
  }
}
