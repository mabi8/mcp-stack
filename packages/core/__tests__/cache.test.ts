import { describe, it, expect, vi, afterEach } from "vitest";
import { Cache } from "../src/cache.js";

describe("Cache", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("get returns undefined for missing key", () => {
    const cache = new Cache();
    expect(cache.get("nope")).toBeUndefined();
  });

  it("set + get returns the value within TTL", () => {
    const cache = new Cache();
    cache.set("key", { data: 42 }, 5000);
    expect(cache.get("key")).toEqual({ data: 42 });
  });

  it("get returns undefined after TTL expires", () => {
    vi.useFakeTimers();
    const cache = new Cache();
    cache.set("key", "value", 5000);

    expect(cache.get("key")).toBe("value");

    vi.advanceTimersByTime(6000);
    expect(cache.get("key")).toBeUndefined();
  });

  it("delete removes a specific key", () => {
    const cache = new Cache();
    cache.set("a", 1, 60_000);
    cache.set("b", 2, 60_000);

    cache.delete("a");
    expect(cache.get("a")).toBeUndefined();
    expect(cache.get("b")).toBe(2);
  });

  it("invalidatePrefix removes only matching keys", () => {
    const cache = new Cache();
    cache.set("doc:abc", "meta-abc", 60_000);
    cache.set("doc:def", "meta-def", 60_000);
    cache.set("folder:123", "folder-data", 60_000);

    const count = cache.invalidatePrefix("doc:");
    expect(count).toBe(2);
    expect(cache.get("doc:abc")).toBeUndefined();
    expect(cache.get("doc:def")).toBeUndefined();
    expect(cache.get("folder:123")).toBe("folder-data");
  });

  it("invalidatePrefix returns 0 when no keys match", () => {
    const cache = new Cache();
    cache.set("doc:abc", "data", 60_000);

    const count = cache.invalidatePrefix("user:");
    expect(count).toBe(0);
    expect(cache.get("doc:abc")).toBe("data");
  });

  it("clear removes everything", () => {
    const cache = new Cache();
    cache.set("a", 1, 60_000);
    cache.set("b", 2, 60_000);

    cache.clear();
    expect(cache.size).toBe(0);
    expect(cache.get("a")).toBeUndefined();
  });

  it("size reflects the number of entries", () => {
    const cache = new Cache();
    expect(cache.size).toBe(0);

    cache.set("a", 1, 60_000);
    cache.set("b", 2, 60_000);
    expect(cache.size).toBe(2);

    cache.delete("a");
    expect(cache.size).toBe(1);
  });

  it("overwriting a key updates the value and TTL", () => {
    vi.useFakeTimers();
    const cache = new Cache();

    cache.set("key", "old", 2000);
    cache.set("key", "new", 10000);

    vi.advanceTimersByTime(5000);
    // Old TTL (2s) would have expired, but new TTL (10s) keeps it alive
    expect(cache.get("key")).toBe("new");
  });

  it("generic type parameter works", () => {
    const cache = new Cache();
    cache.set("num", 42, 60_000);

    const val = cache.get<number>("num");
    expect(val).toBe(42);
  });
});
