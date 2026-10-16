import { describe, expect, it } from "vitest";
import { generateKey, newId, sha256Hex, timingSafeEqual } from "../src/crypto";

describe("crypto", () => {
  it("generateKey format and uniqueness", () => {
    const a = generateKey();
    expect(a).toMatch(/^amk_[A-Za-z0-9_-]{43}$/);
    expect(generateKey()).not.toBe(a);
  });

  it("sha256Hex", async () => {
    expect(await sha256Hex("abc")).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
  });

  it("timingSafeEqual", async () => {
    expect(await timingSafeEqual("a", "a")).toBe(true);
    expect(await timingSafeEqual("a", "b")).toBe(false);
    expect(await timingSafeEqual("a", "aa")).toBe(false);
  });

  it("newId is 16 lowercase hex chars", () => {
    expect(newId()).toMatch(/^[0-9a-f]{16}$/);
    expect(newId()).not.toBe(newId());
  });
});
