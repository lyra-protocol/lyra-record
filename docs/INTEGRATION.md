# Integrating lyra-record

This is written for the recorder subsystem of `lyra-core`, but nothing in it is
specific to Lyra. Any agent that closes trades can follow it.

## Install

```sh
npm install @lyra-protocol/record
```

Requires Node 20 or newer. The package is ESM only.

## The one rule that matters

**Never let a trade value pass through a JavaScript number.**

Hyperliquid returns prices, sizes, PnL and fees as decimal *strings*:

```jsonc
// POST https://api.hyperliquid.xyz/info  {"type":"userFills","user":"0x..."}
{ "px": "331.21", "sz": "1.506", "closedPnl": "0.0", "fee": "0.0", "oid": 496459510831 }
```

Pass those strings straight into the record. The moment a value becomes a
`number` it has lost precision that cannot be recovered, and the ledger has
recorded something the venue never said.

This is a real hazard in the existing code: `lyra-agent/src/execution/hyperliquid.ts`
models positions with `entryPrice: number` and `sizeUsd: number`. That is fine for
sizing a trade. It is not fine as the source of a record. The recorder must read
from the venue's fill data, not from the execution module's in-memory position.

```ts
// wrong — the venue said "331.21", the record says 331.21000000000001
entry_price: String(position.entryPrice)

// right — the venue's own bytes, untouched
entry_price: fill.px
```

## Wiring it up

```ts
import { loadKeyFromEnv, nextSequence, recordTrade, RecordUploadError }
  from "@lyra-protocol/record";

const key = loadKeyFromEnv();            // LYRA_RECORD_KEY

async function onTradeClosed(openFill, closeFill, strategyId: string) {
  const trade = {
    schema_version: 1,
    owner: key.publicKey,
    venue: "hyperliquid",
    venue_address: process.env.HL_ADDRESS!,   // public, this is the point
    pair: openFill.coin,
    side: openFill.side === "B" ? "long" : "short",
    entry_price: openFill.px,                 // strings, straight from the venue
    exit_price: closeFill.px,
    size: openFill.sz,
    pnl: closeFill.closedPnl,
    fees: closeFill.fee,
    open_timestamp: openFill.time,
    close_timestamp: closeFill.time,
    venue_open_id: String(openFill.oid),
    venue_close_id: String(closeFill.oid),
    strategy_id: strategyId,
    sequence: nextSequence(key.publicKey),
  } as const;

  try {
    const result = await recordTrade(trade, key);
    log.info({ id: result.arweaveId, seq: result.sequence }, "recorded");
  } catch (error) {
    if (error instanceof RecordUploadError) {
      // The trade is attached and is NOT in the ledger. Queue it.
      await retryQueue.push(error.trade);
    }
    throw error;
  }
}
```

## What the recorder must guarantee

The library handles idempotency, sizing and receipt persistence. Two things are
the caller's job:

**1. A failed write must be retried, not dropped.**
`recordTrade` throws `RecordUploadError` with the unwritten trade attached. If
that error is swallowed, the ledger has a hole and the sequence numbers make it
visible forever. Persist the trade and retry it — the same sequence number, the
same values. Retrying is safe: an identical retry returns the existing record
rather than writing a second one.

**2. Crashes must be reconciled on startup.**
A process that dies mid-upload leaves a pending marker. Check for them:

```ts
import { listPendingWrites } from "@lyra-protocol/record";

for (const pending of listPendingWrites(key.publicKey)) {
  await recordTrade(pending.record.trade, key);   // idempotent
}
```

## Sequence numbers

`sequence` is monotonic per owner and starts at 0. `nextSequence(owner)` reads
the local store, which is why the store directory (`.lyra-record` by default)
must survive restarts — put it on a volume, not in a container's ephemeral
layer.

If the local store is lost, recover the highest sequence from Irys before
writing again:

```ts
import { findGaps } from "@lyra-protocol/record";
const report = await findGaps(key.publicKey);
const next = (report.max ?? -1) + 1;
```

Note that Irys indexes uploads to GraphQL slowly — hours, in measured practice —
so a recently written record may not appear. Do not run this straight after a
write.

## Key management

The signing key is an ed25519 keypair — the same shape Solana uses, so
`solana-keygen new -o lyra-record.key.json` produces a valid one. It signs
records and pays for uploads, though uploads under 100 KiB are free so it never
needs a balance.

The public key becomes `owner` on every record it signs, permanently. Losing the
secret key means the record can never be extended under that identity; leaking it
means someone else can write records that appear to be yours. Neither is
recoverable, because nothing on Arweave can be revoked.

Keep it out of the repo. `.env` and `*.key.json` are gitignored here.

## Testing without writing to mainnet

There is no devnet. Devnet data is not retained, and a record that expires is not
a record. To exercise the integration without touching the network, use
`prepareRecord`, which signs and sizes a trade and uploads nothing:

```ts
import { prepareRecord } from "@lyra-protocol/record";
const { payload, payloadBytes, digest } = prepareRecord(trade, key);
```

When you do want a live check, write a real record and tag it as a test. A
visible test phase is more honest than a hidden one.
