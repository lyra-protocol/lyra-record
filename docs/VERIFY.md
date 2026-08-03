# How to verify a record without trusting anyone

This is written for someone trying to disprove a record.

Nothing below requires an account, an API key, a wallet, or this library. Every
step is a public HTTP request and a standard cryptographic check. If a step here
does not reproduce, the record is wrong and you should say so.

The worked example uses a real record on Irys mainnet. You can run every command
in this file, right now, and get the same answers.

```
record   FMe5qJbxE39iMDQqKfWqksfPAndFmwnYv4usLQUnSqVj
owner    DRzSvbp9EfSEABgLF8qPRQ6pnfBiGJ2xfXCtoYUPuDTS
```

That record is a **test record**, written by this repository's test suite. Its
`strategy_id` says so and its `venue_address` is the zero address. It is used
here precisely because it is honest about being fake — and because §5 shows you
how to catch that.

---

## What is being claimed

Four separate claims, which need four separate checks. Most arguments about
"verifiable" records collapse these together.

| Claim | Checked by | Section |
|---|---|---|
| This data has not been altered since upload | Arweave + the Irys receipt | §2, §3 |
| It was uploaded at this exact millisecond | The Irys receipt | §3 |
| The named owner claimed it | The ed25519 owner signature | §4 |
| The trade actually happened | The venue's own public data | §5 |

The first three can be proven with mathematics. **The fourth cannot.** No ledger
can prove a trade occurred; only the venue can. §5 is the one that matters most,
and it is the one this library refuses to answer for you.

---

## 1. Get the data

```sh
curl -s https://gateway.irys.xyz/FMe5qJbxE39iMDQqKfWqksfPAndFmwnYv4usLQUnSqVj
```

Any Arweave gateway serves the same bytes. Use a different one if you would
rather not trust `gateway.irys.xyz`:

```sh
curl -sL https://arweave.net/FMe5qJbxE39iMDQqKfWqksfPAndFmwnYv4usLQUnSqVj
```

You get:

```json
{"schema":"lyra-record/v1","trade":{"close_timestamp":1785603600000,"entry_price":"184.37","exit_price":"189.02","fees":"0.4271","open_timestamp":1785600000000,"owner":"DRzSvbp9EfSEABgLF8qPRQ6pnfBiGJ2xfXCtoYUPuDTS","pair":"SOL-PERP","pnl":"58.125","schema_version":1,"sequence":0,"side":"long","size":"12.5","strategy_id":"lyra-record-test-suite","venue":"hyperliquid","venue_address":"0x0000000000000000000000000000000000000000","venue_close_id":"test-close-0","venue_open_id":"test-open-0"},"signature":{"scheme":"ed25519","public_key":"DRzSvbp9EfSEABgLF8qPRQ6pnfBiGJ2xfXCtoYUPuDTS","value":"2NTJE6t4imXjmyh7o8KmED7WQv1R6hKBZgi1b5vjqpq3RzzK42pepmZVBUKSiEwqfWtpzCR9sq2cQXtogu8b3GGp"}}
```

## 2. Confirm it cannot have changed

Arweave has no update primitive and no delete primitive. There is no instruction
in the protocol to alter stored data and no governance mechanism that could add
one. The transaction id is a hash commitment to the data — fetch it from any
gateway and you get the same bytes or you get nothing.

This is the property a smart contract does not have. A Solana account can be
closed by whoever controls it. This cannot be removed by anyone, including the
person who wrote it.

You do not have to take that on faith: change one byte of the JSON above and its
id changes, so the altered version is a different record at a different address,
and the original is still there.

## 3. Check the proof of time

Irys returns a receipt when it accepts an upload. The receipt is an RSA-4096
signature by the Irys node over five values, deep-hashed in order:

```
"Bundlr", version, id, deadlineHeight, timestamp
```

A valid signature proves the node saw this exact transaction id at this exact
millisecond. That is what answers the obvious accusation: *you wrote this after
you knew how the trade turned out.*

