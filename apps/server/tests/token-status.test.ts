import { describe, expect, it, vi } from "vitest";

import type { TokenStatusCheck } from "../src/auth.js";
import {
  RemoteTokenStatusVerifier,
  createRemoteTokenStatusVerifier,
  normalizeRemoteStatus,
} from "../src/token-status.js";

const check: TokenStatusCheck = {
  jti: "jti-1",
  tokenId: "jti-1",
  subject: "owner-1",
  ownerId: "owner-1",
  tenantId: "tenant-1",
  issuer: "https://issuer.example",
  audience: ["agent-farm"],
  resource: ["https://agent-farm.example"],
  expiresAt: 1_900_000_000,
  expectedResource: "https://agent-farm.example",
};

function response(status: number, body: unknown, headers: Record<string, string> = { "content-type": "application/json" }): Response {
  return new Response(typeof body === "string" ? body : JSON.stringify(body), { status, headers });
}

describe("remote token status verifier", () => {
  it("sends only normalized status input and a dedicated service bearer", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async (_url, init) => {
      expect(init?.headers).toMatchObject({
        authorization: "Bearer status-service-secret",
        "content-type": "application/json",
      });
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      expect(body).toEqual(expect.objectContaining({ jti: "jti-1", subject: "owner-1" }));
      expect(body).not.toHaveProperty("token");
      expect(body).not.toHaveProperty("claims");
      expect(body).not.toHaveProperty("rawBearer");
      return response(200, { status: "active" });
    });
    const verifier = createRemoteTokenStatusVerifier({
      endpoint: "https://status.example/check",
      bearerSecret: "status-service-secret",
      fetchImpl,
    });

    const result = await verifier({
      ...check,
      token: "raw-bearer-must-not-cross-boundary",
      claims: { secret: "must-not-cross-boundary" },
    } as TokenStatusCheck & Record<string, unknown>);

    expect(result).toBe("active");
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it.each(["active", "revoked", "replayed", "unknown"] as const)("accepts safe status %s", async (status) => {
    const verifier = new RemoteTokenStatusVerifier({
      endpoint: "https://status.example/check",
      secret: "status-secret",
      fetchImpl: vi.fn(async () => response(200, { status })),
    });
    await expect(verifier.check(check)).resolves.toBe(status);
  });

  it("fails closed for timeout, non-JSON, non-success, and malformed responses", async () => {
    const timeout = new RemoteTokenStatusVerifier({
      endpoint: "https://status.example/check",
      secret: "status-secret",
      timeoutMs: 50,
      fetchImpl: vi.fn((_url, init) => new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
      })),
    });
    await expect(timeout.check(check)).resolves.toBe("unknown");

    for (const fetchImpl of [
      vi.fn(async () => response(200, { status: "active" }, { "content-type": "text/plain" })),
      vi.fn(async () => response(503, { status: "active" })),
      vi.fn(async () => response(200, "not-json")),
    ]) {
      const verifier = new RemoteTokenStatusVerifier({ endpoint: "https://status.example/check", secret: "status-secret", fetchImpl });
      await expect(verifier.check(check)).resolves.toBe("unknown");
    }
  });

  it("rejects oversized response bodies without parsing them", async () => {
    const fetchImpl = vi.fn(async () => response(200, { status: "active", padding: "x".repeat(2_000) }));
    const verifier = new RemoteTokenStatusVerifier({
      endpoint: "https://status.example/check",
      secret: "status-secret",
      maxResponseBytes: 256,
      fetchImpl,
    });
    await expect(verifier.check(check)).resolves.toBe("unknown");
  });

  it("rejects insecure endpoints and unknown status values", () => {
    expect(() => new RemoteTokenStatusVerifier({ endpoint: "http://status.example/check", secret: "secret" })).toThrow(/HTTPS/iu);
    expect(normalizeRemoteStatus({ status: "maybe" })).toBe("unknown");
    expect(normalizeRemoteStatus({ status: "active", token: "never-trusted" })).toBe("active");
  });
});
