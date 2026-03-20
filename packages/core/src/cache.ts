/**
 * @mcp-stack/core — In-memory TTL Cache
 *
 * Simple key-value store with per-key expiration.
 * No external dependencies.
 *
 * Usage:
 *   const cache = new Cache();
 *   cache.set("doc:abc123", metadata, 120_000);  // 2 min TTL
 *   const hit = cache.get<DocMetadata>("doc:abc123");
 *   cache.invalidate("doc:abc123");               // exact key
 *   cache.invalidatePrefix("doc:");               // all doc: keys
 */

export class Cache {
  private store = new Map<string, { data: unknown; expiresAt: number }>();

  /** Get a value, or undefined if missing/expired. */
  get<T = unknown>(key: string): T | undefined {
    const entry = this.store.get(key);
    if (!entry) return undefined;
    if (Date.now() > entry.expiresAt) {
      this.store.delete(key);
      return undefined;
    }
    return entry.data as T;
  }

  /** Set a value with a TTL in milliseconds. */
  set(key: string, data: unknown, ttlMs: number): void {
    this.store.set(key, { data, expiresAt: Date.now() + ttlMs });
  }

  /** Delete a specific key. */
  delete(key: string): boolean {
    return this.store.delete(key);
  }

  /** Delete a specific key (alias for delete). */
  invalidate(key: string): boolean {
    return this.store.delete(key);
  }

  /** Delete all keys matching a prefix. Returns count of deleted keys. */
  invalidatePrefix(prefix: string): number {
    let count = 0;
    for (const key of this.store.keys()) {
      if (key.startsWith(prefix)) {
        this.store.delete(key);
        count++;
      }
    }
    return count;
  }

  /** Clear everything. */
  clear(): void {
    this.store.clear();
  }

  /** Number of entries (including potentially expired ones). */
  get size(): number {
    return this.store.size;
  }
}

// Common TTL constants (milliseconds)
export const TTL = {
  SEC_30: 30_000,
  MIN_1: 60_000,
  MIN_2: 120_000,
  MIN_5: 300_000,
  MIN_10: 600_000,
  MIN_30: 1_800_000,
  HOUR_1: 3_600_000,
} as const;