The receipt is self-contained: it carries the node's public key, so it can be
checked with no network access at all. The one for this record is committed to
this repo at [`docs/example-receipt.json`](example-receipt.json), exactly as the
Irys node returned it:

```json
{
  "id": "FMe5qJbxE39iMDQqKfWqksfPAndFmwnYv4usLQUnSqVj",
  "public": "mJ9InRYCcuqNFk2A51B-Y3qo0PiUk1mgTPkhaMJZXFqQ…",
  "signature": "D9aGSAP0Wbg0Q7eG5cCyglN-Lu0cPPIqf8pJKIG7Fii2…",
  "deadlineHeight": 0,
  "timestamp": 1785617213911,
  "version": "1.0.0"
}
```

Verify it yourself. This script uses Irys's own primitives but no part of this
library:

```js
// node verify-receipt.mjs
import { deepHash, stringToBuffer, getCryptoDriver } from "@irys/bundles";
import base64url from "base64url";
import { readFileSync } from "node:fs";

const r = JSON.parse(readFileSync("./example-receipt.json", "utf8"));

const digest = await deepHash([
  stringToBuffer("Bundlr"),
  stringToBuffer(r.version),
  stringToBuffer(r.id),
  stringToBuffer(String(r.deadlineHeight)),
  stringToBuffer(String(r.timestamp)),
]);

console.log(
  "valid:", await getCryptoDriver().verify(r.public, digest, base64url.toBuffer(r.signature)),
  "\nuploaded:", new Date(r.timestamp).toISOString(),
);
```

```
valid: true
uploaded: 2026-08-01T20:46:53.911Z
```

Do not take the committed key on trust — check that it is the key Irys actually
publishes:

```sh
curl -s https://uploader.irys.xyz/public
```

It matches the `public` field byte for byte, and the signature verifies against
either one.

### Getting a receipt when you do not have the file

Irys also serves receipts from its GraphQL index:

```sh
curl -s -X POST https://arweave.mainnet.irys.xyz/graphql \
  -H 'Content-Type: application/json' \
  -d '{"query":"query { transactions(ids: [\"FMe5qJbxE39iMDQqKfWqksfPAndFmwnYv4usLQUnSqVj\"]) { edges { node { receipt { signature timestamp version deadlineHeight } } } } }"}'
```

Three honest caveats, because this route is much less reliable than the file:

**It lags by hours.** The example record was readable from the gateway
immediately and was still returning `{"edges":[]}` here an hour and a half later.
That is indexing lag, not a missing receipt.

**There is no other route.** The Irys node will tell you a transaction's tags and
status straight away:

```sh
curl -s https://uploader.irys.xyz/tx/FMe5qJbxE39iMDQqKfWqksfPAndFmwnYv4usLQUnSqVj
curl -s https://uploader.irys.xyz/tx/FMe5qJbxE39iMDQqKfWqksfPAndFmwnYv4usLQUnSqVj/status
```

but it will not give you a receipt — `/tx/<id>/receipt` returns 404. GraphQL is
the only source, and it is slow.

**The index does not return `public`,** so you must supply the node key from
`/public` yourself, and use the same `deadlineHeight` the node signed. If the
index reports a different `deadlineHeight` than the original receipt, the
signature will not verify. That is the check working correctly, not a forgery —
and it is why the receipt file is worth keeping.

**Therefore: whoever writes a record should publish its receipt.** The library
saves every receipt to `.lyra-record/<owner>/receipts/`, and

```sh
lyra-record receipt --owner <pubkey> --out receipts.json
```

prints them for publishing. A verifier then needs nothing from the index:

```sh
lyra-record verify --id <arweaveId> --receipt receipts.json
```

A record whose receipt was never published can still be checked for content and
authorship (§4) immediately, but its proof of time waits on indexing.

### What the node will confirm immediately

```sh
curl -s https://uploader.irys.xyz/tx/FMe5qJbxE39iMDQqKfWqksfPAndFmwnYv4usLQUnSqVj/status
```

```json
{"status":"CONFIRMED","seededTo":[]}
```

