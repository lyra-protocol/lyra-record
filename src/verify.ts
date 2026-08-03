/**
 * Verification.
 *
 * Everything in this file is designed to be run by someone who does not trust
 * this library. Each function checks one thing, says which thing it checked, and
 * stops there. Nothing here reads the local store.
 *
 * The one thing this library will never do is certify its own honesty:
 * `reconcileVenue` hands back the exact public request to run against the venue
 * and leaves the conclusion to the reader.
 */

import base64url from "base64url";
import { LyraRecordError } from "./errors.js";
import {
  fetchNodePublicKey,
  fetchReceipt,
  fetchStatus,
  fetchTransaction,
  gatewayUrlFor,
  queryById,
  resolveConfig,
  TAG_NAMES,
  tagsToRecord,
} from "./irys.js";
import { findGaps } from "./query.js";
import { serialiseRecord, signingPrefixFor, validateSignedRecord, type SchemaVersion } from "./schema.js";
import { verifyTradeSignature } from "./signing.js";
import { fetchData } from "./irys.js";
import type {
  ClientConfig,
  IrysReceipt,
  SequenceReport,
  SignedTradeRecord,
  VenueReconciliation,
  VerificationCheck,
  VerificationReport,
} from "./types.js";

/**
 * Checks an Irys receipt.
 *
 * The receipt is an RSA signature by the Irys node over
 * ("Bundlr", version, id, deadlineHeight, timestamp), deep-hashed. A valid
 * signature proves the node saw this exact transaction id at this exact
 * millisecond. That is what stops the accusation that a record was written after
 * the outcome was known.
 *
 * It proves nothing about the trade itself. See `reconcileVenue` for that.
 */
export async function verifyReceipt(
  receipt: IrysReceipt,
  options: ClientConfig = {},
): Promise<boolean> {
  const { deepHash, stringToBuffer, getCryptoDriver } = await import("@irys/bundles");
  const publicKey =
    receipt.public && receipt.public.length > 0
      ? receipt.public
      : await fetchNodePublicKey(resolveConfig(options));

  const digest = await deepHash([
    stringToBuffer("Bundlr"),
    stringToBuffer(receipt.version),
    stringToBuffer(receipt.id),
    stringToBuffer(String(receipt.deadlineHeight)),
    stringToBuffer(String(receipt.timestamp)),
  ]);

  const signature = (base64url as unknown as { toBuffer(s: string): Buffer }).toBuffer(
    receipt.signature,
  );
  try {
    return await getCryptoDriver().verify(publicKey, digest, signature);
  } catch {
    return false;
  }
}

/**
 * Checks the owner signature over the canonical bytes.
 *
 * Pure computation: no network, no key material, no trust in this library beyond
 * the canonicalisation rules, which are written out in full in docs/VERIFY.md so
 * they can be reimplemented in any language.
 */
export function verifySignature(record: SignedTradeRecord): boolean {
  return verifyTradeSignature(record);
}

/** Fetches every record for an owner and reports gaps and duplicates. */
export async function verifySequence(
  owner: string,
  options: ClientConfig = {},
): Promise<SequenceReport> {
  return await findGaps(owner, options);
}

/**
 * Returns the public request that confirms a trade against the venue itself.
 *
 * Deliberately returns instructions rather than a verdict. The venue is the
 * authority on whether a trade happened; this library is only the authority on
 * what was claimed and when.
 */
export function reconcileVenue(record: SignedTradeRecord): VenueReconciliation {
  const { trade } = record;
  if (trade.venue.toLowerCase() === "hyperliquid") {
    const body = {
      type: "userFillsByTime",
      user: trade.venue_address,
      startTime: trade.open_timestamp,
      endTime: trade.close_timestamp,
    };
    const url = "https://api.hyperliquid.xyz/info";
    return {
      venue: trade.venue,
      venueAddress: trade.venue_address,
      steps: [
        `Hyperliquid positions are public. Ask Hyperliquid directly for the fills of ${trade.venue_address} between the claimed open and close.`,
        "Run the request below. It needs no API key and no account.",
        `Look for fills on ${trade.pair} with order ids ${trade.venue_open_id} (open) and ${trade.venue_close_id} (close).`,
        "Compare the venue's prices, size and fees against the record's. They should agree.",
        "If the venue reports no such fills, the record is claiming a trade that did not happen.",
      ],
      request: {
        method: "POST",
        url,
        headers: { "Content-Type": "application/json" },
        body,
      },
      curl: `curl -s -X POST ${url} \\\n  -H 'Content-Type: application/json' \\\n  -d '${JSON.stringify(body)}'`,
      expect: [
        `a fill with oid ${trade.venue_open_id} at price ${trade.entry_price}`,
        `a fill with oid ${trade.venue_close_id} at price ${trade.exit_price}`,
        `size ${trade.size}, closed pnl ${trade.pnl}, fees ${trade.fees}`,
      ],
      verdict: null,
    };
  }

  return {
    venue: trade.venue,
    venueAddress: trade.venue_address,
    steps: [
      `This record claims execution on "${trade.venue}" by ${trade.venue_address}.`,
      `Look up that address in ${trade.venue}'s own public data and find order ids ${trade.venue_open_id} and ${trade.venue_close_id}.`,
      "Compare the venue's prices, size and fees against the record's.",
      "lyra-record ships a ready-made request for Hyperliquid only. For any other venue you have to know where its public data lives — which is itself worth knowing before trusting the record.",
    ],
    request: { method: "GET", url: "" },
    curl: "",
    expect: [
      `order ${trade.venue_open_id} opening ${trade.size} ${trade.pair} at ${trade.entry_price}`,
      `order ${trade.venue_close_id} closing at ${trade.exit_price}`,
    ],
    verdict: null,
  };
}

