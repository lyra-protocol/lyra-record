/**
 * Owner signatures.
 *
 * The Irys receipt proves when something was uploaded and that it has not
 * changed since. It does not prove who claimed it — anyone who knows a trade's
 * details could upload a record about it. The owner signature closes that gap.
 *
 * Keys are ed25519, the same curve Solana uses, so one key can both sign records
 * and pay for (free) Irys uploads.
 */

import { readFileSync } from "node:fs";
import { ed25519 } from "@noble/curves/ed25519";
import bs58 from "bs58";
import { KeyError } from "./errors.js";
import { signingMessage } from "./schema.js";
import type { RecordSignature, SignedTradeRecord, TradeRecord } from "./types.js";
import { SCHEMA_ID } from "./schema.js";

export type OwnerKey = {
  /** Base58 ed25519 public key. This is the `owner` in every record it signs. */
  publicKey: string;
  /** 32-byte ed25519 seed. */
  seed: Uint8Array;
  /** 64-byte secret key, base58. This is the form the Irys client expects. */
  irysWallet: string;
};

/**
 * Loads a signing key.
 *
 * Accepts, in order of what people actually have:
 *   - a path to a `solana-keygen` JSON file (array of 64 bytes)
 *   - a path to a file containing a base58 secret key
 *   - a base58 secret key string (64 bytes) or a base58 seed (32 bytes)
 *
 * A 32-byte seed cannot be used to pay for uploads through the Irys Solana
 * client, but Irys uploads under the free-tier size need no payment, and the
 * client derives the same address either way.
 */
export function loadKey(source: string): OwnerKey {
  const raw = looksLikePath(source) ? readKeyFile(source) : source.trim();
  return keyFromSecret(raw);
}

/** Loads the key named by `LYRA_RECORD_KEY` (a path or a base58 secret). */
export function loadKeyFromEnv(envVar = "LYRA_RECORD_KEY"): OwnerKey {
  const value = process.env[envVar];
  if (!value) {
    throw new KeyError(
      `${envVar} is not set. Point it at a solana-keygen JSON file or a base58 secret key.`,
    );
  }
  return loadKey(value);
}

function looksLikePath(source: string): boolean {
  return source.includes("/") || source.includes("\\") || source.endsWith(".json");
}

function readKeyFile(path: string): string {
  let contents: string;
  try {
    contents = readFileSync(path, "utf8").trim();
  } catch (cause) {
    throw new KeyError(`cannot read key file at ${path}`, { cause });
  }
  if (contents.startsWith("[")) {
    let bytes: unknown;
    try {
      bytes = JSON.parse(contents);
    } catch (cause) {
      throw new KeyError(`key file at ${path} is not valid JSON`, { cause });
    }
    if (!Array.isArray(bytes) || bytes.some((b) => typeof b !== "number")) {
      throw new KeyError(`key file at ${path} must be an array of byte values`);
    }
    return bs58.encode(Uint8Array.from(bytes as number[]));
  }
  return contents;
}

function keyFromSecret(base58Secret: string): OwnerKey {
  let bytes: Uint8Array;
  try {
    bytes = bs58.decode(base58Secret);
  } catch (cause) {
    throw new KeyError("key is not valid base58", { cause });
  }
  if (bytes.length !== 64 && bytes.length !== 32) {
    throw new KeyError(
      `key must decode to 32 bytes (seed) or 64 bytes (secret key), got ${bytes.length}`,
    );
  }
  const seed = bytes.slice(0, 32);
  const derived = ed25519.getPublicKey(seed);
  if (bytes.length === 64) {
    const embedded = bytes.slice(32);
    if (!equalBytes(derived, embedded)) {
      throw new KeyError(
        "key is malformed: the public half does not match the private half",
      );
    }
  }
  const secretKey = new Uint8Array(64);
  secretKey.set(seed, 0);
  secretKey.set(derived, 32);
  return {
    publicKey: bs58.encode(derived),
    seed,
    irysWallet: bs58.encode(secretKey),
  };
}

function equalBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= (a[i] as number) ^ (b[i] as number);
  return diff === 0;
}

/** Signs a trade, producing the envelope that gets uploaded. */
export function signTrade(trade: TradeRecord, key: OwnerKey): SignedTradeRecord {
  if (trade.owner !== key.publicKey) {
    throw new KeyError(
      `trade.owner is ${trade.owner} but the signing key is ${key.publicKey}. ` +
        `A record must be signed by the key it names as owner.`,
    );
  }
  const signature = ed25519.sign(signingMessage(trade), key.seed);
  return {
    schema: SCHEMA_ID,
    trade,
    signature: {
      scheme: "ed25519",
      public_key: key.publicKey,
      value: bs58.encode(signature),
    },
  };
}

/**
 * Checks a signature over the canonical bytes.
 *
 * Needs no network and no key material — a stranger can run this on a record
 * downloaded from any Arweave gateway.
 */
export function verifyTradeSignature(record: {
  trade: TradeRecord;
  signature: RecordSignature;
}): boolean {
  if (record.signature.scheme !== "ed25519") return false;
  if (record.signature.public_key !== record.trade.owner) return false;
  let signature: Uint8Array;
  let publicKey: Uint8Array;
  try {
    signature = bs58.decode(record.signature.value);
    publicKey = bs58.decode(record.signature.public_key);
  } catch {
    return false;
  }
  if (signature.length !== 64 || publicKey.length !== 32) return false;
  try {
    return ed25519.verify(signature, signingMessage(record.trade), publicKey);
  } catch {
    return false;
  }
}
