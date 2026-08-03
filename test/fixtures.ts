import { ed25519 } from "@noble/curves/ed25519";
import bs58 from "bs58";
import type { OwnerKey } from "../src/signing.js";
import type { TradeRecord } from "../src/types.js";

/** A deterministic key, so test failures are reproducible. */
export function testKey(seedByte = 7): OwnerKey {
  const seed = new Uint8Array(32).fill(seedByte);
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

export function testTrade(overrides: Partial<TradeRecord> = {}): TradeRecord {
  const key = testKey();
  return {
    schema_version: 2,
    owner: key.publicKey,
    venue: "hyperliquid",
    venue_address: "0x1234567890abcdef1234567890abcdef12345678",
    pair: "SOL-PERP",
    side: "long",
    entry_price: "184.37",
    exit_price: "189.02",
    size: "12.5",
    pnl: "58.125",
    fees: "0.4271",
    open_timestamp: 1785600000000,
    close_timestamp: 1785603600000,
    venue_open_id: "496459510831",
    venue_close_id: "496459998102",
    strategy_id: "funding-carry-v1",
    sequence: 0,
    reasoning_id: null,
    ...overrides,
  };
}

/** Builds a GraphQL transaction node as the Irys index would return it. */
export function graphqlNode(
  id: string,
  tags: Record<string, string>,
  overrides: Record<string, unknown> = {},
) {
  return {
    id,
    address: "8ktjY5aVtioCFhNM2iiXooUyiCBKsp2XHfqPdtNSmufo",
    timestamp: 1785612870255,
    tags: Object.entries(tags).map(([name, value]) => ({ name, value })),
    receipt: {
      signature: "stub",
      timestamp: 1785612870255,
      version: "1.0.0",
      deadlineHeight: 0,
    },
    ...overrides,
  };
}
