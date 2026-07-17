import { describe, it, expect, beforeAll } from "vitest";
import { encryptToken, decryptToken } from "@/lib/crypto";

describe("token crypto", () => {
  beforeAll(() => {
    process.env.AUTH_SECRET = "test-secret-for-crypto-unit";
  });

  it("round-trips a token", () => {
    const t = "xoxb-1234567890-abcdefGHIJKL";
    expect(decryptToken(encryptToken(t))).toBe(t);
  });

  it("produces different ciphertext each call (random IV)", () => {
    expect(encryptToken("same")).not.toBe(encryptToken("same"));
  });

  it("rejects tampered ciphertext", () => {
    const enc = encryptToken("xoxb-secret");
    const [iv, tag, ct] = enc.split(":");
    const flipped = ct[0] === "A" ? "B" : "A";
    const bad = `${iv}:${tag}:${flipped}${ct.slice(1)}`;
    expect(() => decryptToken(bad)).toThrow();
  });

  it("throws when AUTH_SECRET is missing", () => {
    const saved = process.env.AUTH_SECRET;
    delete process.env.AUTH_SECRET;
    try {
      expect(() => encryptToken("x")).toThrow(/AUTH_SECRET/);
    } finally {
      process.env.AUTH_SECRET = saved;
    }
  });
});
