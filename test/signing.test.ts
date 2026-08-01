import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import bs58 from "bs58";
import { describe, expect, it } from "vitest";
import { KeyError } from "../src/errors.js";
import { loadKey, signTrade, verifyTradeSignature } from "../src/signing.js";
import { testKey, testTrade } from "./fixtures.js";

describe("signing", () => {
  it("produces a signature that verifies", () => {
    const record = signTrade(testTrade(), testKey());
    expect(verifyTradeSignature(record)).toBe(true);
  });

  it("refuses to sign a trade owned by a different key", () => {
    expect(() => signTrade(testTrade({ owner: testKey(9).publicKey }), testKey())).toThrow(
      KeyError,
    );
  });
});

describe("tamper detection", () => {
  const fields = [
    ["pnl", "580.125"],
    ["exit_price", "999.99"],
    ["size", "125.0"],
    ["sequence", 4],
    ["venue_address", "0xdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef"],
    ["close_timestamp", 1785603600001],
    ["strategy_id", "some-other-strategy"],
  ] as const;

  for (const [field, value] of fields) {
    it(`rejects a payload with ${field} altered after signing`, () => {
      const record = signTrade(testTrade(), testKey());
      (record.trade as Record<string, unknown>)[field] = value;
      expect(verifyTradeSignature(record)).toBe(false);
    });
  }

  it("rejects a signature that was not produced by the named owner", () => {
    const attacker = testKey(9);
    const record = signTrade(testTrade({ owner: attacker.publicKey }), attacker);
    // Re-label the record as belonging to the honest owner.
    record.trade.owner = testKey().publicKey;
    record.signature.public_key = testKey().publicKey;
    expect(verifyTradeSignature(record)).toBe(false);
  });

  it("rejects a garbled signature without throwing", () => {
    const record = signTrade(testTrade(), testKey());
    record.signature.value = "not-base58-!!!";
    expect(verifyTradeSignature(record)).toBe(false);
  });

  it("rejects a signature of the wrong length", () => {
    const record = signTrade(testTrade(), testKey());
    record.signature.value = bs58.encode(new Uint8Array(32));
    expect(verifyTradeSignature(record)).toBe(false);
  });
});

describe("key loading", () => {
  const dir = mkdtempSync(join(tmpdir(), "lyra-key-"));

  it("reads a solana-keygen JSON array", () => {
    const key = testKey(3);
    const secret = bs58.decode(key.irysWallet);
    const path = join(dir, "solana.json");
    writeFileSync(path, JSON.stringify([...secret]));
    expect(loadKey(path).publicKey).toBe(key.publicKey);
  });

  it("reads a base58 secret key from a file", () => {
    const key = testKey(4);
    const path = join(dir, "base58.key.json");
    writeFileSync(path, `${key.irysWallet}\n`);
    expect(loadKey(path).publicKey).toBe(key.publicKey);
  });

  it("accepts a base58 secret key passed directly", () => {
    const key = testKey(5);
    expect(loadKey(key.irysWallet).publicKey).toBe(key.publicKey);
  });

  it("accepts a bare 32-byte seed", () => {
    const key = testKey(6);
    expect(loadKey(bs58.encode(key.seed)).publicKey).toBe(key.publicKey);
  });

  it("rejects a key whose halves disagree", () => {
    const bad = new Uint8Array(64).fill(1);
    expect(() => loadKey(bs58.encode(bad))).toThrow(/does not match/);
  });

  it("rejects a key of the wrong length", () => {
    expect(() => loadKey(bs58.encode(new Uint8Array(16)))).toThrow(KeyError);
  });

  it("reports a missing file clearly", () => {
    expect(() => loadKey(join(dir, "absent.json"))).toThrow(/cannot read key file/);
  });
});
