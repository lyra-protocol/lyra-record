import { describe, expect, it } from "vitest";
import {
  CANONICAL_FIELD_ORDER_V1,
  CANONICAL_FIELD_ORDER_V2,
  SCHEMA_VERSION,
  SUPPORTED_VERSIONS,
  canonicalise,
  schemaIdFor,
  serialiseRecord,
  signingMessage,
  signingPrefixFor,
  validateSignedRecord,
  validateTrade,
} from "../src/schema.js";
import { SchemaError } from "../src/errors.js";
import { signTrade, verifyTradeSignature } from "../src/signing.js";
import { testKey, testTrade } from "./fixtures.js";

/**
 * The promise this file exists to keep: a record written under v1 stays
 * verifiable forever. v1 records are on Arweave and cannot be rewritten, so if a
 * later release ever failed to verify them the ledger would be broken by its own
 * library — the exact failure the schema_version field was added to prevent.
 */

/** A v1 trade, exactly as the 0.1.0 release would have produced it. */
function v1Trade(overrides: Record<string, unknown> = {}) {
  const t = { ...testTrade(), ...overrides } as Record<string, unknown>;
  delete t.reasoning_id;
  t.schema_version = 1;
  return t as never;
}

describe("v1 records stay valid", () => {
  it("validates a v1 trade that has no reasoning_id", () => {
    expect(() => validateTrade(v1Trade())).not.toThrow();
  });

  it("canonicalises v1 in the v1 field order, without reasoning_id", () => {
    const json = canonicalise(v1Trade());
    const keys = [...json.matchAll(/"([a-z_]+)":/g)].map((m) => m[1]);
    expect(keys).toEqual([...CANONICAL_FIELD_ORDER_V1]);
    expect(json).not.toContain("reasoning_id");
  });

  it("signs v1 with the v1 domain prefix", () => {
    const msg = signingMessage(v1Trade()).toString("utf8");
    expect(msg.startsWith("lyra-record/v1:")).toBe(true);
  });

  it("a signature made over v1 bytes still verifies under this release", () => {
    // This is the compatibility guarantee in one assertion.
    const record = signTrade(v1Trade(), testKey());
    expect(record.schema).toBe("lyra-record/v1");
    expect(verifyTradeSignature(record)).toBe(true);
  });

  it("round trips a v1 envelope through serialise and validate", () => {
    const record = signTrade(v1Trade(), testKey());
    expect(validateSignedRecord(JSON.parse(serialiseRecord(record)))).toEqual(record);
  });

  it("rejects a v1 trade carrying a v2 field", () => {
    const t = { ...(v1Trade() as object), reasoning_id: null } as never;
    expect(() => validateTrade(t)).toThrow(/unknown field\(s\) for schema v1/);
  });
});

describe("v2 records", () => {
  it("is the version this release writes", () => {
    expect(SCHEMA_VERSION).toBe(2);
    expect(schemaIdFor(2)).toBe("lyra-record/v2");
  });

  it("places reasoning_id between pnl and schema_version", () => {
    const json = canonicalise(testTrade());
    const keys = [...json.matchAll(/"([a-z_]+)":/g)].map((m) => m[1]);
    expect(keys).toEqual([...CANONICAL_FIELD_ORDER_V2]);
    expect(keys.indexOf("reasoning_id")).toBe(keys.indexOf("pnl") + 1);
  });

  it("requires reasoning_id to be present, even when null", () => {
    const t = { ...testTrade() } as Record<string, unknown>;
    delete t.reasoning_id;
    expect(() => validateTrade(t as never)).toThrow(/reasoning_id is required/);
  });

  it("writes a null reasoning_id as a bare null, not a string", () => {
    const json = canonicalise(testTrade({ reasoning_id: null }));
    expect(json).toContain('"reasoning_id":null');
    expect(json).not.toContain('"reasoning_id":"null"');
  });

  it("accepts an Arweave id and rejects anything else", () => {
    expect(() =>
      validateTrade(testTrade({ reasoning_id: "FMe5qJbxE39iMDQqKfWqksfPAndFmwnYv4usLQUnSqVj" })),
    ).not.toThrow();
    for (const bad of ["", "not-an-arweave-id", "short", 42, {}]) {
      expect(() => validateTrade(testTrade({ reasoning_id: bad as never }))).toThrow(SchemaError);
    }
  });

  it("signs v2 with the v2 domain prefix", () => {
    expect(signingMessage(testTrade()).toString("utf8").startsWith("lyra-record/v2:")).toBe(true);
  });
});

describe("versions cannot be crossed", () => {
  it("a v1 and v2 trade with identical data sign different bytes", () => {
    // Different prefix and different field set, so a signature cannot be lifted
    // from one version onto the other.
    const v1 = signingMessage(v1Trade()).toString("utf8");
    const v2 = signingMessage(testTrade({ reasoning_id: null })).toString("utf8");
    expect(v1).not.toBe(v2);
  });

  it("rejects an envelope whose schema disagrees with the trade version", () => {
    const record = signTrade(testTrade(), testKey());
    (record as { schema: string }).schema = "lyra-record/v1";
    expect(() => validateSignedRecord(record)).toThrow(/does not match trade.schema_version/);
  });

  it("rejects a version this library does not know", () => {
    expect(() => validateTrade(testTrade({ schema_version: 3 as never }))).toThrow(
      /unsupported schema_version/,
    );
    expect(() => validateTrade(testTrade({ schema_version: 0 as never }))).toThrow(SchemaError);
  });

  it("supports exactly the versions it claims to", () => {
    expect([...SUPPORTED_VERSIONS]).toEqual([1, 2]);
    for (const v of SUPPORTED_VERSIONS) {
      expect(signingPrefixFor(v)).toBe(`lyra-record/v${v}:`);
    }
  });
});
