/**
 * The trade schema, its validation rules, and its canonical serialisation.
 *
 * The canonical form is the contract between the writer and every future
 * verifier. A verifier that cannot reproduce these exact bytes cannot check the
 * signature, so nothing in this file may change without a new schema version.
 * The procedure is documented in full in docs/VERIFY.md.
 */

import { createHash } from "node:crypto";
import { Decimal } from "decimal.js";
import { SchemaError } from "./errors.js";
import type { SignedTradeRecord, TradeRecord } from "./types.js";

/** Value of `trade.schema_version` for this release. */
export const SCHEMA_VERSION = 1;

/** Value of the envelope's `schema` field, and the signing domain prefix. */
export const SCHEMA_ID = "lyra-record/v1";

/**
 * Domain separator prepended to the canonical JSON before signing, so a
 * signature produced here can never be replayed as a signature over some other
 * protocol's message. The signed message is:
 *
 *   utf8("lyra-record/v1:") || canonical_json_bytes
 */
export const SIGNING_PREFIX = `${SCHEMA_ID}:`;

/**
 * The canonical key order. Keys are sorted lexicographically by UTF-16 code
 * unit, which is what `Array.prototype.sort()` does by default. It is written
 * out literally rather than computed so that a verifier in another language has
 * something unambiguous to copy.
 */
export const CANONICAL_FIELD_ORDER = [
  "close_timestamp",
  "entry_price",
  "exit_price",
  "fees",
  "open_timestamp",
  "owner",
  "pair",
  "pnl",
  "schema_version",
  "sequence",
  "side",
  "size",
  "strategy_id",
  "venue",
  "venue_address",
  "venue_close_id",
  "venue_open_id",
] as const;

/** Unsigned decimal string: digits, optional single fractional part. */
const UNSIGNED_DECIMAL = /^\d+(\.\d+)?$/;
/** Signed decimal string. A leading "-" is allowed; "+" and "-0" are not. */
const SIGNED_DECIMAL = /^-?\d+(\.\d+)?$/;

const DECIMAL_FIELDS = ["entry_price", "exit_price", "size", "fees"] as const;
const SIGNED_DECIMAL_FIELDS = ["pnl"] as const;
const STRING_FIELDS = [
  "owner",
  "venue",
  "venue_address",
  "pair",
  "venue_open_id",
  "venue_close_id",
  "strategy_id",
] as const;

/**
 * Plausible bounds for an epoch-ms timestamp.
 *
 * The lower bound is what catches the common mistake: a value in seconds is a
 * valid millisecond value, just one that lands in 1970. Any real trade is after
 * 2001, and no seconds-denominated timestamp reaches 1e12 until the year 33658.
 */
const MIN_TIMESTAMP_MS = 1_000_000_000_000; // 2001-09-09T01:46:40Z
const MAX_TIMESTAMP_MS = 4_102_444_800_000; // 2100-01-01T00:00:00Z

/**
 * Validates a trade and returns it unchanged.
 *
 * Values are never normalised: "1.50" stays "1.50" and does not become "1.5".
 * Normalising would change the signed bytes, and the writer's exact string is
 * what the venue reported.
 */
export function validateTrade(trade: unknown): TradeRecord {
  if (typeof trade !== "object" || trade === null || Array.isArray(trade)) {
    throw new SchemaError("trade must be an object");
  }
  const t = trade as Record<string, unknown>;

  const unknownKeys = Object.keys(t).filter(
    (k) => !(CANONICAL_FIELD_ORDER as readonly string[]).includes(k),
  );
  if (unknownKeys.length > 0) {
    throw new SchemaError(
      `unknown field(s): ${unknownKeys.join(", ")}. The schema is closed; ` +
        `extra fields would not be covered by CANONICAL_FIELD_ORDER and so would ` +
        `not be signed.`,
    );
  }

  if (t.schema_version !== SCHEMA_VERSION) {
    throw new SchemaError(
      `schema_version must be ${SCHEMA_VERSION}, got ${JSON.stringify(t.schema_version)}`,
    );
  }

  for (const field of STRING_FIELDS) {
    const value = t[field];
    if (typeof value !== "string" || value.length === 0) {
      throw new SchemaError(`${field} must be a non-empty string`);
    }
  }

  if (t.side !== "long" && t.side !== "short") {
    throw new SchemaError(`side must be "long" or "short", got ${JSON.stringify(t.side)}`);
  }

  for (const field of DECIMAL_FIELDS) {
    assertDecimal(field, t[field], UNSIGNED_DECIMAL, "an unsigned decimal string");
  }
  for (const field of SIGNED_DECIMAL_FIELDS) {
    assertDecimal(field, t[field], SIGNED_DECIMAL, "a signed decimal string");
  }

  assertTimestamp("open_timestamp", t.open_timestamp);
  assertTimestamp("close_timestamp", t.close_timestamp);
  if ((t.close_timestamp as number) < (t.open_timestamp as number)) {
    throw new SchemaError("close_timestamp must not be earlier than open_timestamp");
  }

  if (!Number.isSafeInteger(t.sequence) || (t.sequence as number) < 0) {
    throw new SchemaError(
      `sequence must be a non-negative integer, got ${JSON.stringify(t.sequence)}`,
    );
  }

  return t as TradeRecord;
}

