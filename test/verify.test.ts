import { afterEach, describe, expect, it, vi } from "vitest";
import { APP_NAME, TAG_NAMES } from "../src/irys.js";
import { buildTags } from "../src/record.js";
import { serialiseRecord } from "../src/schema.js";
import { signTrade } from "../src/signing.js";
import { reconcileVenue, verifyRecord, verifySignature } from "../src/verify.js";
import { graphqlNode, testKey, testTrade } from "./fixtures.js";
import type { SignedTradeRecord } from "../src/types.js";

const key = testKey();

/**
 * Serves one record over stubbed HTTP, optionally corrupted on the way out.
 *
 * `indexed: false` models the real and common case: Irys has accepted the upload
 * and serves it from the node and the gateway, but the GraphQL index has not
 * caught up — which on mainnet can take hours.
 */
function stubRecord(
  record: SignedTradeRecord,
  opts: { body?: string; indexed?: boolean; tags?: Record<string, string> } = {},
) {
  const id = "STUBrecordID";
  const body = opts.body ?? serialiseRecord(record);
  const tags =
    opts.tags ?? Object.fromEntries(buildTags(record.trade).map((t) => [t.name, t.value]));
  const tagList = Object.entries(tags).map(([name, value]) => ({ name, value }));

  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: unknown) => {
      const url = String(input);
      if (url.includes("/graphql")) {
        const edges =
          opts.indexed === false ? [] : [{ cursor: id, node: graphqlNode(id, tags) }];
        return json({ data: { transactions: { edges, pageInfo: { hasNextPage: false } } } });
      }
      if (url.endsWith("/public")) return new Response("stub-node-public-key", { status: 200 });
      if (url.endsWith(`/tx/${id}/status`)) return json({ status: "CONFIRMED", seededTo: [] });
      if (url.endsWith(`/tx/${id}`)) {
        return json({
          id,
          token: "solana",
          address: record.trade.owner,
          owner: "stub-owner-key",
          signature: "stub-data-item-signature",
          tags: tagList,
        });
      }
      return new Response(body, { status: 200 });
    }),
  );
  return id;
}