`CONFIRMED` means Irys has accepted and committed the upload. `seededTo: []`
means it has not yet been bundled into an Arweave transaction. Committed is not
the same as settled, and you should not let anyone tell you otherwise.

## 4. Check who claimed it

The receipt proves *when*. It does not prove *who*: anyone who knew a trade's
details could upload a document describing it. The owner signature closes that
gap.

The signed message is the ASCII prefix `lyra-record/v1:` followed by the
canonical JSON of the `trade` object. To reproduce those bytes exactly:

1. Take **only** the 17 trade fields. Not the envelope, not the signature.
2. Order the keys lexicographically by UTF-16 code unit — the order JavaScript's
   default `sort()` produces:

   ```
   close_timestamp, entry_price, exit_price, fees, open_timestamp, owner,
   pair, pnl, schema_version, sequence, side, size, strategy_id, venue,
   venue_address, venue_close_id, venue_open_id
   ```
3. Emit compact JSON: no whitespace anywhere, standard JSON string escaping.
4. The only numbers are `schema_version`, `open_timestamp`, `close_timestamp`
   and `sequence`. All four are integers, written in plain decimal, never
   exponent notation. Every price, size, PnL and fee is a **string**.
5. Encode as UTF-8 and prepend `lyra-record/v1:`.

Point 4 is not stylistic. Floats lose precision, and a ledger that silently
rounds is not a ledger. If a value here were a JSON number, `184.370000000000001`
would become `184.37` and the record would say something the venue never did.

Verify with any ed25519 implementation:

```js
// node verify-signature.mjs
import { ed25519 } from "@noble/curves/ed25519";
import bs58 from "bs58";

const doc = await (await fetch(
  "https://gateway.irys.xyz/FMe5qJbxE39iMDQqKfWqksfPAndFmwnYv4usLQUnSqVj",
)).json();

const ORDER = [
  "close_timestamp", "entry_price", "exit_price", "fees", "open_timestamp",
  "owner", "pair", "pnl", "schema_version", "sequence", "side", "size",
  "strategy_id", "venue", "venue_address", "venue_close_id", "venue_open_id",
];

const canonical =
  "{" +
  ORDER.map((k) => {
    const v = doc.trade[k];
    return JSON.stringify(k) + ":" + (typeof v === "number" ? v.toFixed(0) : JSON.stringify(v));
  }).join(",") +
  "}";

const message = Buffer.from("lyra-record/v1:" + canonical, "utf8");

console.log("canonical bytes match stored:", canonical === JSON.stringify(doc.trade, ORDER));
console.log("signature valid:", ed25519.verify(
  bs58.decode(doc.signature.value),
  message,
  bs58.decode(doc.trade.owner),
));
```

Both print `true` for the example record.

Also check that `signature.public_key` equals `trade.owner`. If they differ, the
document is signed by a key other than the one it names, and it should be
rejected outright.

## 5. Check the trade actually happened

**This is the step that matters.** Everything above proves a document existed at a
time and was signed by a key. None of it proves the trade was real. A recorder
can sign and publish a trade it invented.

The defence is `venue_address`. It is the trading wallet on the execution venue,
published on purpose, so the venue's own public data can be consulted without
anyone's permission.

For Hyperliquid, ask the venue directly:

```sh
curl -s -X POST https://api.hyperliquid.xyz/info \
  -H 'Content-Type: application/json' \
  -d '{"type":"userFillsByTime","user":"0x0000000000000000000000000000000000000000","startTime":1785600000000,"endTime":1785603600000}'
```

Compare what comes back against the record:

- a fill with order id `test-open-0` at price `184.37`
- a fill with order id `test-close-0` at price `189.02`
- size `12.5`, closed PnL `58.125`, fees `0.4271`

For our example record the venue returns:

```json
[]
```

**No fills. The trade never happened.** That is the correct outcome here — the
record is a test record claiming a trade by the zero address — and it is exactly
what you should do to a record that claims to be real. A signed, timestamped,
permanent record of a trade that the venue has never heard of is a signed,
timestamped, permanent lie, and this is how you catch it.

Run this step. The first four checks are the easy ones.

## 6. Check for omissions

