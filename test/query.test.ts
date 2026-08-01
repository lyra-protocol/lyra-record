import { afterEach, describe, expect, it, vi } from "vitest";
import { APP_NAME, TAG_NAMES } from "../src/irys.js";
import { findGaps, queryRecords, sequenceReport } from "../src/query.js";
import { buildTags } from "../src/record.js";
import { serialiseRecord } from "../src/schema.js";
import { signTrade } from "../src/signing.js";
import { graphqlNode, testKey, testTrade } from "./fixtures.js";
import type { TradeRecord } from "../src/types.js";

const key = testKey();

/**
 * Stands in for Irys. Records what was asked for, so a test can assert that a
 * filter really was pushed down to the tag query rather than applied locally.
 */
function stubIrys(trades: TradeRecord[]) {
  const seen: { tags: { name: string; values: string[] }[] }[] = [];
  const bodies = new Map<string, string>();
  const nodes = trades.map((trade) => {
    const id = `id-${trade.sequence}`;
    bodies.set(id, serialiseRecord(signTrade(trade, key)));
    const tags = Object.fromEntries(buildTags(trade).map((t) => [t.name, t.value]));
    return graphqlNode(id, tags);
  });

  const fetchMock = vi.fn(async (input: unknown, init?: { body?: string }) => {
    const url = String(input);
    if (url.includes("/graphql")) {
      const variables = JSON.parse(init?.body ?? "{}").variables as {
        tags?: { name: string; values: string[] }[];
      };
      seen.push({ tags: variables.tags ?? [] });
      const matching = nodes.filter((node) =>
        (variables.tags ?? []).every((filter) =>
          node.tags.some((t) => t.name === filter.name && filter.values.includes(t.value)),
        ),
      );
      return jsonResponse({
        data: {
          transactions: {
            edges: matching.map((node) => ({ cursor: node.id, node })),
            pageInfo: { hasNextPage: false },
          },
        },
      });
    }
    const id = url.split("/").pop() as string;
    const body = bodies.get(id);
    if (!body) return new Response("not found", { status: 404 });
    return new Response(body, { status: 200 });
  });

  vi.stubGlobal("fetch", fetchMock);
  return { seen };
}

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("querying by tag", () => {
  const trades = [
    testTrade({ sequence: 0, pair: "SOL-PERP", strategy_id: "funding-carry-v1" }),
    testTrade({ sequence: 1, pair: "ETH-PERP", strategy_id: "funding-carry-v1" }),
    testTrade({
      sequence: 2,
      pair: "SOL-PERP",
      strategy_id: "funding-carry-v2",
      close_timestamp: 1785690000000,
      open_timestamp: 1785689000000,
    }),
  ];

  it("always scopes to App-Name and Owner", async () => {
    const { seen } = stubIrys(trades);
    await queryRecords({ owner: key.publicKey });
    expect(seen[0]?.tags).toEqual([
      { name: TAG_NAMES.appName, values: [APP_NAME] },
      { name: TAG_NAMES.owner, values: [key.publicKey] },
    ]);
  });

  it("returns every record for an owner", async () => {
    stubIrys(trades);
    const results = await queryRecords({ owner: key.publicKey });
    expect(results.map((r) => r.sequence)).toEqual([0, 1, 2]);
    expect(results[0]?.record?.trade.pair).toBe("SOL-PERP");
  });

  it("filters by pair", async () => {
    const { seen } = stubIrys(trades);
    const results = await queryRecords({ owner: key.publicKey, pair: "SOL-PERP" });
    expect(results.map((r) => r.sequence)).toEqual([0, 2]);
    expect(seen[0]?.tags).toContainEqual({ name: TAG_NAMES.pair, values: ["SOL-PERP"] });
  });

  it("filters by strategy", async () => {
    stubIrys(trades);
    const results = await queryRecords({
      owner: key.publicKey,
      strategyId: "funding-carry-v2",
    });
    expect(results.map((r) => r.sequence)).toEqual([2]);
  });

  it("filters by venue", async () => {
    stubIrys(trades);
    expect(
      await queryRecords({ owner: key.publicKey, venue: "hyperliquid" }),
    ).toHaveLength(3);
    expect(await queryRecords({ owner: key.publicKey, venue: "binance" })).toHaveLength(0);
  });

  it("filters by close timestamp window", async () => {
    stubIrys(trades);
    const results = await queryRecords({
      owner: key.publicKey,
      from: 1785650000000,
      to: 1785700000000,
    });
    expect(results.map((r) => r.sequence)).toEqual([2]);
  });

  it("sorts by trade sequence, not upload time", async () => {
    stubIrys([...trades].reverse());
    const results = await queryRecords({ owner: key.publicKey });
    expect(results.map((r) => r.sequence)).toEqual([0, 1, 2]);
  });

  it("honours DESC and limit", async () => {
    stubIrys(trades);
    const results = await queryRecords({ owner: key.publicKey, sort: "DESC", limit: 2 });
    expect(results.map((r) => r.sequence)).toEqual([2, 1]);
  });

  it("can skip the bodies when only metadata is wanted", async () => {
    stubIrys(trades);
    const results = await queryRecords({ owner: key.publicKey, withData: false });
    expect(results).toHaveLength(3);
    expect(results[0]?.record).toBeUndefined();
    expect(results[0]?.tags[TAG_NAMES.pair]).toBe("SOL-PERP");
  });

  it("returns nothing for an owner with no records", async () => {
    stubIrys(trades);
    expect(await queryRecords({ owner: testKey(9).publicKey })).toEqual([]);
  });
});

