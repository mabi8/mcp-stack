import { describe, it, expect, afterEach } from "vitest";
import crypto from "node:crypto";
import { existsSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  SessionStore,
  PendingCodeStore,
  ClientRegistry,
  isAllowedRedirectUri,
  verifyPKCE,
  escapeHtml,
} from "../src/oauth.js";

describe("PKCE Verification", () => {
  it("verifies a valid S256 challenge", () => {
    const verifier = "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk";
    const challenge = crypto.createHash("sha256").update(verifier).digest("base64url");

    expect(verifyPKCE(verifier, challenge)).toBe(true);
  });

  it("rejects an incorrect verifier", () => {
    const verifier = "correct-verifier";
    const challenge = crypto.createHash("sha256").update(verifier).digest("base64url");

    expect(verifyPKCE("wrong-verifier", challenge)).toBe(false);
  });

  it("handles long random verifiers", () => {
    const verifier = crypto.randomBytes(64).toString("base64url");
    const challenge = crypto.createHash("sha256").update(verifier).digest("base64url");

    expect(verifyPKCE(verifier, challenge)).toBe(true);
  });
});

describe("Redirect URI Validation", () => {
  const allowed = ["claude.ai", "claude.com", "box.makkib.com"];

  it("accepts exact domain match", () => {
    expect(isAllowedRedirectUri("https://claude.ai/callback", allowed)).toBe(true);
  });

  it("accepts subdomain match", () => {
    expect(isAllowedRedirectUri("https://app.claude.ai/callback", allowed)).toBe(true);
  });

  it("rejects non-allowed domain", () => {
    expect(isAllowedRedirectUri("https://evil.com/callback", allowed)).toBe(false);
  });

  it("rejects partial domain match (suffix attack)", () => {
    // "notclaude.ai" should NOT match "claude.ai"
    expect(isAllowedRedirectUri("https://notclaude.ai/callback", allowed)).toBe(false);
  });

  it("rejects invalid URLs", () => {
    expect(isAllowedRedirectUri("not-a-url", allowed)).toBe(false);
  });

  it("handles empty allowed list", () => {
    expect(isAllowedRedirectUri("https://claude.ai/callback", [])).toBe(false);
  });
});

describe("SessionStore", () => {
  it("create returns valid token response", () => {
    const store = new SessionStore();
    const response = store.create("client_123");

    expect(response.access_token).toHaveLength(64); // 32 bytes hex
    expect(response.refresh_token).toHaveLength(64);
    expect(response.token_type).toBe("bearer");
    expect(response.expires_in).toBe(86400);
    expect(response.scope).toBe("mcp");
  });

  it("get returns session by access token", () => {
    const store = new SessionStore();
    const { access_token } = store.create("client_123", { user: "markus" });

    const session = store.get(access_token);
    expect(session).not.toBeNull();
    expect(session?.mcpClientId).toBe("client_123");
    expect(session?.data.user).toBe("markus");
  });

  it("get returns null for unknown token", () => {
    const store = new SessionStore();
    expect(store.get("nonexistent")).toBeNull();
  });

  it("get returns null for expired session", () => {
    const store = new SessionStore({ tokenLifetimeSec: 0 }); // expires immediately
    const { access_token } = store.create("client_123");

    // Session was created with 0s lifetime, already expired
    expect(store.get(access_token)).toBeNull();
  });

  it("findByRefresh locates session", () => {
    const store = new SessionStore();
    const { refresh_token } = store.create("client_123");

    const session = store.findByRefresh(refresh_token);
    expect(session).toBeDefined();
    expect(session?.mcpClientId).toBe("client_123");
  });

  it("refresh rotates tokens and preserves data", () => {
    const store = new SessionStore();
    const original = store.create("client_123", { cdToken: "abc" });
    const oldSession = store.get(original.access_token)!;

    const refreshed = store.refresh(oldSession);
    expect(refreshed).not.toBeNull();
    expect(refreshed!.access_token).not.toBe(original.access_token);
    expect(refreshed!.refresh_token).not.toBe(original.refresh_token);

    // Old token should be invalid
    expect(store.get(original.access_token)).toBeNull();
    // New token should work
    const newSession = store.get(refreshed!.access_token);
    expect(newSession?.data.cdToken).toBe("abc");
  });

  it("delete removes session", () => {
    const store = new SessionStore();
    const { access_token } = store.create("client_123");

    store.delete(access_token);
    expect(store.get(access_token)).toBeNull();
    expect(store.size).toBe(0);
  });

  afterEach(() => {
    // SessionStore creates intervals — clean up
    // (In real code, call store.destroy())
  });
});

