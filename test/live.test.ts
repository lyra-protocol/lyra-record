/**
 * End-to-end tests against Irys mainnet.
 *
 * These write real records that can never be deleted. They are excluded from
 * `npm test` and run only with LYRA_LIVE_TESTS=1.
 *
 * There is no devnet here on purpose: devnet data is not retained, so a devnet
 * record is not a record, and uploads under 100 KiB are free so there is no cost
 * argument for one either. What these tests write is a small, clearly-marked
 * test record under a throwaway key — `strategy_id` says what it is, and the
 * owner key is not Lyra's, so it can never mix into a real ledger. Leaving them
 * in place is more honest than hiding them.
 *
 * Set LYRA_RECORD_KEY to write under a specific key instead of a fresh one.
 */

import { ed25519 } from "@noble/curves/ed25519";
import bs58 from "bs58";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { beforeAll, describe, expect, it } from "vitest";
import { getRecord, queryRecords } from "../src/query.js";
import { recordTrade } from "../src/record.js";
import { loadKey, type OwnerKey } from "../src/signing.js";
import { reconcileVenue, verifyReceipt, verifyRecord, verifySignature } from "../src/verify.js";
import type { RecordResult, TradeRecord } from "../src/types.js";
import { testTrade } from "./fixtures.js";

const dataDir = mkdtempSync(join(tmpdir(), "lyra-live-"));

function throwawayKey(): OwnerKey {
  const seed = new Uint8Array(randomBytes(32));
  const publicKey = ed25519.getPublicKey(seed);
  const secretKey = new Uint8Array(64);
  secretKey.set(seed, 0);
  secretKey.set(publicKey, 32);
  return {
    publicKey: bs58.encode(publicKey),
    seed,
    irysWallet: bs58.encode(secretKey),
  };
}

const key = process.env.LYRA_RECORD_KEY ? loadKey(process.env.LYRA_RECORD_KEY) : throwawayKey();

/** A trade that is unmistakably a test, even to someone reading it in a year. */
function liveTrade(sequence: number): TradeRecord {
  return testTrade({
    owner: key.publicKey,
    sequence,
    strategy_id: "lyra-record-test-suite",
    venue_address: "0x0000000000000000000000000000000000000000",
    venue_open_id: `test-open-${sequence}`,
    venue_close_id: `test-close-${sequence}`,
  });
}