function assertDecimal(
  field: string,
  value: unknown,
  pattern: RegExp,
  description: string,
): void {
  if (typeof value !== "string") {
    throw new SchemaError(
      `${field} must be ${description}, got ${typeof value}. ` +
        `Numbers are rejected on purpose: JSON floats lose precision.`,
    );
  }
  if (!pattern.test(value)) {
    throw new SchemaError(`${field} must be ${description}, got ${JSON.stringify(value)}`);
  }
  // Confirms the string is something a decimal library can work with. Decimal.js
  // is arbitrary precision, so this does not round-trip through a float.
  try {
    // eslint-disable-next-line no-new
    new Decimal(value);
  } catch {
    throw new SchemaError(`${field} is not a valid decimal: ${JSON.stringify(value)}`);
  }
}

function assertTimestamp(field: string, value: unknown): void {
  if (!Number.isSafeInteger(value) || (value as number) <= 0) {
    throw new SchemaError(
      `${field} must be a positive integer of milliseconds since epoch, got ${JSON.stringify(value)}`,
    );
  }
  if ((value as number) < MIN_TIMESTAMP_MS) {
    throw new SchemaError(
      `${field} is ${value}, which is before 2001. Timestamps are milliseconds ` +
        `since epoch — this looks like seconds.`,
    );
  }
  if ((value as number) > MAX_TIMESTAMP_MS) {
    throw new SchemaError(
      `${field} is ${value}, which is beyond the year 2100. Timestamps are ` +
        `milliseconds since epoch — this looks like microseconds.`,
    );
  }
}

/**
 * Canonical JSON for a trade.
 *
 * Rules, all of which a verifier must reproduce exactly:
 *   1. Only the 17 fields in CANONICAL_FIELD_ORDER appear, in that order.
 *   2. No whitespace anywhere.
 *   3. Strings use standard JSON escaping (what JSON.stringify produces).
 *   4. The only numbers are schema_version, open_timestamp, close_timestamp and
 *      sequence. All four are integers and are written in plain decimal, never
 *      in exponent form.
 *   5. The result is encoded as UTF-8.
 */
export function canonicalise(trade: TradeRecord): string {
  const validated = validateTrade(trade);
  const parts = CANONICAL_FIELD_ORDER.map((key) => {
    const value = validated[key];
    return `${JSON.stringify(key)}:${canonicalValue(value)}`;
  });
  return `{${parts.join(",")}}`;
}

function canonicalValue(value: string | number): string {
  if (typeof value === "number") {
    // Every number in the schema is a safe integer, checked in validateTrade.
    // toFixed(0) keeps large values out of exponent notation.
    return value.toFixed(0);
  }
  return JSON.stringify(value);
}

/** The exact bytes that get signed: the domain prefix followed by canonical JSON. */
export function signingMessage(trade: TradeRecord): Buffer {
  return Buffer.from(SIGNING_PREFIX + canonicalise(trade), "utf8");
}

/**
 * SHA-256 of the canonical JSON, hex encoded.
 *
 * Used internally to tell whether two records with the same sequence number are
 * the same record (a retry) or a conflict. Not part of the signed payload.
 */
export function tradeDigest(trade: TradeRecord): string {
  return createHash("sha256").update(canonicalise(trade), "utf8").digest("hex");
}

/** Validates the envelope that actually gets uploaded. */
export function validateSignedRecord(value: unknown): SignedTradeRecord {
  if (typeof value !== "object" || value === null) {
    throw new SchemaError("record must be an object");
  }
  const r = value as Record<string, unknown>;
  if (r.schema !== SCHEMA_ID) {
    throw new SchemaError(`schema must be ${JSON.stringify(SCHEMA_ID)}, got ${JSON.stringify(r.schema)}`);
  }
  const sig = r.signature as Record<string, unknown> | undefined;
  if (!sig || typeof sig !== "object") {
    throw new SchemaError("record.signature is missing");
  }
  if (sig.scheme !== "ed25519") {
    throw new SchemaError(`unsupported signature scheme ${JSON.stringify(sig.scheme)}`);
  }
  if (typeof sig.public_key !== "string" || typeof sig.value !== "string") {
    throw new SchemaError("record.signature must have string public_key and value");
  }
  const trade = validateTrade(r.trade);
  if (sig.public_key !== trade.owner) {
    throw new SchemaError(
      `signature.public_key (${sig.public_key}) does not match trade.owner (${trade.owner})`,
    );
  }
  return { schema: SCHEMA_ID, trade, signature: sig as SignedTradeRecord["signature"] };
}

/** Serialises the envelope for upload. Deterministic, so a retry produces identical bytes. */
export function serialiseRecord(record: SignedTradeRecord): string {
  return (
    `{"schema":${JSON.stringify(record.schema)},` +
    `"trade":${canonicalise(record.trade)},` +
    `"signature":{"scheme":${JSON.stringify(record.signature.scheme)},` +
    `"public_key":${JSON.stringify(record.signature.public_key)},` +
    `"value":${JSON.stringify(record.signature.value)}}}`
  );
}
