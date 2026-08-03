# lyra-record

A permanent, publicly verifiable trade ledger for autonomous trading agents.

Each closed trade is written to Arweave through [Irys](https://irys.xyz). The
upload returns a receipt that timestamps it to the millisecond and can be
verified by anyone, offline. Arweave data cannot be altered or deleted — the
protocol has no deletion primitive and no governance mechanism that could add
one.

Lyra is the first user of this library, not the only one. Any agent, bot or
person can keep a record with it.

```sh
npm install @lyra-protocol/record
```

## What this guarantees, and what it does not

Read this part before anything else. Overclaiming here would destroy the only
thing being built.

| | |
|---|---|
| Records cannot be altered or deleted | **Yes.** Not by anyone, including the author. |
| The upload timestamp is genuine | **Yes.** The Irys receipt is independently verifiable. |
| The named owner wrote it | **Yes.** ed25519 signature over canonical bytes. |
| **The trade actually happened** | **No.** Only the venue can tell you that. |
| **Every trade was recorded** | **No.** Gaps make omission visible, not impossible. |
| **The timestamp is when the trade closed** | **No.** It is when the record was uploaded. |

The last three matter more than the first three, because they are where a record
can mislead you.

**Trade truth rests on reconciliation, not on this ledger.** Every record
publishes `venue_address` — the trading wallet on the execution venue. Hyperliquid
positions are public, so anyone can ask Hyperliquid directly whether the claimed
fills exist. A signed, timestamped, permanent record of a trade that never
happened is a signed, timestamped, permanent lie. `reconcileVenue` hands you the
exact public request; it deliberately does not return a verdict, because this
library must never be the thing that certifies its own honesty.

**Omission is the real attack.** Nobody can delete a record, but a dishonest
recorder can simply never write the losing ones. Every record carries a
`sequence` that increments from 0 per owner, so a missing number is visible to
anyone. A gap is *not* proof of dishonesty — a crashed process leaves one too —
but it must be visible rather than silent. `findGaps(owner)` reports them.

[**docs/VERIFY.md**](docs/VERIFY.md) walks a sceptic through checking all of this
against a real record, using public tools only.

## Why Arweave and not a smart contract

The previous version of this repo was a Solana Anchor program. Three properties
decided the rewrite:

1. **No cost.** Irys uploads under 100 KiB are free, and a trade record is a few
   hundred bytes. There is no testnet phase and no throwaway period — the ledger
   is real from the first trade.
2. **No deletion.** A Solana account can be closed by whoever controls it.
   Arweave data cannot be removed by anyone. That difference is the entire
   product.
3. **Proof of time.** The Irys receipt timestamps the upload to the millisecond,
   independently verifiable. This is what answers *"you wrote this after you knew
   how it turned out."*

Permanence and timestamping are already solved. A chain deployment, a token or a
contract on top would be cost without benefit.

## Usage

### Write a trade

```ts
import { loadKeyFromEnv, nextSequence, recordTrade } from "@lyra-protocol/record";

const key = loadKeyFromEnv();            // LYRA_RECORD_KEY

const result = await recordTrade({
  schema_version: 2,
  owner: key.publicKey,
  venue: "hyperliquid",
  venue_address: "0xabc…",               // public, so anyone can reconcile
  pair: "SOL-PERP",
  side: "long",
  entry_price: "184.37",                 // decimal strings, never numbers
  exit_price: "189.02",
  size: "12.5",
  pnl: "58.125",
  fees: "0.4271",
  open_timestamp: 1785600000000,
  close_timestamp: 1785603600000,
  venue_open_id: "496459510831",
  venue_close_id: "496459998102",
  strategy_id: "funding-carry-v1",
  sequence: nextSequence(key.publicKey),
  reasoning_id: null,                    // or the Arweave id of the reasoning record
}, key);

result.arweaveId;          // permanent address of the record
result.receipt.timestamp;  // proof of time, to the millisecond
```

**Every monetary and quantity value is a decimal string.** Floats silently lose
precision and a ledger that rounds is not a ledger. Passing a number is rejected
at validation rather than accepted and mangled.

### Read it back

```ts
import { findGaps, queryRecords, verifyRecord } from "@lyra-protocol/record";

const trades = await queryRecords({ owner, pair: "SOL-PERP" });
const gaps   = await findGaps(owner);        // omission check
const report = await verifyRecord(arweaveId); // every check, by name
```

There is no database, no indexer and no backend service. Reads are one GraphQL
POST against Irys's public endpoint and one gateway GET per record. The tags are
the entire query layer. If a query is slow, cache it client-side — do not add
infrastructure, because infrastructure is something a reader has to trust.

### CLI

```sh
lyra-record record --file trade.json --key ./lyra.key.json
lyra-record query  --owner <pubkey> --pair SOL-PERP
lyra-record verify --id <arweaveId>
lyra-record gaps   --owner <pubkey>
lyra-record export --owner <pubkey> --format csv
```

`export` matters more than it looks — it is how you put your record into a grant
application without asking anyone for a favour.

## The schema

Versioned from day one, so future changes never invalidate old entries.

| field | type | notes |
|---|---|---|
| `schema_version` | number | `2` for this release; `1` still verifies |
| `owner` | string | base58 ed25519 public key |
| `venue` | string | e.g. `"hyperliquid"` |
| `venue_address` | string | the trading wallet — this is what makes the record checkable |
| `pair` | string | e.g. `"SOL-PERP"` |
| `side` | `"long"` \| `"short"` | |
| `entry_price` | string | decimal |
| `exit_price` | string | decimal |
| `size` | string | decimal |
| `pnl` | string | signed decimal |
| `fees` | string | decimal |
| `open_timestamp` | number | ms epoch, from the venue |
| `close_timestamp` | number | ms epoch, from the venue |
| `venue_open_id` | string | venue order id |
| `venue_close_id` | string | venue order id |
| `strategy_id` | string | strategy version that produced this trade |
| `sequence` | number | monotonic per owner, from 0 |
| `reasoning_id` | string \| null | v2. Arweave id of the decision record, or `null` when deterministic |

Each upload is tagged `App-Name`, `Schema-Version`, `Owner`, `Venue`,
`Venue-Address`, `Pair`, `Strategy-Id`, `Sequence`, `Close-Timestamp` and
`Content-Type`. Tags are indexed metadata and are **not** covered by the owner
signature — if a tag and the signed body disagree, believe the body.
`verifyRecord` checks for exactly that.

## Cost

Irys uploads at or below 100 KiB are free. A trade record is a few hundred bytes,
so recording a trade costs nothing and the signing key never needs a balance.

The library measures the payload before touching the network and throws
`PayloadTooLargeError` rather than let an unfunded key quietly incur a charge.
The body budget is 100 KiB minus a 4 KiB allowance for the data item header.

## Network

**Irys mainnet only.** There is no devnet support and there will not be.

Devnet data is retained only temporarily, which makes a devnet record not a
record. Since sub-100 KiB uploads are free there is no cost argument for a test
network either. Use small, clearly-tagged test records on mainnet during
development and leave them there — a visible test phase is more honest than a
hidden one. This repo's own test records are still on mainnet and are used as the
worked example in `docs/VERIFY.md`.

## Schema versions

| Version | Fields | Adds |
|---|---|---|
| v1 | 17 | the trade |
| **v2** *(current)* | 18 | `reasoning_id` — Arweave id of the record holding the model, prompt, schema and raw output behind the decision |

`reasoning_id` is nullable: a trade produced by deterministic rules has nothing
to explain. It is *required* though, so "no reasoning" is an explicit `null`
rather than an absence that could mean either nothing happened or something was
removed.

**v1 records stay verifiable forever.** Canonicalisation and the signing prefix
follow the record's own `schema_version`, never the installed release — so a v1
record is checked with the v1 field order and the `lyra-record/v1:` prefix. The
frozen field orders are exported as `CANONICAL_FIELD_ORDER_V1` and
`CANONICAL_FIELD_ORDER_V2`.

This is verified two ways: in the suite (`test/versioning.test.ts`) and against
the real v1 record on Arweave, which still passes every check under this release.

## Stability

This is `0.1.0`, and the version is deliberate. The canonical serialisation in
`schema.ts` is what every future verifier has to reimplement, and `SCHEMA_ID` is
baked into every signature ever produced. Until a real ledger depends on it,
that contract stays revisable.

Records already written stay verifiable regardless: `schema_version` is in every
one of them, so a later schema cannot invalidate an earlier record. The version
number describes the library's API, not the permanence of the data.

`1.0.0` follows once the schema has held through real use.

## Known limitations

Stated here rather than discovered later.

**The GraphQL index lags by hours, not minutes.** This was measured, not assumed:
a record written by the test suite was served by the gateway immediately and was
still absent from GraphQL an hour and a half later.

Three different Irys surfaces behave differently, and it matters which one you
are asking:

| Surface | Availability | What it gives you |
|---|---|---|
| `gateway.irys.xyz/<id>` | immediate | the record body |
| `uploader.irys.xyz/tx/<id>` | immediate | tags, uploader address, status |
| `arweave.mainnet.irys.xyz/graphql` | hours | **search by tag** — the only way to find records you do not already have ids for |

So `verifyRecord` reads tags from the node rather than the index and works on a
brand-new record. But `queryRecords` and `findGaps` search by tag, and searching
is the one thing only the index can do.

Consequences:

- `findGaps` may report a gap for a record that was just written. Wait and retry.
- The duplicate check in `recordTrade` cannot see recent uploads. The local
  store (`.lyra-record`) is the real defence; the remote lookup is a backstop.
  If the local store is lost inside the indexing window, `recordTrade` **will**
  write a second record at the same sequence. `result.remoteCheck` reports
  whether the lookup was authoritative (`"hit"`, `"miss"` or `"skipped"`), and
  `"miss"` does not mean "does not exist".

This is not hypothetical: the test suite produced exactly such a duplicate, it is
permanent, and it is documented in `docs/VERIFY.md` §6 rather than hidden.

**Publish your receipts.** Irys serves receipts *only* from the lagging GraphQL
index — the node has no per-transaction receipt endpoint (`/tx/<id>/receipt`
returns 404). A receipt file is self-contained, carrying the node's public key,
so publishing it is what lets a stranger check proof of time straight away:

```sh
lyra-record receipt --owner <pubkey> --out receipts.json
lyra-record verify --id <arweaveId> --receipt receipts.json
```

Without a published receipt a record can still be checked for content and
authorship immediately, but its proof of time waits on the index.

**Committed is not the same as settled.** `status: CONFIRMED` from Irys means the
node has accepted and committed the upload. `seededTo: []` means it has not yet
been bundled into an Arweave transaction. `verifyRecord` reports both rather than
conflating them.

**Nothing can be corrected.** There is no update and no delete, by design. A
record written with wrong values stays wrong forever; the only remedy is to write
a later record and let both stand.

**Concurrency is not handled.** The library assumes a single writer per owner. Two
processes writing the same owner concurrently can duplicate a sequence.

## Development

```sh
npm install
npm run build
npm test              # 80 offline tests, no network
npm run test:live     # writes real, permanent records to Irys mainnet
```

`npm test` never touches the network. `npm run test:live` does, and what it writes
cannot be undone — it uses a throwaway key and a `strategy_id` of
`lyra-record-test-suite` so its records can never be confused with a real ledger.

Layout:

```
src/schema.ts     the trade schema, validation, canonical serialisation
src/signing.ts    ed25519 keys, sign, verify
src/record.ts     the write path
src/query.ts      reading records back, gap detection
src/verify.ts     independent verification
src/irys.ts       everything that talks to Irys or Arweave
src/store.ts      local receipts, sequence index, pending journal
cli/              the CLI
docs/VERIFY.md    how a sceptic checks the record
docs/INTEGRATION.md  how an agent wires this in
```

## Out of scope

No smart contract, no chain deployment, no token, no Solana anchoring, no backend
service, no database, no user accounts, no web UI, no trade execution, no
strategy logic. Those live in other repos or nowhere.

## Licence

MIT.
