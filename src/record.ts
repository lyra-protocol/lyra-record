/**
 * The write path.
 *
 * Three properties matter more than anything else here, in this order:
 *
 *   1. A failed write is never silent. It throws, with the unwritten trade
 *      attached, so the caller can queue it and retry. A hole in the ledger
 *      caused by a swallowed exception would defeat the whole project.
 *   2. A retry never duplicates. Sequence numbers are the only defence against
 *      omission, so each one means exactly one record.
 *   3. A write never quietly costs money. The payload is measured against the
 *      free tier before the network is touched.
 */

import {
  PayloadTooLargeError,
  RecordUploadError,
  SequenceConflictError,
} from "./errors.js";
import {
  APP_NAME,
  createUploader,
  fetchData,
  MAX_PAYLOAD_BYTES,
  queryByTags,
  resolveConfig,
  TAG_NAMES,
  type ResolvedConfig,
} from "./irys.js";
import {
  SCHEMA_VERSION,
  serialiseRecord,
  tradeDigest,
  validateSignedRecord,
  validateTrade,
} from "./schema.js";
import { signTrade, type OwnerKey } from "./signing.js";
import { LocalStore, pendingFromRecord } from "./store.js";
import type {
  ClientConfig,
  IrysReceipt,
  RecordResult,
  SignedTradeRecord,
  TradeRecord,
} from "./types.js";

export type RecordOptions = ClientConfig & {
  /**
   * Skip the remote duplicate check. Only sensible when the caller has already
   * established that the sequence is free; it trades safety for one round trip.
   */
  skipRemoteCheck?: boolean;
};

/**
 * Writes one closed trade to Arweave through Irys.
 *
 * Returns the Arweave id and the receipt. The receipt is the proof of time: it
 * is signed by the Irys node and timestamps the upload to the millisecond.
 *
 * On duplicates, measured against Irys mainnet rather than assumed:
 *
 *   - A retry with the same sequence returns the existing record instead of
 *     writing a second one.
 *   - The local store answers first and is authoritative for whatever this
 *     machine has written.
 *   - The remote check is a backstop, and it has a hole. Irys indexes uploads to
 *     GraphQL slowly — hours, in measured practice — so a recently written
 *     record is invisible to it. If the local store is lost inside that window, this
 *     function will write a second record at the same sequence.
 *
 * That last case cannot be fixed from here — there is no way to ask Irys "does
 * this exist" other than the index. It is reported rather than hidden: check
 * `result.remoteCheck`, and see `findGaps`, which surfaces duplicates to readers.
 * After losing a local store, wait for the index to catch up before writing.
 */
export async function recordTrade(
  trade: TradeRecord,
  key: OwnerKey,
  options: RecordOptions = {},
): Promise<RecordResult> {
  const validated = validateTrade(trade);
  const config = resolveConfig(options);
  const store = new LocalStore(config.dataDir);
  const signed = signTrade(validated, key);
  const digest = tradeDigest(validated);
  const payload = serialiseRecord(signed);
  const payloadBytes = Buffer.byteLength(payload, "utf8");

  const local = store.getEntry(validated.owner, validated.sequence);
  if (local) {
    if (local.digest !== digest) {
      throw new SequenceConflictError(
        `sequence ${validated.sequence} for ${validated.owner} is already used by a ` +
          `different trade (${local.arweaveId}). Sequence numbers are append-only: ` +
          `write this trade at the next free sequence instead.`,
        validated.owner,
        validated.sequence,
        local.arweaveId,
      );
    }
    const receipt = store.readReceipt(validated.owner, validated.sequence);
    if (receipt) {
      return {
        arweaveId: local.arweaveId,
        receipt,
        sequence: validated.sequence,
        record: signed,
        payloadBytes: local.payloadBytes,
        deduplicated: true,
        remoteCheck: "skipped",
      };
    }
  }

  let remoteCheck: RecordResult["remoteCheck"] = "skipped";
  if (!options.skipRemoteCheck) {
    const existing = await findBySequence(validated.owner, validated.sequence, config);
    remoteCheck = existing ? "hit" : "miss";
    if (existing) {
      const existingDigest = tradeDigest(existing.record.trade);
      if (existingDigest !== digest) {
        throw new SequenceConflictError(
          `sequence ${validated.sequence} for ${validated.owner} is already on Arweave ` +
            `with different content (${existing.arweaveId}). Nothing on Arweave can be ` +
            `replaced; write this trade at the next free sequence instead.`,
          validated.owner,
          validated.sequence,
          existing.arweaveId,
        );
      }
      return {
        arweaveId: existing.arweaveId,
        receipt: existing.receipt,
        sequence: validated.sequence,
        record: existing.record,
        payloadBytes: existing.payloadBytes,
        deduplicated: true,
        remoteCheck,
      };
    }
  }

  assertFreeTier(payloadBytes);

  store.markPending(validated.owner, pendingFromRecord(signed, digest));

  let receipt: IrysReceipt;
  try {
    const uploader = await createUploader(key.irysWallet, config);
    receipt = await uploader.upload(payload, { tags: buildTags(validated) });
  } catch (cause) {
    throw new RecordUploadError(
      `failed to write sequence ${validated.sequence} for ${validated.owner} to Irys: ` +
        `${describeCause(cause)}. ` +
        `The trade is attached to this error and is still unrecorded — queue it and retry. ` +
        `A pending marker was left in ${config.dataDir}.`,
      validated,
      { cause },
    );
  }

  store.saveReceipt(validated.owner, validated.sequence, stripReceipt(receipt));
  store.putEntry(validated.owner, {
    sequence: validated.sequence,
    arweaveId: receipt.id,
    digest,
    uploadedAt: receipt.timestamp,
    payloadBytes,
  });
  store.clearPending(validated.owner, validated.sequence);

  return {
    arweaveId: receipt.id,
    receipt: stripReceipt(receipt),
    sequence: validated.sequence,
    record: signed,
    payloadBytes,
    deduplicated: false,
    remoteCheck,
  };
}

