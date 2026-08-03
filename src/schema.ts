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

/**
 * Version written by this release.
 *
 * v2 adds `reasoning_id`: the Arweave id of a separate record holding the model,
 * prompt, schema and raw output behind the decision. It is nullable, because a
 * trade produced by deterministic rules has no reasoning record to point at.
 */
export const SCHEMA_VERSION = 2;

/** Envelope `schema` value written by this release. */
export const SCHEMA_ID = "lyra-record/v2";

/** Every schema version this library can still verify. Nothing is ever dropped. */
export const SUPPORTED_VERSIONS = [1, 2] as const;
export type SchemaVersion = (typeof SUPPORTED_VERSIONS)[number];

/**
 * Canonical key order, per version.
 *
 * Keys are sorted lexicographically by UTF-16 code unit — what
 * `Array.prototype.sort()` does by default — and written out literally so a
 * verifier in another language has something unambiguous to copy.
 *
 * **These lists are frozen.** v1's order can never change: records signed under
 * it exist on Arweave and must stay verifiable forever. A new field means a new
 * version, never an edit to an old one.
 */
export const CANONICAL_FIELD_ORDER_V1 = [
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

/** v2: `reasoning_id` sorts between `pnl` and `schema_version`. */
export const CANONICAL_FIELD_ORDER_V2 = [
  "close_timestamp",
  "entry_price",
  "exit_price",
  "fees",
  "open_timestamp",
  "owner",
  "pair",
  "pnl",
  "reasoning_id",
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

const FIELD_ORDER: Record<SchemaVersion, readonly string[]> = {
  1: CANONICAL_FIELD_ORDER_V1,
  2: CANONICAL_FIELD_ORDER_V2,
};

/** Field order for the version this release writes. */
export const CANONICAL_FIELD_ORDER = CANONICAL_FIELD_ORDER_V2;

export function schemaIdFor(version: SchemaVersion): string {
  return `lyra-record/v${version}`;
}

/**
 * Domain separator prepended to the canonical JSON before signing, so a
 * signature produced here can never be replayed as a signature over some other
 * protocol's message. The signed message is:
 *
 *   utf8("lyra-record/v<N>:") || canonical_json_bytes
 *
 * The prefix carries the version, so a v1 record is verified with the v1 prefix
 * and the v1 field order. Verification follows the record, never this release.
 */
export function signingPrefixFor(version: SchemaVersion): string {
  return `${schemaIdFor(version)}:`;
}

/** Prefix used by the version this release writes. */
export const SIGNING_PREFIX = signingPrefixFor(SCHEMA_VERSION);

function assertSupported(version: unknown): SchemaVersion {
  if (!SUPPORTED_VERSIONS.includes(version as SchemaVersion)) {
    throw new SchemaError(
      `unsupported schema_version ${JSON.stringify(version)}; this library verifies ${SUPPORTED_VERSIONS.join(", ")}`,
    );
  }
  return version as SchemaVersion;
}

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

  // The record's own version governs how it is read — not this release's. A v1
  // record stays valid forever, which is the entire reason the field exists.
  const version = assertSupported(t.schema_version);
  const fields = FIELD_ORDER[version];

  const unknownKeys = Object.keys(t).filter((k) => !fields.includes(k));
  if (unknownKeys.length > 0) {
    throw new SchemaError(
      `unknown field(s) for schema v${version}: ${unknownKeys.join(", ")}. ` +
        `The schema is closed; extra fields would not be covered by the canonical ` +
        `field order and so would not be signed.`,
    );
  }

  // v2 added reasoning_id. It is nullable — a trade produced by deterministic
  // rules has no reasoning record — but it must be present, so that "no
  // reasoning" is an explicit null rather than an absence that could be read as
  // either a missing field or a stripped one.
  if (version >= 2) {
    if (!("reasoning_id" in t)) {
      throw new SchemaError(
        "reasoning_id is required in schema v2; use null when the decision was deterministic",
      );
    }
    const r = t.reasoning_id;
    if (r !== null && (typeof r !== "string" || !/^[A-Za-z0-9_-]{43,44}$/.test(r))) {
      throw new SchemaError(
        `reasoning_id must be null or an Arweave id, got ${JSON.stringify(r)}`,
      );
    }
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
 * Canonical JSON for a trade, in the field order of the trade's own version.
 *
 * Rules, all of which a verifier must reproduce exactly:
 *   1. Only the fields listed for that `schema_version` appear, in that order —
 *      17 for v1, 18 for v2.
 *   2. No whitespace anywhere.
 *   3. Strings use standard JSON escaping (what JSON.stringify produces).
 *   4. The only numbers are schema_version, open_timestamp, close_timestamp and
 *      sequence. All four are integers and are written in plain decimal, never
 *      in exponent form.
 *   5. `null` is written as the bare literal `null` — v2's `reasoning_id` is the
 *      only field that can take it.
 *   6. The result is encoded as UTF-8.
 */
export function canonicalise(trade: TradeRecord): string {
  const validated = validateTrade(trade);
  const fields = FIELD_ORDER[assertSupported(validated.schema_version)];
  const parts = fields.map((key) => {
    const value = (validated as unknown as Record<string, unknown>)[key];
    return `${JSON.stringify(key)}:${canonicalValue(value)}`;
  });
  return `{${parts.join(",")}}`;
}

function canonicalValue(value: unknown): string {
  if (value === null) return "null";
  if (typeof value === "number") {
    // Every number in the schema is a safe integer, checked in validateTrade.
    // toFixed(0) keeps large values out of exponent notation.
    return value.toFixed(0);
  }
  return JSON.stringify(value);
}

/**
 * The exact bytes that get signed: the version's domain prefix followed by its
 * canonical JSON.
 *
 * The prefix is derived from the trade's own `schema_version`, so verifying a v1
 * record produced under an older release reproduces the v1 bytes exactly.
 */
export function signingMessage(trade: TradeRecord): Buffer {
  const version = assertSupported(trade.schema_version);
  return Buffer.from(signingPrefixFor(version) + canonicalise(trade), "utf8");
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
  // Any supported version's envelope is accepted, and it must agree with the
  // version inside the trade — a v2 envelope wrapping a v1 trade would be signed
  // over different bytes than it claims.
  const expected = SUPPORTED_VERSIONS.map(schemaIdFor);
  if (typeof r.schema !== "string" || !expected.includes(r.schema)) {
    throw new SchemaError(
      `schema must be one of ${expected.join(", ")}, got ${JSON.stringify(r.schema)}`,
    );
  }
  const tradeVersion = (r.trade as { schema_version?: unknown } | undefined)?.schema_version;
  if (r.schema !== schemaIdFor(assertSupported(tradeVersion))) {
    throw new SchemaError(
      `envelope schema ${r.schema} does not match trade.schema_version ${JSON.stringify(tradeVersion)}`,
    );
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
  return { schema: r.schema, trade, signature: sig as SignedTradeRecord["signature"] };
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