/**
 * Runs every check that can be run on one record, in the order a sceptic would.
 *
 * Returns a report rather than throwing, because a failed check is information,
 * not an error.
 */
export async function verifyRecord(
  arweaveId: string,
  options: ClientConfig & {
    /**
     * A receipt published by the writer. Preferred over the index, because it is
     * self-contained: it carries the Irys node's public key, so proof of time can
     * be checked with no network access and no waiting for indexing.
     */
    receipt?: IrysReceipt;
  } = {},
): Promise<VerificationReport> {
  const config = resolveConfig(options);
  const checks: VerificationCheck[] = [];
  const report: VerificationReport = { arweaveId, checks, ok: false, inconclusive: false };
  const add = (name: string, status: VerificationCheck["status"], detail: string) => {
    checks.push({ name, status, passed: status === "pass", detail });
  };

  let raw: string;
  try {
    raw = await fetchData(arweaveId, config);
    add(
      "data-available",
      "pass",
      `fetched ${Buffer.byteLength(raw, "utf8")} bytes from ${gatewayUrlFor(arweaveId, config)}`,
    );
  } catch (error) {
    add("data-available", "fail", `could not fetch the record body: ${describe(error)}`);
    return finalise(report);
  }

  let record: SignedTradeRecord;
  try {
    record = validateSignedRecord(JSON.parse(raw));
    report.record = record;
    add(
      "schema-valid",
      "pass",
      `${record.schema}, sequence ${record.trade.sequence}, owner ${record.trade.owner}`,
    );
  } catch (error) {
    add("schema-valid", "fail", describe(error));
    return finalise(report);
  }

  const canonicalMatches = raw === serialiseRecord(record);
  add(
    "canonical-bytes",
    canonicalMatches ? "pass" : "fail",
    canonicalMatches
      ? "the stored bytes are exactly the canonical serialisation"
      : "the stored bytes are not the canonical serialisation; the signature still covers the canonical form, so check it below",
  );

  const signatureValid = verifySignature(record);
  add(
    "owner-signature",
    signatureValid ? "pass" : "fail",
    signatureValid
      ? `ed25519 signature by ${record.trade.owner} over "${signingPrefixFor(record.trade.schema_version as SchemaVersion)}" + canonical JSON`
      : `signature does not verify against ${record.trade.owner}. This record was not produced by the key it names.`,
  );

  let receipt: IrysReceipt | undefined;
  try {
    // A receipt supplied by the caller — the writer published theirs, say — is
    // preferred, because it is self-contained and needs no index at all. Its id
    // is checked against the record so a receipt for some other upload cannot be
    // passed off as proof of time for this one.
    if (options.receipt) {
      if (options.receipt.id !== arweaveId) {
        throw new LyraRecordError(
          `the supplied receipt is for ${options.receipt.id}, not ${arweaveId}`,
        );
      }
      receipt = options.receipt;
    } else {
      receipt = await fetchReceipt(arweaveId, config);
    }
    report.receipt = receipt;
    report.uploadedAt = receipt.timestamp;
    const receiptValid = await verifyReceipt(receipt, config);
    add(
      "irys-receipt",
      receiptValid ? "pass" : "fail",
      receiptValid
        ? `Irys signed this id at ${new Date(receipt.timestamp).toISOString()} (${receipt.timestamp})` +
          (options.receipt ? ", from the supplied receipt" : ", from the Irys index")
        : "the Irys receipt signature did not verify against the node's public key",
    );
  } catch (error) {
    // Not a failure. The evidence is simply not available, and saying "FAIL"
    // here would devalue the word for the cases that matter.
    add(
      "irys-receipt",
      "inconclusive",
      `no receipt available: ${describe(error)}. ` +
        `Irys serves receipts only from its GraphQL index, which can lag by hours, ` +
        `and the node has no per-transaction receipt endpoint. If the writer published ` +
        `their receipt file, pass it in — it is self-contained and needs no index.`,
    );
  }

  // Tags come from the Irys node rather than the GraphQL index: the node answers
  // immediately for a known id, while the index can be hours behind.
  const tx = await fetchTransaction(arweaveId, config).catch(() => null);
  const indexed = tx ? null : await queryById(arweaveId, config).catch(() => null);
  const tags = tx?.tags ?? indexed?.tags;
  if (tags) {
    const mismatches = tagMismatches(tagsToRecord(tags), record);
    add(
      "tags-match-body",
      mismatches.length === 0 ? "pass" : "fail",
      mismatches.length === 0
        ? `the tags Irys holds agree with the signed body`
        : `tags disagree with the signed body: ${mismatches.join("; ")}. ` +
          `Tags are not covered by the owner signature, so the body wins.`,
    );
  } else {
    add(
      "tags-match-body",
      "inconclusive",
      "Irys returned no metadata for this id, so its tags cannot be compared to the body",
    );
  }

  const status = await fetchStatus(arweaveId, config).catch(() => null);
  if (status) {
    const seeded = Array.isArray(status.seededTo) && status.seededTo.length > 0;
    add(
      "irys-committed",
      status.status === "CONFIRMED" ? "pass" : "fail",
      `Irys reports ${status.status}` +
        (seeded
          ? `, seeded to Arweave (${status.seededTo?.length} bundle(s))`
          : ". Not yet seeded onto Arweave — the data is committed and served, " +
            "but has not been bundled into an Arweave transaction yet."),
    );
  }

  if (receipt) {
    const closedBeforeUpload = record.trade.close_timestamp <= receipt.timestamp;
    add(
      "closed-before-upload",
      closedBeforeUpload ? "pass" : "fail",
      closedBeforeUpload
        ? `trade closed ${formatDelay(receipt.timestamp - record.trade.close_timestamp)} before it was written`
        : "the record claims the trade closed after it was uploaded, which is impossible",
    );
  } else {
    add(
      "closed-before-upload",
      "inconclusive",
      "without a receipt there is no upload time to compare the close time against",
    );
  }

  report.reconciliation = reconcileVenue(record);
  return finalise(report);
}

