/**
 * Types for lyra-record.
 *
 * Every monetary or quantity value is a decimal string, never a JavaScript
 * number. Floats silently lose precision and a ledger that rounds is not a
 * ledger. See `schema.ts` for the accepted format.
 */

export type Side = "long" | "short";

/**
 * A single closed trade. This is the object that gets signed and written to
 * Arweave. Field names and order are part of the wire format — see
 * `CANONICAL_FIELD_ORDER` in `schema.ts`.
 */
export type TradeRecord = {
  /** Always 1 for this release. Present so future changes never invalidate old entries. */
  schema_version: number;
  /** Public key identifying the recorder. Base58 ed25519 public key. */
  owner: string;
  /** Execution venue, e.g. "hyperliquid". */
  venue: string;
  /** The trading wallet on the venue. Public, so anyone can reconcile. */
  venue_address: string;
  /** e.g. "SOL-PERP" */
  pair: string;
  side: Side;
  /** Decimal string. */
  entry_price: string;
  /** Decimal string. */
  exit_price: string;
  /** Decimal string. */
  size: string;
  /** Signed decimal string. Negative means a loss. */
  pnl: string;
  /** Decimal string. */
  fees: string;
  /** Milliseconds since epoch, as reported by the venue. */
  open_timestamp: number;
  /** Milliseconds since epoch, as reported by the venue. */
  close_timestamp: number;
  /** Venue order id for the open. */
  venue_open_id: string;
  /** Venue order id for the close. */
  venue_close_id: string;
  /** Strategy version that produced this trade. */
  strategy_id: string;
  /** Monotonic per owner, starting at 0. A missing number is a visible gap. */
  sequence: number;
  /**
   * Arweave id of the reasoning record behind this trade — model, prompt,
   * schema, inputs and raw output (DESIGN.md §4.3).
   *
   * Null when the decision was deterministic and there is nothing to explain.
   * Required from schema v2 onward, so "no reasoning" is an explicit null rather
   * than an absence that could mean either nothing happened or something was
   * stripped.
   */
  reasoning_id: string | null;
};

export type SignatureScheme = "ed25519";

export type RecordSignature = {
  scheme: SignatureScheme;
  /** Base58 ed25519 public key. Must equal `trade.owner`. */
  public_key: string;
  /** Base58 signature over the canonical signing message. */
  value: string;
};

/** The exact JSON document uploaded to Arweave. */
export type SignedTradeRecord = {
  /** Format identifier, e.g. "lyra-record/v1". */
  schema: string;
  trade: TradeRecord;
  signature: RecordSignature;
};

/**
 * An Irys upload receipt. This is the proof of time: it is signed by the Irys
 * node and can be verified by anyone, offline, against the node's public key.
 */
export type IrysReceipt = {
  id: string;
  /** Base64url RSA public key of the signing Irys node. */
  public: string;
  /** Base64url RSA signature over (version, id, deadlineHeight, timestamp). */
  signature: string;
  deadlineHeight: number;
  /** Millisecond epoch of the upload. */
  timestamp: number;
  version: string;
  validatorSignatures?: { address: string; signature: string }[];
};

export type RecordResult = {
  /** Arweave transaction id. Data lives at https://gateway.irys.xyz/<id>. */
  arweaveId: string;
  receipt: IrysReceipt;
  sequence: number;
  /** The signed document that was uploaded. */
  record: SignedTradeRecord;
  /** Byte length of the uploaded payload. */
  payloadBytes: number;
  /**
   * True when this sequence was already on Irys (or in the local store) with
   * identical content, so nothing new was uploaded.
   */
  deduplicated: boolean;
  /**
   * What the remote duplicate check found.
   *
   *   "hit"      — Irys already had this sequence indexed
   *   "miss"     — Irys returned nothing. NOT proof that nothing exists: Irys
   *                indexes uploads to GraphQL slowly (hours, in measured
   *                practice), so a recent record is invisible here.
   *   "skipped"  — the local store answered first, or the caller opted out
   *
   * A caller that has lost its local store should treat "miss" as inconclusive.
   */
  remoteCheck: "hit" | "miss" | "skipped";
};

