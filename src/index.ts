/**
 * @lyra-protocol/record
 *
 * A permanent, publicly verifiable trade ledger for autonomous trading agents.
 * Each closed trade is written to Arweave through Irys, which returns a receipt
 * timestamping the upload to the millisecond.
 *
 * What this guarantees:
 *   - records cannot be altered or deleted, by anyone, including their author
 *   - the receipt proves when a record was uploaded
 *   - the owner signature proves which key claimed it
 *
 * What it does not guarantee:
 *   - that every trade was recorded (see `findGaps`)
 *   - that a recorded trade happened (see `reconcileVenue`)
 *
 * Lyra is the first user of this library, not the only one.
 */

export type {
  ClientConfig,
  IrysReceipt,
  Network,
  QueriedRecord,
  QueryFilter,
  RecordResult,
  RecordSignature,
  SequenceReport,
  Side,
  SignatureScheme,
  SignedTradeRecord,
  TradeRecord,
  VenueReconciliation,
  VerificationCheck,
  VerificationReport,
} from "./types.js";

export {
  LyraRecordError,
  KeyError,
  PayloadTooLargeError,
  RecordNotFoundError,
  RecordUploadError,
  SchemaError,
  SequenceConflictError,
} from "./errors.js";

export {
  CANONICAL_FIELD_ORDER,
  SCHEMA_ID,
  SCHEMA_VERSION,
  SIGNING_PREFIX,
  canonicalise,
  serialiseRecord,
  signingMessage,
  tradeDigest,
  validateSignedRecord,
  validateTrade,
} from "./schema.js";

export {
  loadKey,
  loadKeyFromEnv,
  signTrade,
  verifyTradeSignature,
  type OwnerKey,
} from "./signing.js";

export {
  assertFreeTier,
  buildTags,
  listPendingWrites,
  nextSequence,
  prepareRecord,
  recordTrade,
  type RecordOptions,
} from "./record.js";

export { findGaps, getRecord, queryRecords, sequenceReport } from "./query.js";

export {
  reconcileVenue,
  verifyOwner,
  verifyReceipt,
  verifyRecord,
  verifySequence,
  verifySignature,
} from "./verify.js";

export {
  APP_NAME,
  DEFAULT_GATEWAY_URL,
  DEFAULT_GRAPHQL_URL,
  DEFAULT_UPLOADER_URL,
  FREE_TIER_BYTES,
  MAX_PAYLOAD_BYTES,
  TAG_NAMES,
  gatewayUrlFor,
  resolveConfig,
} from "./irys.js";

export { LocalStore, type IndexEntry, type PendingEntry } from "./store.js";
