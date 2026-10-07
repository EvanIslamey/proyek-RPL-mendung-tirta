import { afterEach, describe, expect, it } from "vitest";
import { hitRateLimit, resetRateLimits } from "@/lib/rate-limit";

afterEach(() => resetRateLimits());

describe("hitRateLimit", () => {
  it("mengizinkan hingga batas lalu menolak dengan retryAfter", () => {
    for (let i = 0; i < 3; i++) {
      expect(hitRateLimit("k1", 3, 60_000).ok).toBe(true);
    }
    const denied = hitRateLimit("k1", 3, 60_000);
    expect(denied.ok).toBe(false);
    if (!denied.ok) {
      expect(denied.retryAfterSeconds).toBeGreaterThan(0);
      expect(denied.retryAfterSeconds).toBeLessThanOrEqual(60);
    }
  });

  it("bucket terpisah per key", () => {
    expect(hitRateLimit("a", 1, 60_000).ok).toBe(true);
    expect(hitRateLimit("b", 1, 60_000).ok).toBe(true);
    expect(hitRateLimit("a", 1, 60_000).ok).toBe(false);
  });

  it("window kedaluwarsa mereset hitungan", async () => {
    expect(hitRateLimit("k2", 1, 30).ok).toBe(true); // window 30ms
    expect(hitRateLimit("k2", 1, 30).ok).toBe(false);
    await new Promise((r) => setTimeout(r, 40));
    expect(hitRateLimit("k2", 1, 30).ok).toBe(true);
  });
});