/** A record as returned by a query: tag metadata, plus data when fetched. */
export type QueriedRecord = {
  arweaveId: string;
  /** Uploader address (the Irys/Solana address that paid for and signed the upload). */
  address: string;
  /** Millisecond epoch the Irys node stamped on the upload. */
  uploadedAt: number;
  tags: Record<string, string>;
  sequence: number;
  /** Present when the query was run with `withData` (the default). */
  record?: SignedTradeRecord;
};

export type QueryFilter = {
  /** Base58 owner public key. Required — the record is always per owner. */
  owner: string;
  venue?: string;
  pair?: string;
  strategyId?: string;
  /** Filter on the trade's close timestamp (ms epoch), inclusive. */
  from?: number;
  /** Filter on the trade's close timestamp (ms epoch), inclusive. */
  to?: number;
  /** Max records to return. Omit for all. */
  limit?: number;
  sort?: "ASC" | "DESC";
  /** Fetch the record body from the gateway. Default true. */
  withData?: boolean;
};

export type SequenceReport = {
  owner: string;
  count: number;
  /** Lowest sequence seen, or null when there are no records. */
  min: number | null;
  /** Highest sequence seen, or null when there are no records. */
  max: number | null;
  /** Sequence numbers missing between min and max. */
  gaps: number[];
  /** Sequence numbers written more than once, with the ids that claim them. */
  duplicates: { sequence: number; arweaveIds: string[] }[];
  /** True when there are no gaps and no duplicates from 0..max. */
  contiguous: boolean;
};

/** Instructions a reader follows to confirm a trade against the venue itself. */
export type VenueReconciliation = {
  venue: string;
  venueAddress: string;
  /** Human-readable steps. */
  steps: string[];
  request: {
    method: "POST" | "GET";
    url: string;
    headers?: Record<string, string>;
    body?: unknown;
  };
  /** A ready-to-paste shell command. */
  curl: string;
  /** What to look for in the response. */
  expect: string[];
  /**
   * Deliberately absent: a verdict. This library never certifies its own
   * honesty. It tells you where to look; you decide.
   */
  verdict: null;
};

export type VerificationReport = {
  arweaveId: string;
  /** Every check that ran, in order. */
  checks: VerificationCheck[];
  /** True only when every check passed outright. */
  ok: boolean;
  /**
   * True when a check could not reach a conclusion — almost always because the
   * Irys GraphQL index has not caught up yet. Distinct from a failure: nothing
   * is wrong with the record, the evidence simply is not available yet.
   */
  inconclusive: boolean;
  record?: SignedTradeRecord;
  receipt?: IrysReceipt;
  /** Millisecond epoch of the upload, from the receipt. */
  uploadedAt?: number;
  reconciliation?: VenueReconciliation;
};

export type CheckStatus = "pass" | "fail" | "inconclusive";

export type VerificationCheck = {
  name: string;
  status: CheckStatus;
  /**
   * True only when `status` is "pass".
   *
   * An inconclusive check is not a passing check, so this stays false — a
   * verifier that reports missing evidence as success is worse than useless.
   */
  passed: boolean;
  detail: string;
};

export type Network = "mainnet";

export type ClientConfig = {
  /** Irys upload node. Defaults to https://uploader.irys.xyz. */
  uploaderUrl?: string;
  /** Irys GraphQL endpoint. Defaults to https://arweave.mainnet.irys.xyz/graphql. */
  graphqlUrl?: string;
  /** Gateway used to download record bodies. Defaults to https://gateway.irys.xyz. */
  gatewayUrl?: string;
  /** Solana RPC used by the Irys client. Only touched when funding, which we never do. */
  rpcUrl?: string;
  /** Where receipts and the local sequence index are written. Defaults to ./.lyra-record. */
  dataDir?: string;
};
