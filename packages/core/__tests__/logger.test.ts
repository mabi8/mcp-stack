import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createLogger, runWithRequestId } from "../src/logger.js";

// Capture stderr output
function captureStderr(fn: () => void): string[] {
  const lines: string[] = [];
  const original = process.stderr.write;
  process.stderr.write = ((chunk: string) => {
    lines.push(chunk.toString().trim());
    return true;
  }) as typeof process.stderr.write;
  try {
    fn();
  } finally {
    process.stderr.write = original;
  }
  return lines;
}

function parseLog(line: string): Record<string, unknown> {
  return JSON.parse(line);
}

describe("Logger", () => {
  beforeEach(() => {
    delete process.env.NODE_ENV;
    delete process.env.LOG_LEVEL;
  });

  it("outputs valid JSON with correct structure", () => {
    const log = createLogger("test-svc", "info");
    const lines = captureStderr(() => log.info("test_event", { foo: "bar" }));

    expect(lines).toHaveLength(1);
    const entry = parseLog(lines[0]);
    expect(entry.ts).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(entry.level).toBe("info");
    expect(entry.service).toBe("test-svc");
    expect(entry.event).toBe("test_event");
    expect(entry.foo).toBe("bar");
  });

  it("respects LOG_LEVEL filtering", () => {
    const log = createLogger("test-svc", "warn");

    const lines = captureStderr(() => {
      log.error("should_appear");
      log.warn("should_appear");
      log.info("should_not_appear");
      log.debug("should_not_appear");
      log.trace("should_not_appear");
    });

    expect(lines).toHaveLength(2);
    expect(parseLog(lines[0]).event).toBe("should_appear");
    expect(parseLog(lines[1]).event).toBe("should_appear");
  });

  it("trace level shows everything", () => {
    const log = createLogger("test-svc", "trace");

    const lines = captureStderr(() => {
      log.error("e");
      log.warn("w");
      log.info("i");
      log.debug("d");
      log.trace("t");
    });

    expect(lines).toHaveLength(5);
  });

  it("redacts known secret keys", () => {
    const log = createLogger("test-svc", "info");
    const lines = captureStderr(() =>
      log.info("auth", {
        access_token: "secret123",
        refresh_token: "refresh456",
        api_key: "key789",
        user: "markus", // not redacted
      }),
    );

    const entry = parseLog(lines[0]);
    expect(entry.access_token).toMatch(/\[REDACTED:/);
    expect(entry.refresh_token).toMatch(/\[REDACTED:/);
    expect(entry.api_key).toMatch(/\[REDACTED:/);
    expect(entry.user).toBe("markus");
  });

  it("redacts secrets in nested objects", () => {
    const log = createLogger("test-svc", "info");
    const lines = captureStderr(() =>
      log.info("nested", {
        session: { access_token: "abc", name: "test" },
      }),
    );

    const entry = parseLog(lines[0]);
    const session = entry.session as Record<string, unknown>;
    expect(session.access_token).toMatch(/\[REDACTED:/);
    expect(session.name).toBe("test");
  });

  it("child logger inherits and extends fields", () => {
    const log = createLogger("test-svc", "info");
    const child = log.child({ tool: "search_documents" });

    const lines = captureStderr(() => child.info("called", { duration_ms: 42 }));

    const entry = parseLog(lines[0]);
    expect(entry.tool).toBe("search_documents");
    expect(entry.duration_ms).toBe(42);
    expect(entry.service).toBe("test-svc");
  });

  it("child of child merges all fields", () => {
    const log = createLogger("test-svc", "info");
    const child1 = log.child({ tool: "search" });
    const child2 = child1.child({ user: "markus" });

    const lines = captureStderr(() => child2.info("test"));

    const entry = parseLog(lines[0]);
    expect(entry.tool).toBe("search");
    expect(entry.user).toBe("markus");
  });

  it("includes request ID from AsyncLocalStorage", () => {
    const log = createLogger("test-svc", "info");

    const lines = captureStderr(() =>
      runWithRequestId("req-abc-123", () => {
        log.info("inside_context");
      }),
    );

    const entry = parseLog(lines[0]);
    expect(entry.req_id).toBe("req-abc-123");
  });

  it("does not include request ID outside of context", () => {
    const log = createLogger("test-svc", "info");
    const lines = captureStderr(() => log.info("outside_context"));

    const entry = parseLog(lines[0]);
    expect(entry.req_id).toBeUndefined();
  });

  it("exposes the configured level", () => {
    const log = createLogger("test-svc", "debug");
    expect(log.level).toBe("debug");
  });
});