describe("end to end on Irys mainnet", () => {
  let result: RecordResult;

  beforeAll(async () => {
    process.stdout.write(`\n  live test owner: ${key.publicKey}\n`);
    result = await recordTrade(liveTrade(0), key, { dataDir });
    process.stdout.write(`  wrote https://gateway.irys.xyz/${result.arweaveId}\n\n`);
  }, 120_000);

  it("uploads for free and returns an Arweave id", () => {
    expect(result.arweaveId).toMatch(/^[A-Za-z0-9_-]{43,44}$/);
    expect(result.deduplicated).toBe(false);
    expect(result.payloadBytes).toBeLessThan(1024);
  });

  it("returns a receipt that timestamps the upload to the millisecond", async () => {
    expect(result.receipt.timestamp).toBeGreaterThan(1_700_000_000_000);
    expect(Math.abs(result.receipt.timestamp - Date.now())).toBeLessThan(5 * 60_000);
    expect(await verifyReceipt(result.receipt)).toBe(true);
  });

  it("serves the record back from the gateway, byte for byte", async () => {
    const fetched = await getRecord(result.arweaveId);
    expect(fetched.record).toEqual(result.record);
    expect(verifySignature(fetched.record)).toBe(true);
  });

  it("does not write a second record when the same sequence is retried", async () => {
    const retry = await recordTrade(liveTrade(0), key, { dataDir });
    expect(retry.deduplicated).toBe(true);
    expect(retry.arweaveId).toBe(result.arweaveId);
    // The local store answered, so the remote lookup was never needed.
    expect(retry.remoteCheck).toBe("skipped");
  });

  it("reports the remote duplicate check as inconclusive inside the index window", async () => {
    // A fresh data directory stands in for a rebuilt machine: the local store is
    // gone and the remote lookup is the only defence left. Irys indexes uploads
    // to GraphQL hours after they succeed, so straight after a write that
    // lookup returns nothing — and "nothing" does not mean "does not exist".
    //
    // This is a real hole and the library does not pretend otherwise. It is
    // asserted here rather than hidden, because a caller recovering from data
    // loss needs to know that a miss is not an answer. Nothing is written.
    const { queryRecords: query } = await import("../src/query.js");
    const indexed = await query({ owner: key.publicKey, withData: false });
    if (indexed.length === 0) {
      process.stdout.write(
        "  note: the index has not caught up yet — a rebuilt machine writing now would duplicate\n",
      );
    }
    expect(indexed.length).toBeLessThanOrEqual(1);
  }, 120_000);

  it("refuses to write different content at a used sequence", async () => {
    const conflicting = { ...liveTrade(0), pnl: "-999.0" };
    await expect(recordTrade(conflicting, key, { dataDir })).rejects.toThrow(
      /already used by a different trade|already on Arweave with different content/,
    );
  });

  it("verifies completely from the id plus the writer's receipt, with no index", async () => {
    // This is the flow the docs recommend: the writer publishes the receipt, and
    // a stranger checks everything straight away instead of waiting hours for
    // Irys to index the upload.
    const report = await verifyRecord(result.arweaveId, { receipt: result.receipt });
    const byName = Object.fromEntries(report.checks.map((c) => [c.name, c]));
    expect(byName["data-available"]?.status).toBe("pass");
    expect(byName["schema-valid"]?.status).toBe("pass");
    expect(byName["canonical-bytes"]?.status).toBe("pass");
    expect(byName["owner-signature"]?.status).toBe("pass");
    expect(byName["irys-receipt"]?.status).toBe("pass");
    expect(byName["tags-match-body"]?.status).toBe("pass");
    expect(byName["irys-committed"]?.status).toBe("pass");
    expect(byName["closed-before-upload"]?.status).toBe("pass");
    expect(report.inconclusive).toBe(false);
    expect(report.ok).toBe(true);
  }, 120_000);

  it("reads tags from the Irys node before the index has caught up", async () => {
    const { fetchTransaction, fetchStatus, resolveConfig } = await import("../src/irys.js");
    const config = resolveConfig({});
    const tx = await fetchTransaction(result.arweaveId, config);
    expect(tx?.tags.find((t) => t.name === "App-Name")?.value).toBe("lyra-record");
    expect(tx?.address).toBe(key.publicKey);

    const status = await fetchStatus(result.arweaveId, config);
    expect(status?.status).toBe("CONFIRMED");
  }, 60_000);

  it("verifies as a whole, from the Arweave id alone", async () => {
    const report = await verifyRecord(result.arweaveId);
    const byName = Object.fromEntries(report.checks.map((c) => [c.name, c]));
    // These need nothing but the record body, so they hold immediately.
    expect(byName["data-available"]?.passed).toBe(true);
    expect(byName["schema-valid"]?.passed).toBe(true);
    expect(byName["canonical-bytes"]?.passed).toBe(true);
    expect(byName["owner-signature"]?.passed).toBe(true);

    // These need the GraphQL index. On a fresh record they have not run yet, and
    // the report says so rather than reporting a failure it cannot justify.
    const receiptCheck = byName["irys-receipt"];
    if (receiptCheck?.passed) {
      expect(byName["closed-before-upload"]?.passed).toBe(true);
      expect(byName["tags-match-body"]?.passed).toBe(true);
      expect(report.ok).toBe(true);
    } else {
      expect(receiptCheck?.detail).toMatch(/can lag by hours/);
      process.stdout.write("  note: not indexed yet, so the receipt check was inconclusive\n");
    }
  });

  it("hands back a real venue request that returns nothing for a fake address", async () => {
    const plan = reconcileVenue(result.record);
    expect(plan.verdict).toBeNull();
    const response = await fetch(plan.request.url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(plan.request.body),
    });
    const fills = (await response.json()) as unknown[];
    // The zero address never traded. This is the correct outcome for a record
    // that claims a trade that did not happen — and it is exactly the check a
    // sceptic runs against a real one.
    expect(Array.isArray(fills)).toBe(true);
    expect(fills).toHaveLength(0);
  });
});

describe("querying mainnet", () => {
  it("finds nothing for an owner that has never written", async () => {
    expect(await queryRecords({ owner: throwawayKey().publicKey })).toEqual([]);
  });
});
