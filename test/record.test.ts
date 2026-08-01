import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { PayloadTooLargeError, SequenceConflictError } from "../src/errors.js";
import { MAX_PAYLOAD_BYTES, TAG_NAMES } from "../src/irys.js";
import {
  assertFreeTier,
  buildTags,
  listPendingWrites,
  nextSequence,
  prepareRecord,
  recordTrade,
} from "../src/record.js";
import { tradeDigest } from "../src/schema.js";
import { LocalStore } from "../src/store.js";
import { testKey, testTrade } from "./fixtures.js";

function scratch(): string {
  return mkdtempSync(join(tmpdir(), "lyra-record-"));
}

describe("free tier guard", () => {
  it("accepts a normal trade record", () => {
    const { payloadBytes } = prepareRecord(testTrade(), testKey());
    expect(payloadBytes).toBeLessThan(1024);
    expect(() => assertFreeTier(payloadBytes)).not.toThrow();
  });

  it("rejects a payload over the free budget with a clear error", () => {
    expect(() => assertFreeTier(MAX_PAYLOAD_BYTES + 1)).toThrow(PayloadTooLargeError);
    try {
      assertFreeTier(200_000);
    } catch (error) {
      const e = error as PayloadTooLargeError;
      expect(e.message).toMatch(/would charge the signing key/);
      expect(e.payloadBytes).toBe(200_000);
      expect(e.limitBytes).toBe(MAX_PAYLOAD_BYTES);
    }
    expect.assertions(4);
  });

  it("rejects an oversized record before any network call", async () => {
    const key = testKey();
    const huge = testTrade({ strategy_id: "x".repeat(120_000) });
    await expect(
      recordTrade(huge, key, { dataDir: scratch(), skipRemoteCheck: true }),
    ).rejects.toThrow(PayloadTooLargeError);
  });
});

describe("sequence idempotency", () => {
  it("returns the existing record when the same sequence is retried", async () => {
    const dataDir = scratch();
    const key = testKey();
    const trade = testTrade({ sequence: 3 });
    const store = new LocalStore(dataDir);

    // Stand in for a write that already succeeded.
    store.putEntry(key.publicKey, {
      sequence: 3,
      arweaveId: "AAAAexistingAAAA",
      digest: tradeDigest(trade),
      uploadedAt: 1785612870255,
      payloadBytes: 512,
    });
    store.saveReceipt(key.publicKey, 3, {
      id: "AAAAexistingAAAA",
      public: "pub",
      signature: "sig",
      deadlineHeight: 0,
      timestamp: 1785612870255,
      version: "1.0.0",
    });

    const result = await recordTrade(trade, key, { dataDir, skipRemoteCheck: true });
    expect(result.deduplicated).toBe(true);
    expect(result.arweaveId).toBe("AAAAexistingAAAA");
    expect(result.sequence).toBe(3);
  });

  it("refuses to write a different trade at a used sequence", async () => {
    const dataDir = scratch();
    const key = testKey();
    const store = new LocalStore(dataDir);
    store.putEntry(key.publicKey, {
      sequence: 3,
      arweaveId: "AAAAexistingAAAA",
      digest: tradeDigest(testTrade({ sequence: 3 })),
      uploadedAt: 1785612870255,
      payloadBytes: 512,
    });

    const conflicting = testTrade({ sequence: 3, pnl: "-999.0" });
    await expect(
      recordTrade(conflicting, key, { dataDir, skipRemoteCheck: true }),
    ).rejects.toThrow(SequenceConflictError);
  });

  it("names the conflicting record so it can be inspected", async () => {
    const dataDir = scratch();
    const key = testKey();
    new LocalStore(dataDir).putEntry(key.publicKey, {
      sequence: 1,
      arweaveId: "CONFLICTid",
      digest: "different",
      uploadedAt: 1,
      payloadBytes: 1,
    });
    await recordTrade(testTrade({ sequence: 1 }), key, {
      dataDir,
      skipRemoteCheck: true,
    }).catch((error: SequenceConflictError) => {
      expect(error.existingArweaveId).toBe("CONFLICTid");
      expect(error.sequence).toBe(1);
      expect(error.owner).toBe(key.publicKey);
    });
    expect.assertions(3);
  });
});

