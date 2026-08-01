#!/usr/bin/env node
/**
 * lyra-record CLI.
 *
 *   lyra-record record --file trade.json --key <path>
 *   lyra-record query  --owner <pubkey> [--pair X] [--from ts] [--to ts]
 *   lyra-record verify --id <arweaveId>
 *   lyra-record gaps   --owner <pubkey>
 *   lyra-record export --owner <pubkey> --format csv|json
 *
 * `export` matters more than it looks: it is how someone puts their record into
 * a grant application without asking anyone for a favour.
 */

import { readFileSync, writeFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { Decimal } from "decimal.js";
import {
  findGaps,
  gatewayUrlFor,
  listPendingWrites,
  LocalStore,
  loadKey,
  nextSequence,
  queryRecords,
  recordTrade,
  resolveConfig,
  SCHEMA_VERSION,
  verifyRecord,
  type IrysReceipt,
  type QueriedRecord,
  type SignedTradeRecord,
  type TradeRecord,
} from "../src/index.js";
import { LyraRecordError, RecordUploadError } from "../src/errors.js";

const USAGE = `lyra-record — a permanent, publicly verifiable trade ledger

usage:
  lyra-record record --file <trade.json> [--key <path>] [--sequence <n>] [--dry-run]
  lyra-record query  --owner <pubkey> [--pair <PAIR>] [--venue <v>] [--strategy <id>]
                     [--from <ms>] [--to <ms>] [--limit <n>] [--sort ASC|DESC] [--json]
  lyra-record verify --id <arweaveId> [--receipt <path>] [--json]
  lyra-record gaps   --owner <pubkey> [--json]
  lyra-record export --owner <pubkey> --format csv|json [--out <path>]
  lyra-record receipt --owner <pubkey> [--sequence <n>] [--out <path>]
  lyra-record pending --owner <pubkey>

options:
  --key       path to a solana-keygen JSON file or a base58 secret key.
              Defaults to the LYRA_RECORD_KEY environment variable.
  --data-dir  where receipts and the local sequence index live. Default .lyra-record
  --sequence  override the sequence number. Default: next free one locally.
  --dry-run   sign and size the record, print it, upload nothing.
  --receipt   verify proof of time from a receipt file instead of the Irys index.

Publish your receipts. Irys serves them only from its GraphQL index, which can
lag by hours; a receipt file is self-contained and lets anyone check proof of
time straight away. "lyra-record receipt --owner <you>" prints them.

Records are written to Irys mainnet. Uploads under 100 KiB are free, so writing
a trade costs nothing. There is no devnet mode: devnet data is not retained, and
a record that expires is not a record.
`;

async function main(argv: string[]): Promise<number> {
  const command = argv[0];
  if (!command || command === "help" || command === "--help" || command === "-h") {
    process.stdout.write(USAGE);
    return command ? 0 : 1;
  }

  const { values } = parseArgs({
    args: argv.slice(1),
    allowPositionals: true,
    options: {
      file: { type: "string" },
      key: { type: "string" },
      owner: { type: "string" },
      id: { type: "string" },
      pair: { type: "string" },
      venue: { type: "string" },
      strategy: { type: "string" },
      from: { type: "string" },
      to: { type: "string" },
      limit: { type: "string" },
      sort: { type: "string" },
      format: { type: "string" },
      out: { type: "string" },
      sequence: { type: "string" },
      receipt: { type: "string" },
      "data-dir": { type: "string" },
      "dry-run": { type: "boolean" },
      json: { type: "boolean" },
    },
  });

  const config = values["data-dir"] ? { dataDir: values["data-dir"] } : {};

  switch (command) {
    case "record":
      return await cmdRecord(values, config);
    case "query":
      return await cmdQuery(values, config);
    case "verify":
      return await cmdVerify(values, config);
    case "gaps":
      return await cmdGaps(values, config);
    case "export":
      return await cmdExport(values, config);
    case "receipt":
      return cmdReceipt(values, config);
    case "pending":
      return cmdPending(values, config);
    default:
      process.stderr.write(`unknown command: ${command}\n\n${USAGE}`);
      return 1;
  }
}

type Values = Record<string, string | boolean | undefined>;
type Config = { dataDir?: string };

async function cmdRecord(values: Values, config: Config): Promise<number> {
  const file = requireString(values, "file");
  const keySource = (values.key as string | undefined) ?? process.env.LYRA_RECORD_KEY;
  if (!keySource) {
    throw new LyraRecordError(
      "no signing key. Pass --key <path> or set LYRA_RECORD_KEY.",
    );
  }
  const key = loadKey(keySource);

  const parsed = JSON.parse(readFileSync(file, "utf8")) as Partial<TradeRecord>;
  const trade: TradeRecord = {
    schema_version: SCHEMA_VERSION,
    owner: key.publicKey,
    ...parsed,
    sequence:
      values.sequence !== undefined
        ? Number(values.sequence)
        : (parsed.sequence ?? nextSequence(key.publicKey, config)),
  } as TradeRecord;

  if (values["dry-run"]) {
    const { prepareRecord } = await import("../src/record.js");
    const prepared = prepareRecord(trade, key);
    process.stdout.write(`${prepared.payload}\n`);
    process.stderr.write(
      `dry run: ${prepared.payloadBytes} bytes, sequence ${trade.sequence}, nothing uploaded\n`,
    );
    return 0;
  }

  const result = await recordTrade(trade, key, config);
  const resolved = resolveConfig(config);
  if (values.json) {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return 0;
  }
  process.stdout.write(
    [
      result.deduplicated
        ? `already recorded (sequence ${result.sequence} was written before, unchanged)`
        : `recorded sequence ${result.sequence}`,
      `  arweave id   ${result.arweaveId}`,
      `  data         ${gatewayUrlFor(result.arweaveId, resolved)}`,
      `  uploaded at  ${new Date(result.receipt.timestamp).toISOString()} (${result.receipt.timestamp})`,
      `  size         ${result.payloadBytes} bytes (free)`,
      `  receipt      ${resolved.dataDir}/${result.record.trade.owner}/receipts/`,
      "",
      `verify it:     lyra-record verify --id ${result.arweaveId}`,
      "",
    ].join("\n"),
  );
  return 0;
}

async function cmdQuery(values: Values, config: Config): Promise<number> {
  const owner = requireString(values, "owner");
  const records = await queryRecords(
    {
      owner,
      ...(values.pair ? { pair: values.pair as string } : {}),
      ...(values.venue ? { venue: values.venue as string } : {}),
      ...(values.strategy ? { strategyId: values.strategy as string } : {}),
      ...(values.from ? { from: Number(values.from) } : {}),
      ...(values.to ? { to: Number(values.to) } : {}),
      ...(values.limit ? { limit: Number(values.limit) } : {}),
      ...(values.sort === "DESC" ? { sort: "DESC" as const } : {}),
    },
    config,
  );

  if (values.json) {
    process.stdout.write(`${JSON.stringify(records, null, 2)}\n`);
    return 0;
  }
  if (records.length === 0) {
    process.stdout.write(
      `no records for ${owner}.\n` +
        `Irys indexes uploads to GraphQL with a lag of minutes, so a record written just now may not appear yet.\n`,
    );
    return 0;
  }
  printTable(records);
  const report = await findGaps(owner, config);
  process.stdout.write(`\n${formatGapLine(report)}\n`);
  return 0;
}

async function cmdVerify(values: Values, config: Config): Promise<number> {
  const id = requireString(values, "id");
  const supplied = values.receipt
    ? (JSON.parse(readFileSync(values.receipt as string, "utf8")) as IrysReceipt)
    : undefined;
  const report = await verifyRecord(id, {
    ...config,
    ...(supplied ? { receipt: supplied } : {}),
  });
  if (values.json) {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    return report.ok ? 0 : 1;
  }

  const label = { pass: "pass", fail: "FAIL", inconclusive: "  ??" } as const;
  process.stdout.write(`record ${id}\n\n`);
  for (const check of report.checks) {
    process.stdout.write(`  ${label[check.status]}  ${check.name}\n`);
    process.stdout.write(`        ${check.detail}\n`);
  }

  if (report.record) {
    const t = report.record.trade;
    process.stdout.write(
      [
        "",
        `  ${t.pair} ${t.side} sequence ${t.sequence} strategy ${t.strategy_id}`,
        `  entry ${t.entry_price}  exit ${t.exit_price}  size ${t.size}  pnl ${t.pnl}  fees ${t.fees}`,
        `  opened ${new Date(t.open_timestamp).toISOString()}  closed ${new Date(t.close_timestamp).toISOString()}`,
        "",
      ].join("\n"),
    );
  }

  if (report.reconciliation) {
    process.stdout.write("  the venue is the authority on whether this trade happened:\n\n");
    for (const step of report.reconciliation.steps) {
      process.stdout.write(`    - ${step}\n`);
    }
    if (report.reconciliation.curl) {
      process.stdout.write(`\n${indent(report.reconciliation.curl, 4)}\n`);
    }
  }

  const failed = report.checks.filter((c) => c.status === "fail").length;
  const unknown = report.checks.filter((c) => c.status === "inconclusive").length;
  process.stdout.write(
    `\n${report.checks.length - failed - unknown} passed, ${failed} failed, ${unknown} inconclusive\n`,
  );
  if (failed === 0 && unknown > 0) {
    process.stdout.write(
      "nothing is wrong with this record; some evidence is not available yet. Retry later.\n",
    );
  }
  // Only a real failure is worth a non-zero exit. Missing evidence is not a lie.
  return failed > 0 ? 1 : 0;
}

async function cmdGaps(values: Values, config: Config): Promise<number> {
  const owner = requireString(values, "owner");
  const report = await findGaps(owner, config);
  if (values.json) {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    return report.contiguous ? 0 : 1;
  }
  process.stdout.write(
    [
      `owner      ${report.owner}`,
      `records    ${report.count}`,
      `sequences  ${report.min ?? "-"}..${report.max ?? "-"}`,
      formatGapLine(report),
      "",
      "A gap is not proof of dishonesty. A crashed process leaves one, and so does",
      "an upload Irys has not indexed yet. It is a question worth asking.",
      "",
    ].join("\n"),
  );
  return report.contiguous ? 0 : 1;
}

async function cmdExport(values: Values, config: Config): Promise<number> {
  const owner = requireString(values, "owner");
  const format = (values.format as string | undefined) ?? "json";
  if (format !== "csv" && format !== "json") {
    throw new LyraRecordError(`--format must be csv or json, got ${format}`);
  }
  const records = await queryRecords({ owner }, config);
  const output = format === "csv" ? toCsv(records, config) : JSON.stringify(records, null, 2);
  writeOut(values, output);
  if (values.out) process.stderr.write(`${records.length} records\n`);
  return 0;
}

/**
 * Prints a saved receipt so it can be published.
 *
 * This matters more than it looks. Irys serves receipts only from its GraphQL
 * index, which can lag by hours, and the node has no per-transaction receipt
 * endpoint. A receipt file is self-contained — it carries the node's public key
 * — so publishing it is what lets a stranger check proof of time immediately
 * rather than waiting on an index.
 */
function cmdReceipt(values: Values, config: Config): number {
  const owner = requireString(values, "owner");
  const store = new LocalStore(resolveConfig(config).dataDir);

  if (values.sequence !== undefined) {
    const receipt = store.readReceipt(owner, Number(values.sequence));
    if (!receipt) {
      throw new LyraRecordError(
        `no saved receipt for ${owner} sequence ${values.sequence} in ${resolveConfig(config).dataDir}`,
      );
    }
    writeOut(values, JSON.stringify(receipt, null, 2));
    return 0;
  }

  const index = store.readIndex(owner);
  const all = Object.values(index)
    .sort((a, b) => a.sequence - b.sequence)
    .map((entry) => store.readReceipt(owner, entry.sequence))
    .filter((r): r is IrysReceipt => r !== undefined);
  if (all.length === 0) {
    throw new LyraRecordError(`no saved receipts for ${owner}`);
  }
  writeOut(values, JSON.stringify(all, null, 2));
  return 0;
}

function writeOut(values: Values, text: string): void {
  if (values.out) {
    writeFileSync(values.out as string, `${text}\n`, "utf8");
    process.stderr.write(`wrote ${values.out}\n`);
  } else {
    process.stdout.write(`${text}\n`);
  }
}

function cmdPending(values: Values, config: Config): number {
  const owner = requireString(values, "owner");
  const pending = listPendingWrites(owner, config);
  if (pending.length === 0) {
    process.stdout.write("no pending writes on this machine\n");
    return 0;
  }
  process.stdout.write(
    `${pending.length} write(s) started and never confirmed. Each one is a trade that is NOT in the record:\n\n`,
  );
  for (const entry of pending) {
    process.stdout.write(
      `  sequence ${entry.sequence}  attempted ${new Date(entry.attemptedAt).toISOString()}  ${entry.record.trade.pair} ${entry.record.trade.side} pnl ${entry.record.trade.pnl}\n`,
    );
  }
  return 1;
}

function toCsv(records: QueriedRecord[], config: Config): string {
  const resolved = resolveConfig(config);
  const header = [
    "sequence",
    "pair",
    "side",
    "entry_price",
    "exit_price",
    "size",
    "pnl",
    "fees",
    "open_timestamp",
    "close_timestamp",
    "open_iso",
    "close_iso",
    "venue",
    "venue_address",
    "venue_open_id",
    "venue_close_id",
    "strategy_id",
    "arweave_id",
    "uploaded_at_iso",
    "data_url",
  ];
  const rows = records
    .filter((r): r is QueriedRecord & { record: SignedTradeRecord } => r.record !== undefined)
    .map((r) => {
      const t = r.record.trade;
      return [
        t.sequence,
        t.pair,
        t.side,
        t.entry_price,
        t.exit_price,
        t.size,
        t.pnl,
        t.fees,
        t.open_timestamp,
        t.close_timestamp,
        new Date(t.open_timestamp).toISOString(),
        new Date(t.close_timestamp).toISOString(),
        t.venue,
        t.venue_address,
        t.venue_open_id,
        t.venue_close_id,
        t.strategy_id,
        r.arweaveId,
        new Date(r.uploadedAt).toISOString(),
        gatewayUrlFor(r.arweaveId, resolved),
      ].map(csvCell);
    });

  // Totals are summed with a decimal library, not floats. A ledger that rounds
  // is not a ledger.
  const totalPnl = records.reduce(
    (sum, r) => (r.record ? sum.plus(new Decimal(r.record.trade.pnl)) : sum),
    new Decimal(0),
  );
  const totalFees = records.reduce(
    (sum, r) => (r.record ? sum.plus(new Decimal(r.record.trade.fees)) : sum),
    new Decimal(0),
  );

  return [
    header.join(","),
    ...rows.map((r) => r.join(",")),
    "",
    `# ${rows.length} trades, total pnl ${totalPnl.toString()}, total fees ${totalFees.toString()}`,
    `# derived from ${resolved.graphqlUrl} — recompute it yourself, do not trust this line`,
  ].join("\n");
}

function csvCell(value: string | number): string {
  const s = String(value);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function printTable(records: QueriedRecord[]): void {
  const header = ["seq", "pair", "side", "entry", "exit", "size", "pnl", "closed", "arweave id"];
  const rows = records.map((r) => {
    const t = r.record?.trade;
    return [
      String(r.sequence),
      t?.pair ?? "-",
      t?.side ?? "-",
      t?.entry_price ?? "-",
      t?.exit_price ?? "-",
      t?.size ?? "-",
      t?.pnl ?? "-",
      t ? new Date(t.close_timestamp).toISOString().slice(0, 19).replace("T", " ") : "-",
      r.arweaveId,
    ];
  });
  const widths = header.map((h, i) =>
    Math.max(h.length, ...rows.map((row) => (row[i] ?? "").length)),
  );
  const line = (cells: string[]) =>
    cells.map((c, i) => c.padEnd(widths[i] as number)).join("  ").trimEnd();
  process.stdout.write(`${line(header)}\n`);
  process.stdout.write(`${widths.map((w) => "-".repeat(w)).join("  ")}\n`);
  for (const row of rows) process.stdout.write(`${line(row)}\n`);
}

function formatGapLine(report: {
  gaps: number[];
  duplicates: { sequence: number }[];
  contiguous: boolean;
}): string {
  const parts: string[] = [];
  parts.push(
    report.gaps.length === 0
      ? "gaps       none"
      : `gaps       ${report.gaps.join(", ")}  <- these sequence numbers were never written`,
  );
  if (report.duplicates.length > 0) {
    parts.push(
      `duplicates ${report.duplicates.map((d) => d.sequence).join(", ")}  <- written more than once`,
    );
  }
  return parts.join("\n");
}

function requireString(values: Values, name: string): string {
  const value = values[name];
  if (typeof value !== "string" || value.length === 0) {
    throw new LyraRecordError(`--${name} is required`);
  }
  return value;
}

function indent(text: string, spaces: number): string {
  const pad = " ".repeat(spaces);
  return text
    .split("\n")
    .map((l) => pad + l)
    .join("\n");
}

main(process.argv.slice(2))
  .then((code) => process.exit(code))
  .catch((error: unknown) => {
    if (error instanceof RecordUploadError) {
      process.stderr.write(`error: ${error.message}\n\n`);
      process.stderr.write(`the unwritten trade:\n${JSON.stringify(error.trade, null, 2)}\n`);
      process.exit(1);
    }
    if (error instanceof LyraRecordError) {
      process.stderr.write(`error: ${error.message}\n`);
      process.exit(1);
    }
    throw error;
  });