Nobody can delete an Arweave record. But a dishonest recorder can simply never
write the losing ones, and a ledger of only winners is not a record.

Every record carries a `sequence` that increments monotonically per owner from 0.
A missing number is visible to anyone:

```sh
curl -s -X POST https://arweave.mainnet.irys.xyz/graphql \
  -H 'Content-Type: application/json' \
  -d '{"query":"query { transactions(tags: [{name:\"App-Name\",values:[\"lyra-record\"]},{name:\"Owner\",values:[\"DRzSvbp9EfSEABgLF8qPRQ6pnfBiGJ2xfXCtoYUPuDTS\"]}], first: 100, order: ASC) { edges { node { id tags { name value } } } } }"}'
```

Collect the `Sequence` tag from every result. If the owner's records run
0, 1, 2, 4, 5 then sequence 3 was never written and you are entitled to ask what
it was.

Two honest caveats:

**A gap is not proof of dishonesty.** A process that crashed mid-write leaves one.
So does the indexing lag from §3. It is a question worth asking, not a verdict.

**Duplicates happen, and this example has one.** Because the index lags, a writer
that loses its local bookkeeping inside the window can write the same sequence
twice. Owner `DRzSvbp9…` has exactly that: sequence 0 appears as both
`FMe5qJbxE39iMDQqKfWqksfPAndFmwnYv4usLQUnSqVj` and
`4pZANqJGrAw5aYWfU4znELKNL2AvYRfaphMKRfwhutnv`. The duplicate is real, it is
permanent, and it was produced by this repository's own test suite. It is
documented here rather than quietly cleaned up, because it cannot be cleaned up —
that is the whole point of the system — and because a system that hides its own
failure modes should not be trusted about anything else.

Tags are indexed metadata and are **not** covered by the owner signature. If a tag
and the signed body disagree, believe the body.

## 6b. A note on schema versions

The record you are checking carries its own `schema_version`. Everything above —
the field order, and the `lyra-record/vN:` prefix — follows **that** number, not
whatever version the library happens to be on.

| Version | Canonical fields |
|---|---|
| v1 | the 17 listed in §4 |
| v2 | those 17 plus `reasoning_id`, which sorts between `pnl` and `schema_version` |

`reasoning_id` is either `null` (written as the bare literal, not the string
`"null"`) or the Arweave id of a second record holding the model, prompt, schema
and raw output behind the decision. Where it is present, that record was
timestamped by Irys **before the trade resolved** — so it is a prediction you can
check, not an explanation written afterwards.

A v1 record signed in 2026 must still verify in 2036. If it ever does not, this
library is broken, not the record.

## 7. Or do all of it at once

```sh
npx @lyra-protocol/record verify \
  --id FMe5qJbxE39iMDQqKfWqksfPAndFmwnYv4usLQUnSqVj \
  --receipt docs/example-receipt.json
```

```
  pass  data-available
  pass  schema-valid
  pass  canonical-bytes
  pass  owner-signature
  pass  irys-receipt
  pass  tags-match-body
  pass  irys-committed
  pass  closed-before-upload

8 passed, 0 failed, 0 inconclusive
```

Drop `--receipt` and the proof-of-time check reports `inconclusive` instead of
failing, because the index has not caught up. Missing evidence is not a lie, and
the tool does not pretend otherwise — only a real contradiction exits non-zero.

It also prints the §5 request. It will never tell you the trade was real. It
cannot know, and neither can any other tool that is not the venue.

---

## Summary of what is and is not proven

| | Guaranteed |
|---|---|
| Records cannot be altered or deleted | **Yes.** Arweave has no primitive for either. |
| The upload timestamp is genuine | **Yes.** The Irys receipt is independently verifiable. |
| The named owner wrote it | **Yes**, if §4 verifies. |
| The trade happened | **No.** Only the venue can tell you. See §5. |
| Every trade was recorded | **No.** Sequence gaps make omission visible, not impossible. |
| Each sequence appears once | **No.** See §6. |
| The timestamp is when the trade closed | **No.** It is when the record was uploaded. |
