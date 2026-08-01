/**
 * The local store: receipts, a sequence index, and a pending journal.
 *
 * This is a durability aid for the writer, not a source of truth for readers.
 * Anyone verifying the record uses Irys and Arweave; nothing here is trusted by
 * `verify.ts`. It exists for two reasons:
 *
 *   1. Irys indexes uploads to GraphQL slowly — hours, in measured practice — so
 *      a retry cannot rely on a remote lookup to spot a duplicate.
 *   2. A receipt is the proof of time and is not recoverable if lost.
 */

import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import type { IrysReceipt, SignedTradeRecord, TradeRecord } from "./types.js";

export type IndexEntry = {
  sequence: number;
  arweaveId: string;
  /** SHA-256 of the canonical trade JSON. Distinguishes a retry from a conflict. */
  digest: string;
  /** Millisecond epoch the Irys node stamped on the upload. */
  uploadedAt: number;
  payloadBytes: number;
};

export type PendingEntry = {
  sequence: number;
  digest: string;
  /** Millisecond epoch when the upload was attempted. */
  attemptedAt: number;
  record: SignedTradeRecord;
};

export class LocalStore {
  constructor(private readonly dataDir: string) {}

  private ownerDir(owner: string): string {
    return join(this.dataDir, owner);
  }

  private indexPath(owner: string): string {
    return join(this.ownerDir(owner), "index.json");
  }

  private receiptsDir(owner: string): string {
    return join(this.ownerDir(owner), "receipts");
  }

  private pendingDir(owner: string): string {
    return join(this.ownerDir(owner), "pending");
  }

  readIndex(owner: string): Record<string, IndexEntry> {
    const path = this.indexPath(owner);
    if (!existsSync(path)) return {};
    try {
      return JSON.parse(readFileSync(path, "utf8")) as Record<string, IndexEntry>;
    } catch {
      // A corrupt index must not stop a write, but it must not silently claim
      // the ledger is empty either. Callers still check Irys before uploading.
      return {};
    }
  }

  getEntry(owner: string, sequence: number): IndexEntry | undefined {
    return this.readIndex(owner)[String(sequence)];
  }

  /** Highest sequence recorded locally, or null when there are none. */
  highestSequence(owner: string): number | null {
    const keys = Object.keys(this.readIndex(owner)).map(Number).filter(Number.isFinite);
    return keys.length === 0 ? null : Math.max(...keys);
  }

  putEntry(owner: string, entry: IndexEntry): void {
    const index = this.readIndex(owner);
    index[String(entry.sequence)] = entry;
    mkdirSync(this.ownerDir(owner), { recursive: true });
    writeAtomic(this.indexPath(owner), `${JSON.stringify(index, null, 2)}\n`);
  }

  /**
   * Persists the receipt next to the Arweave id. Losing this file loses the
   * self-contained proof of time; it can be partly rebuilt from GraphQL, but
   * only once the upload has been indexed.
   */
  saveReceipt(owner: string, sequence: number, receipt: IrysReceipt): string {
    const dir = this.receiptsDir(owner);
    mkdirSync(dir, { recursive: true });
    const path = join(dir, `${String(sequence).padStart(9, "0")}-${receipt.id}.json`);
    writeAtomic(path, `${JSON.stringify(receipt, null, 2)}\n`);
    return path;
  }

  readReceipt(owner: string, sequence: number): IrysReceipt | undefined {
    const dir = this.receiptsDir(owner);
    if (!existsSync(dir)) return undefined;
    const prefix = `${String(sequence).padStart(9, "0")}-`;
    const file = readdirSync(dir).find((name) => name.startsWith(prefix));
    if (!file) return undefined;
    try {
      return JSON.parse(readFileSync(join(dir, file), "utf8")) as IrysReceipt;
    } catch {
      return undefined;
    }
  }

  /**
   * Marks a write as in flight before it is attempted.
   *
   * If the process dies mid-upload the marker stays behind, so a crash shows up
   * as a pending entry rather than as a silent hole.
   */
  markPending(owner: string, entry: PendingEntry): void {
    const dir = this.pendingDir(owner);
    mkdirSync(dir, { recursive: true });
    writeAtomic(
      join(dir, `${String(entry.sequence).padStart(9, "0")}.json`),
      `${JSON.stringify(entry, null, 2)}\n`,
    );
  }

  clearPending(owner: string, sequence: number): void {
    const path = join(this.pendingDir(owner), `${String(sequence).padStart(9, "0")}.json`);
    if (existsSync(path)) rmSync(path);
  }

  /** Writes that were started and never confirmed. Each one needs a retry. */
  listPending(owner: string): PendingEntry[] {
    const dir = this.pendingDir(owner);
    if (!existsSync(dir)) return [];
    const entries: PendingEntry[] = [];
    for (const name of readdirSync(dir).sort()) {
      if (!name.endsWith(".json")) continue;
      try {
        entries.push(JSON.parse(readFileSync(join(dir, name), "utf8")) as PendingEntry);
      } catch {
        // Skip unreadable markers rather than failing the whole listing.
      }
    }
    return entries;
  }

  /** Next unused sequence for an owner, based on what this machine knows. */
  nextSequence(owner: string): number {
    const highest = this.highestSequence(owner);
    const pending = this.listPending(owner).map((p) => p.sequence);
    const highestPending = pending.length === 0 ? null : Math.max(...pending);
    const candidates = [highest, highestPending].filter((n): n is number => n !== null);
    return candidates.length === 0 ? 0 : Math.max(...candidates) + 1;
  }
}

export function pendingFromRecord(record: SignedTradeRecord, digest: string): PendingEntry {
  const trade: TradeRecord = record.trade;
  return { sequence: trade.sequence, digest, attemptedAt: Date.now(), record };
}

function writeAtomic(path: string, contents: string): void {
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, contents, "utf8");
  renameSync(tmp, path);
}