function finalise(report: VerificationReport): VerificationReport {
  report.ok = report.checks.every((c) => c.status === "pass");
  report.inconclusive = report.checks.some((c) => c.status === "inconclusive");
  return report;
}

/**
 * Reads an owner's whole record and reports on it as a whole: every signature,
 * every gap, every duplicate.
 */
export async function verifyOwner(
  owner: string,
  options: ClientConfig = {},
): Promise<{
  sequence: SequenceReport;
  records: { arweaveId: string; sequence: number; signatureValid: boolean }[];
  ok: boolean;
}> {
  const { queryRecords } = await import("./query.js");
  const [sequence, records] = await Promise.all([
    verifySequence(owner, options),
    queryRecords({ owner }, options),
  ]);
  const checked = records.map((r) => ({
    arweaveId: r.arweaveId,
    sequence: r.sequence,
    signatureValid: r.record ? verifySignature(r.record) : false,
  }));
  return {
    sequence,
    records: checked,
    ok: sequence.contiguous && checked.every((r) => r.signatureValid),
  };
}

function tagMismatches(tags: Record<string, string>, record: SignedTradeRecord): string[] {
  const expected: [string, string][] = [
    [TAG_NAMES.owner, record.trade.owner],
    [TAG_NAMES.venue, record.trade.venue],
    [TAG_NAMES.venueAddress, record.trade.venue_address],
    [TAG_NAMES.pair, record.trade.pair],
    [TAG_NAMES.strategyId, record.trade.strategy_id],
    [TAG_NAMES.sequence, String(record.trade.sequence)],
    [TAG_NAMES.closeTimestamp, String(record.trade.close_timestamp)],
  ];
  const problems: string[] = [];
  for (const [name, want] of expected) {
    const got = tags[name];
    if (got !== want) problems.push(`${name} is ${JSON.stringify(got)}, body says ${JSON.stringify(want)}`);
  }
  return problems;
}

function formatDelay(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  if (ms < 3_600_000) return `${(ms / 60_000).toFixed(1)}m`;
  return `${(ms / 3_600_000).toFixed(1)}h`;
}

function describe(error: unknown): string {
  if (error instanceof LyraRecordError || error instanceof Error) return error.message;
  return String(error);
}
