import { describe, expect, it } from "vitest";
import { Decimal } from "decimal.js";
import {
  CANONICAL_FIELD_ORDER,
  canonicalise,
  SCHEMA_ID,
  serialiseRecord,
  signingMessage,
  tradeDigest,
  validateSignedRecord,
  validateTrade,
} from "../src/schema.js";
import { SchemaError } from "../src/errors.js";
import { signTrade } from "../src/signing.js";
import { testKey, testTrade } from "./fixtures.js";

describe("canonicalisation", () => {
  it("emits the 17 fields in the documented order with no whitespace", () => {
    const json = canonicalise(testTrade());
    expect(json).not.toMatch(/\s/);
    const keys = [...json.matchAll(/"([a-z_]+)":/g)].map((m) => m[1]);
    expect(keys).toEqual([...CANONICAL_FIELD_ORDER]);
  });

  it("is independent of the key order of the input object", () => {
    const a = testTrade();
    const reversed = Object.fromEntries(
      Object.entries(a).reverse(),
    ) as unknown as typeof a;
    expect(canonicalise(reversed)).toBe(canonicalise(a));
  });

  it("is stable across repeated calls", () => {
    const trade = testTrade();
    expect(tradeDigest(trade)).toBe(tradeDigest(structuredClone(trade)));
  });

  it("prefixes the signing message with the schema domain", () => {
    const trade = testTrade();
    expect(signingMessage(trade).toString("utf8")).toBe(
      `${SCHEMA_ID}:${canonicalise(trade)}`,
    );
  });

  it("writes large timestamps in plain decimal, never exponent form", () => {
    const json = canonicalise(testTrade({ close_timestamp: 1785603600000 }));
    expect(json).toContain('"close_timestamp":1785603600000');
    expect(json).not.toContain("e+");
  });

  it("escapes strings the way JSON does", () => {
    const json = canonicalise(testTrade({ strategy_id: 'quote"and\\slash' }));
    expect(json).toContain('"strategy_id":"quote\\"and\\\\slash"');
    expect(() => JSON.parse(json)).not.toThrow();
  });
});

describe("decimal precision", () => {
  it("survives a round trip that a float would destroy", () => {
    // 0.1 + 0.2 !== 0.3 in binary floating point, and this size has 17
    // significant digits — Number() would silently change both.
    const trade = testTrade({
      size: "0.30000000000000004",
      entry_price: "184.370000000000001",
      pnl: "-0.000000000000000001",
    });
    const record = JSON.parse(canonicalise(trade));
    expect(record.size).toBe("0.30000000000000004");
    expect(record.entry_price).toBe("184.370000000000001");
    expect(record.pnl).toBe("-0.000000000000000001");
    expect(new Decimal(record.entry_price).toString()).toBe("184.370000000000001");
  });

  it("does not normalise values: trailing zeros are the venue's, not ours", () => {
    const json = canonicalise(testTrade({ entry_price: "184.3700" }));
    expect(json).toContain('"entry_price":"184.3700"');
  });

  it("rejects numbers where a decimal string is required", () => {
    expect(() => validateTrade(testTrade({ entry_price: 184.37 as never }))).toThrow(
      SchemaError,
    );
    expect(() => validateTrade(testTrade({ pnl: 0 as never }))).toThrow(/lose precision/);
  });

  it("rejects malformed decimal strings", () => {
    for (const bad of ["", "1.2.3", "1e5", "0x10", " 1.0", "1.", "+1.0", "abc"]) {
      expect(() => validateTrade(testTrade({ entry_price: bad }))).toThrow(SchemaError);
    }
  });

  it("allows a signed pnl but not a signed size", () => {
    expect(() => validateTrade(testTrade({ pnl: "-58.125" }))).not.toThrow();
    expect(() => validateTrade(testTrade({ size: "-12.5" }))).toThrow(SchemaError);
  });
});

describe("validation", () => {
  it("rejects unknown fields, because they would not be signed", () => {
    const trade = { ...testTrade(), note: "hello" } as never;
    expect(() => validateTrade(trade)).toThrow(/unknown field/);
  });

  it("rejects a schema_version other than 1", () => {
    expect(() => validateTrade(testTrade({ schema_version: 2 }))).toThrow(SchemaError);
  });

  it("rejects a close before the open", () => {
    expect(() =>
      validateTrade(
        testTrade({ open_timestamp: 1785603600000, close_timestamp: 1785600000000 }),
      ),
    ).toThrow(/close_timestamp must not be earlier/);
  });

  it("rejects timestamps in seconds", () => {
    // 1785603600 is a valid millisecond value — it just means 1970. Without a
    // lower bound this mistake would be signed into the ledger forever.
    expect(() =>
      validateTrade(testTrade({ open_timestamp: 1785600000, close_timestamp: 1785603600 })),
    ).toThrow(/looks like seconds/);
  });

  it("rejects timestamps in microseconds", () => {
    expect(() => validateTrade(testTrade({ close_timestamp: 1785603600000000 }))).toThrow(
      /looks like microseconds/,
    );
  });

  it("rejects a negative or fractional sequence", () => {
    expect(() => validateTrade(testTrade({ sequence: -1 }))).toThrow(SchemaError);
    expect(() => validateTrade(testTrade({ sequence: 1.5 }))).toThrow(SchemaError);
  });

  it("accepts sequence 0", () => {
    expect(validateTrade(testTrade({ sequence: 0 })).sequence).toBe(0);
  });

  it("rejects a side that is not long or short", () => {
    expect(() => validateTrade(testTrade({ side: "flat" as never }))).toThrow(SchemaError);
  });
});

describe("the uploaded envelope", () => {
  it("round trips through serialise and validate", () => {
    const record = signTrade(testTrade(), testKey());
    const parsed = validateSignedRecord(JSON.parse(serialiseRecord(record)));
    expect(parsed).toEqual(record);
  });

  it("serialises deterministically, so a retry produces identical bytes", () => {
    const record = signTrade(testTrade(), testKey());
    expect(serialiseRecord(record)).toBe(serialiseRecord(structuredClone(record)));
  });

  it("rejects an envelope whose signature key does not match the owner", () => {
    const record = signTrade(testTrade(), testKey());
    record.signature.public_key = testKey(9).publicKey;
    expect(() => validateSignedRecord(record)).toThrow(/does not match trade.owner/);
  });

  it("rejects an unsupported signature scheme", () => {
    const record = signTrade(testTrade(), testKey());
    (record.signature as { scheme: string }).scheme = "secp256k1";
    expect(() => validateSignedRecord(record)).toThrow(/unsupported signature scheme/);
  });
});