function json(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("verifyRecord", () => {
  it("passes the checks it can run on an honest record", async () => {
    const record = signTrade(testTrade(), key);
    const id = stubRecord(record);
    const report = await verifyRecord(id);

    const byName = Object.fromEntries(report.checks.map((c) => [c.name, c]));
    expect(byName["data-available"]?.passed).toBe(true);
    expect(byName["schema-valid"]?.passed).toBe(true);
    expect(byName["canonical-bytes"]?.passed).toBe(true);
    expect(byName["owner-signature"]?.passed).toBe(true);
    expect(byName["tags-match-body"]?.passed).toBe(true);
    expect(report.record?.trade.sequence).toBe(0);
  });

  it("fails the signature check on a tampered payload", async () => {
    const record = signTrade(testTrade(), key);
    const tampered = structuredClone(record);
    tampered.trade.pnl = "5800.125";
    const id = stubRecord(record, { body: JSON.stringify(tampered) });

    const report = await verifyRecord(id);
    const signature = report.checks.find((c) => c.name === "owner-signature");
    expect(signature?.passed).toBe(false);
    expect(signature?.detail).toMatch(/was not produced by the key it names/);
    expect(report.ok).toBe(false);
  });

  it("reports unparseable data rather than throwing", async () => {
    const record = signTrade(testTrade(), key);
    const id = stubRecord(record, { body: "not json at all" });
    const report = await verifyRecord(id);
    expect(report.ok).toBe(false);
    expect(report.checks.at(-1)?.name).toBe("schema-valid");
  });

  it("notices when the tags disagree with the signed body", async () => {
    const record = signTrade(testTrade({ sequence: 5 }), key);
    // The uploader claimed sequence 4 in the tags but signed sequence 5.
    const lyingTags = Object.fromEntries(
      buildTags(record.trade).map((t) => [t.name, t.value]),
    );
    lyingTags[TAG_NAMES.sequence] = "4";
    const id = stubRecord(record, { tags: lyingTags });

    const report = await verifyRecord(id);
    const tagCheck = report.checks.find((c) => c.name === "tags-match-body");
    expect(tagCheck?.status).toBe("fail");
    expect(tagCheck?.detail).toMatch(/Sequence is "4", body says "5"/);
  });

  it("compares tags even when the record is not in the index", async () => {
    // The node answers immediately for a known id, so this check does not have
    // to wait on GraphQL.
    const record = signTrade(testTrade(), key);
    const id = stubRecord(record, { indexed: false });
    const report = await verifyRecord(id);
    expect(report.checks.find((c) => c.name === "tags-match-body")?.status).toBe("pass");
  });

  it("reports whether Irys has committed the upload", async () => {
    const record = signTrade(testTrade(), key);
    const id = stubRecord(record);
    const report = await verifyRecord(id);
    const committed = report.checks.find((c) => c.name === "irys-committed");
    expect(committed?.status).toBe("pass");
    expect(committed?.detail).toMatch(/CONFIRMED/);
    // Honest about settlement: committed to Irys is not the same as seeded to Arweave.
    expect(committed?.detail).toMatch(/not yet seeded onto Arweave/i);
  });

  it("accepts a receipt published by the writer instead of the index", async () => {
    const record = signTrade(testTrade(), key);
    const id = stubRecord(record, { indexed: false });
    const receipt = {
      id,
      public: "stub-node-public-key",
      signature: "stub",
      deadlineHeight: 0,
      timestamp: 1785617213911,
      version: "1.0.0",
    };
    const report = await verifyRecord(id, { receipt });
    const check = report.checks.find((c) => c.name === "irys-receipt");
    // The stub signature will not verify, but the point is that the supplied
    // receipt was used at all rather than the check going inconclusive.
    expect(check?.status).not.toBe("inconclusive");
    expect(report.uploadedAt).toBe(1785617213911);
  });

  it("refuses a receipt that belongs to a different upload", async () => {
    const record = signTrade(testTrade(), key);
    const id = stubRecord(record, { indexed: false });
    const report = await verifyRecord(id, {
      receipt: {
        id: "SOMEOTHERrecordID",
        public: "k",
        signature: "s",
        deadlineHeight: 0,
        timestamp: 1785617213911,
        version: "1.0.0",
      },
    });
    const check = report.checks.find((c) => c.name === "irys-receipt");
    expect(check?.detail).toMatch(/supplied receipt is for SOMEOTHERrecordID/);
  });

  it("calls an unindexed record inconclusive, not invalid", async () => {
    const record = signTrade(testTrade(), key);
    const id = stubRecord(record, { indexed: false });
    const report = await verifyRecord(id);

    const receipt = report.checks.find((c) => c.name === "irys-receipt");
    expect(receipt?.status).toBe("inconclusive");
    expect(receipt?.detail).toMatch(/can lag by hours/);
    // Inconclusive is not passing. A verifier that reports missing evidence as
    // success is worse than useless.
    expect(receipt?.passed).toBe(false);

    expect(report.inconclusive).toBe(true);
    expect(report.ok).toBe(false);
    // Nothing actually failed — the record is readable and correctly signed.
    expect(report.checks.filter((c) => c.status === "fail")).toEqual([]);
    expect(report.checks.find((c) => c.name === "owner-signature")?.status).toBe("pass");
  });

  it("distinguishes a real failure from missing evidence", async () => {
    const record = signTrade(testTrade(), key);
    const tampered = structuredClone(record);
    tampered.trade.pnl = "5800.125";
    const id = stubRecord(record, { body: JSON.stringify(tampered), indexed: false });

    const report = await verifyRecord(id);
    expect(report.checks.filter((c) => c.status === "fail").map((c) => c.name)).toContain(
      "owner-signature",
    );
    expect(report.inconclusive).toBe(true);
    expect(report.ok).toBe(false);
  });
});

describe("verifySignature", () => {
  it("is a pure function needing no network", () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() => {
        throw new Error("verifySignature must not touch the network");
      }),
    );
    expect(verifySignature(signTrade(testTrade(), key))).toBe(true);
  });
});

describe("reconcileVenue", () => {
  it("hands back the exact public Hyperliquid request and no verdict", () => {
    const record = signTrade(testTrade(), key);
    const plan = reconcileVenue(record);

    expect(plan.verdict).toBeNull();
    expect(plan.request.method).toBe("POST");
    expect(plan.request.url).toBe("https://api.hyperliquid.xyz/info");
    expect(plan.request.body).toEqual({
      type: "userFillsByTime",
      user: record.trade.venue_address,
      startTime: record.trade.open_timestamp,
      endTime: record.trade.close_timestamp,
    });
    expect(plan.curl).toContain("api.hyperliquid.xyz/info");
    expect(plan.curl).toContain(record.trade.venue_address);
    expect(plan.expect.join(" ")).toContain(record.trade.venue_open_id);
  });

  it("says plainly that it has no ready-made request for other venues", () => {
    const record = signTrade(testTrade({ venue: "binance" }), key);
    const plan = reconcileVenue(record);
    expect(plan.verdict).toBeNull();
    expect(plan.steps.join(" ")).toMatch(/Hyperliquid only/);
  });
});

describe("what the library refuses to claim", () => {
  it("never returns a verdict on whether a trade happened", () => {
    const plan = reconcileVenue(signTrade(testTrade(), key));
    expect(Object.keys(plan)).not.toContain("valid");
    expect(plan.verdict).toBeNull();
  });

  it("scopes every query to the lyra-record namespace", () => {
    expect(buildTags(testTrade())[0]).toEqual({ name: TAG_NAMES.appName, value: APP_NAME });
  });
});
