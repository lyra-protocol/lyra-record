import type { TradeRecord } from "./types.js";

export class LyraRecordError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = new.target.name;
  }
}

/** The trade or the uploaded envelope does not match the schema. */
export class SchemaError extends LyraRecordError {}

/** A signing key could not be read, or is not a valid ed25519 key. */
export class KeyError extends LyraRecordError {}

/**
 * A different record already occupies this owner's sequence number.
 *
 * Sequence numbers are the only defence against silent omission, so the library
 * refuses to overwrite the meaning of one that is already spent.
 */
export class SequenceConflictError extends LyraRecordError {
  constructor(
    message: string,
    readonly owner: string,
    readonly sequence: number,
    readonly existingArweaveId: string,
  ) {
    super(message);
  }
}

/**
 * The payload is too large to upload for free.
 *
 * Thrown before contacting the network so that an unfunded key never quietly
 * incurs a charge.
 */
export class PayloadTooLargeError extends LyraRecordError {
  constructor(
    message: string,
    readonly payloadBytes: number,
    readonly limitBytes: number,
  ) {
    super(message);
  }
}

/**
 * The upload failed. The unwritten trade is attached so the caller can queue it
 * and retry: a hole in the ledger caused by a swallowed exception would defeat
 * the whole project.
 */
export class RecordUploadError extends LyraRecordError {
  constructor(
    message: string,
    readonly trade: TradeRecord,
    options?: { cause?: unknown },
  ) {
    super(message, options);
  }
}

/** A record could not be fetched or was not found. */
export class RecordNotFoundError extends LyraRecordError {}