describe("PendingCodeStore", () => {
  it("create and consume returns the pending code data", () => {
    const store = new PendingCodeStore();
    const code = store.create({
      clientId: "client_123",
      codeChallenge: "challenge",
      data: { cdTokens: "abc" },
    });

    const consumed = store.consume(code, "client_123");
    expect(consumed).not.toBeNull();
    expect(consumed?.clientId).toBe("client_123");
    expect(consumed?.codeChallenge).toBe("challenge");
    expect(consumed?.data.cdTokens).toBe("abc");
  });

  it("consume returns null for wrong client_id", () => {
    const store = new PendingCodeStore();
    const code = store.create({ clientId: "client_123", data: {} });

    expect(store.consume(code, "wrong_client")).toBeNull();
  });

  it("consume returns null on second use (codes are single-use)", () => {
    const store = new PendingCodeStore();
    const code = store.create({ clientId: "client_123", data: {} });

    store.consume(code, "client_123"); // first use
    expect(store.consume(code, "client_123")).toBeNull(); // second use
  });

  it("consume returns null for expired code", () => {
    const store = new PendingCodeStore();
    const code = store.create({ clientId: "client_123", data: {} }, 0); // 0ms TTL

    expect(store.consume(code, "client_123")).toBeNull();
  });
});

describe("ClientRegistry", () => {
  it("register and get works", () => {
    const registry = new ClientRegistry();
    const { clientId, clientSecret } = registry.register(["https://claude.ai/callback"]);

    const client = registry.get(clientId);
    expect(client).toBeDefined();
    expect(client?.clientSecret).toBe(clientSecret);
    expect(client?.redirectUris).toEqual(["https://claude.ai/callback"]);
  });

  it("validate succeeds with correct secret", () => {
    const registry = new ClientRegistry();
    const { clientId, clientSecret } = registry.register(["https://claude.ai/callback"]);

    expect(registry.validate(clientId, clientSecret)).toBe(true);
  });

  it("validate fails with wrong secret", () => {
    const registry = new ClientRegistry();
    const { clientId } = registry.register(["https://claude.ai/callback"]);

    expect(registry.validate(clientId, "wrong")).toBe(false);
  });

  it("validate fails for unknown client", () => {
    const registry = new ClientRegistry();
    expect(registry.validate("unknown_client")).toBe(false);
  });

  it("persists clients to disk and reloads on new instance", () => {
    const file = join(tmpdir(), `clients-test-${Date.now()}.json`);
    try {
      const registry1 = new ClientRegistry({ file });
      const { clientId, clientSecret } = registry1.register(["https://claude.ai/callback"]);
      expect(registry1.size).toBe(1);

      // New instance from same file should recover the client
      const registry2 = new ClientRegistry({ file });
      expect(registry2.size).toBe(1);
      expect(registry2.validate(clientId, clientSecret)).toBe(true);
      expect(registry2.get(clientId)?.redirectUris).toEqual(["https://claude.ai/callback"]);
    } finally {
      if (existsSync(file)) unlinkSync(file);
    }
  });

  it("works in-memory when no file is given", () => {
    const registry = new ClientRegistry();
    const { clientId, clientSecret } = registry.register(["https://claude.ai/callback"]);
    expect(registry.validate(clientId, clientSecret)).toBe(true);
    expect(registry.size).toBe(1);
  });
});

describe("escapeHtml", () => {
  it("escapes all dangerous characters", () => {
    expect(escapeHtml('<script>alert("xss")</script>')).toBe(
      "&lt;script&gt;alert(&quot;xss&quot;)&lt;/script&gt;",
    );
  });

  it("escapes ampersands", () => {
    expect(escapeHtml("a&b")).toBe("a&amp;b");
  });

  it("escapes single quotes", () => {
    expect(escapeHtml("it's")).toBe("it&#039;s");
  });
});