describe("the local store", () => {
  it("starts sequences at 0 and advances", () => {
    const dataDir = scratch();
    const key = testKey();
    expect(nextSequence(key.publicKey, { dataDir })).toBe(0);

    const store = new LocalStore(dataDir);
    store.putEntry(key.publicKey, {
      sequence: 0,
      arweaveId: "a",
      digest: "d",
      uploadedAt: 1,
      payloadBytes: 1,
    });
    expect(nextSequence(key.publicKey, { dataDir })).toBe(1);
  });

  it("counts an in-flight write when choosing the next sequence", () => {
    const dataDir = scratch();
    const key = testKey();
    const store = new LocalStore(dataDir);
    const record = prepareRecord(testTrade({ sequence: 0 }), key).record;
    store.markPending(key.publicKey, {
      sequence: 0,
      digest: "d",
      attemptedAt: Date.now(),
      record,
    });
    // Sequence 0 was attempted; the next trade must not reuse it.
    expect(nextSequence(key.publicKey, { dataDir })).toBe(1);
  });

  it("surfaces writes that were started and never confirmed", async () => {
    const dataDir = scratch();
    const key = testKey();
    // No network here, so the upload fails and the pending marker survives.
    await recordTrade(testTrade({ sequence: 0 }), key, {
      dataDir,
      skipRemoteCheck: true,
      uploaderUrl: "http://127.0.0.1:1",
      rpcUrl: "http://127.0.0.1:1",
    }).catch(() => undefined);

    const pending = listPendingWrites(key.publicKey, { dataDir });
    expect(pending).toHaveLength(1);
    expect(pending[0]?.sequence).toBe(0);
    expect(pending[0]?.record.trade.pnl).toBe("58.125");
  });

  it("keeps receipts retrievable by sequence", () => {
    const dataDir = scratch();
    const key = testKey();
    const store = new LocalStore(dataDir);
    const receipt = {
      id: "RECEIPTid",
      public: "pub",
      signature: "sig",
      deadlineHeight: 0,
      timestamp: 1785612870255,
      version: "1.0.0",
    };
    store.saveReceipt(key.publicKey, 12, receipt);
    expect(store.readReceipt(key.publicKey, 12)).toEqual(receipt);
    expect(store.readReceipt(key.publicKey, 13)).toBeUndefined();
  });
});

describe("tags", () => {
  it("tags every field the query layer needs", () => {
    const trade = testTrade({ sequence: 42 });
    const tags = Object.fromEntries(buildTags(trade).map((t) => [t.name, t.value]));
    expect(tags).toEqual({
      [TAG_NAMES.appName]: "lyra-record",
      [TAG_NAMES.schemaVersion]: "1",
      [TAG_NAMES.owner]: trade.owner,
      [TAG_NAMES.venue]: "hyperliquid",
      [TAG_NAMES.venueAddress]: trade.venue_address,
      [TAG_NAMES.pair]: "SOL-PERP",
      [TAG_NAMES.strategyId]: "funding-carry-v1",
      [TAG_NAMES.sequence]: "42",
      [TAG_NAMES.closeTimestamp]: "1785603600000",
      [TAG_NAMES.contentType]: "application/json",
    });
  });
});

describe("failed uploads", () => {
  it("throws with the unwritten trade attached", async () => {
    const key = testKey();
    const trade = testTrade({ sequence: 0 });
    await expect(
      recordTrade(trade, key, {
        dataDir: scratch(),
        skipRemoteCheck: true,
        uploaderUrl: "http://127.0.0.1:1",
        rpcUrl: "http://127.0.0.1:1",
      }),
    ).rejects.toMatchObject({
      name: "RecordUploadError",
      trade: { sequence: 0, pnl: "58.125" },
    });
  });
});