/**
 * Signs a trade without uploading it.
 *
 * Useful for building a payload offline, checking its size, or handing it to a
 * separate process that holds the network connection.
 */
export function prepareRecord(
  trade: TradeRecord,
  key: OwnerKey,
): { record: SignedTradeRecord; payload: string; payloadBytes: number; digest: string } {
  const validated = validateTrade(trade);
  const record = signTrade(validated, key);
  const payload = serialiseRecord(record);
  return {
    record,
    payload,
    payloadBytes: Buffer.byteLength(payload, "utf8"),
    digest: tradeDigest(validated),
  };
}

/** Throws when a payload would leave the free tier and start costing money. */
export function assertFreeTier(payloadBytes: number): void {
  if (payloadBytes > MAX_PAYLOAD_BYTES) {
    throw new PayloadTooLargeError(
      `record body is ${payloadBytes} bytes, over the ${MAX_PAYLOAD_BYTES} byte budget ` +
        `for a free Irys upload. Uploading it would charge the signing key. ` +
        `A trade record is normally a few hundred bytes; something is wrong with this one.`,
      payloadBytes,
      MAX_PAYLOAD_BYTES,
    );
  }
}

/** The tags that make a record findable. These are the entire query layer. */
export function buildTags(trade: TradeRecord): { name: string; value: string }[] {
  return [
    { name: TAG_NAMES.appName, value: APP_NAME },
    { name: TAG_NAMES.schemaVersion, value: String(SCHEMA_VERSION) },
    { name: TAG_NAMES.owner, value: trade.owner },
    { name: TAG_NAMES.venue, value: trade.venue },
    { name: TAG_NAMES.venueAddress, value: trade.venue_address },
    { name: TAG_NAMES.pair, value: trade.pair },
    { name: TAG_NAMES.strategyId, value: trade.strategy_id },
    { name: TAG_NAMES.sequence, value: String(trade.sequence) },
    { name: TAG_NAMES.closeTimestamp, value: String(trade.close_timestamp) },
    { name: TAG_NAMES.contentType, value: "application/json" },
  ];
}

/** Looks up an owner's record at one sequence number, if Irys has indexed it. */
async function findBySequence(
  owner: string,
  sequence: number,
  config: ResolvedConfig,
): Promise<
  { arweaveId: string; record: SignedTradeRecord; receipt: IrysReceipt; payloadBytes: number } | null
> {
  const nodes = await queryByTags(
    [
      { name: TAG_NAMES.appName, values: [APP_NAME] },
      { name: TAG_NAMES.owner, values: [owner] },
      { name: TAG_NAMES.sequence, values: [String(sequence)] },
    ],
    config,
    { limit: 1 },
  );
  const node = nodes[0];
  if (!node) return null;

  const body = await fetchData(node.id, config);
  const record = validateSignedRecord(JSON.parse(body));
  const { fetchNodePublicKey } = await import("./irys.js");
  const receipt: IrysReceipt = {
    id: node.id,
    public: await fetchNodePublicKey(config),
    signature: node.receipt?.signature ?? "",
    deadlineHeight: node.receipt?.deadlineHeight ?? 0,
    timestamp: node.receipt?.timestamp ?? node.timestamp,
    version: node.receipt?.version ?? "1.0.0",
  };
  return {
    arweaveId: node.id,
    record,
    receipt,
    payloadBytes: Buffer.byteLength(body, "utf8"),
  };
}

/**
 * Extracts something useful from an upload failure.
 *
 * The Irys client wraps axios, which buries the reason in `response.data` and
 * leaves a generic message on top. Losing that detail turns a diagnosable problem
 * (rate limited, payload rejected, node down) into "it failed".
 */
function describeCause(cause: unknown): string {
  if (typeof cause !== "object" || cause === null) return String(cause);
  const err = cause as {
    message?: string;
    code?: string;
    response?: { status?: number; statusText?: string; data?: unknown };
  };
  const parts: string[] = [];
  if (err.response?.status) {
    parts.push(`HTTP ${err.response.status}${err.response.statusText ? ` ${err.response.statusText}` : ""}`);
  }
  if (err.response?.data !== undefined) {
    const body =
      typeof err.response.data === "string"
        ? err.response.data
        : JSON.stringify(err.response.data);
    if (body) parts.push(body.slice(0, 300));
  }
  if (parts.length === 0 && err.code) parts.push(err.code);
  if (parts.length === 0 && err.message) parts.push(err.message);
  return parts.join(" — ") || "no detail available";
}

/** Drops the `verify` closure the Irys client attaches, leaving plain JSON. */
function stripReceipt(receipt: IrysReceipt & { verify?: unknown }): IrysReceipt {
  return {
    id: receipt.id,
    public: receipt.public,
    signature: receipt.signature,
    deadlineHeight: receipt.deadlineHeight,
    timestamp: receipt.timestamp,
    version: receipt.version,
    ...(receipt.validatorSignatures ? { validatorSignatures: receipt.validatorSignatures } : {}),
  };
}

/**
 * Reads the writes that were started but never confirmed on this machine.
 *
 * A non-empty result means the ledger may be missing a trade. Retry each entry.
 */
export function listPendingWrites(owner: string, options: ClientConfig = {}) {
  return new LocalStore(resolveConfig(options).dataDir).listPending(owner);
}

/** Next unused sequence number for an owner, according to the local store. */
export function nextSequence(owner: string, options: ClientConfig = {}): number {
  return new LocalStore(resolveConfig(options).dataDir).nextSequence(owner);
}