describe("gap detection", () => {
  const tagsFor = (sequence: number) => ({
    [TAG_NAMES.appName]: APP_NAME,
    [TAG_NAMES.owner]: key.publicKey,
    [TAG_NAMES.sequence]: String(sequence),
  });

  it("reports a contiguous record as contiguous", () => {
    const report = sequenceReport(
      key.publicKey,
      [0, 1, 2, 3].map((s) => graphqlNode(`id-${s}`, tagsFor(s))),
    );
    expect(report.gaps).toEqual([]);
    expect(report.duplicates).toEqual([]);
    expect(report.contiguous).toBe(true);
    expect(report.min).toBe(0);
    expect(report.max).toBe(3);
  });

  it("finds a hole where a losing trade would have been", () => {
    // Sequence 2 was never written. This is the whole defence against omission.
    const report = sequenceReport(
      key.publicKey,
      [0, 1, 3, 4].map((s) => graphqlNode(`id-${s}`, tagsFor(s))),
    );
    expect(report.gaps).toEqual([2]);
    expect(report.contiguous).toBe(false);
  });

  it("finds several holes, including a record that does not start at 0", () => {
    const report = sequenceReport(
      key.publicKey,
      [3, 5].map((s) => graphqlNode(`id-${s}`, tagsFor(s))),
    );
    expect(report.gaps).toEqual([0, 1, 2, 4]);
    expect(report.min).toBe(3);
    expect(report.max).toBe(5);
  });

  it("finds a sequence claimed by two records", () => {
    const report = sequenceReport(key.publicKey, [
      graphqlNode("id-0", tagsFor(0)),
      graphqlNode("id-1a", tagsFor(1)),
      graphqlNode("id-1b", tagsFor(1)),
    ]);
    expect(report.duplicates).toEqual([{ sequence: 1, arweaveIds: ["id-1a", "id-1b"] }]);
    expect(report.contiguous).toBe(false);
  });

  it("treats an empty record as contiguous rather than broken", () => {
    const report = sequenceReport(key.publicKey, []);
    expect(report).toMatchObject({ count: 0, min: null, max: null, contiguous: true });
  });

  it("reads gaps from the live query path", async () => {
    stubIrys([testTrade({ sequence: 0 }), testTrade({ sequence: 2 })]);
    const report = await findGaps(key.publicKey);
    expect(report.gaps).toEqual([1]);
  });
});
