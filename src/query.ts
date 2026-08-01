/**
 * Reading the record back.
 *
 * Every read here is a public HTTP request that anyone can make: one GraphQL
 * POST against the Irys index, one gateway GET per record body. There is no
 * database and no API key. If a query is slow, cache the result — do not add
 * infrastructure, because infrastructure is something a reader has to trust.
 */

import { RecordNotFoundError } from "./errors.js";
import {
  APP_NAME,
  fetchData,
  queryById,
  queryByTags,
  resolveConfig,
  TAG_NAMES,
  tagsToRecord,
  type GraphqlNode,
  type ResolvedConfig,
  type TagFilter,
} from "./irys.js";
import { validateSignedRecord } from "./schema.js";
import type {
  ClientConfig,
  QueriedRecord,
  QueryFilter,
  SequenceReport,
  SignedTradeRecord,
} from "./types.js";

/**
 * Fetches an owner's records.
 *
 * Results are sorted by the trade's own `sequence`, not by upload time, because
 * the two can differ: a queued retry is uploaded late but belongs where its
 * sequence says.
 *
 * Note that Irys indexes uploads to GraphQL slowly — hours, in measured practice. A record
 * that was just written is readable from the gateway and from the Irys node while
 * still missing here, because searching by tag is the one thing only the index
 * can do.
 */
export async function queryRecords(
  filter: QueryFilter,
  options: ClientConfig = {},
): Promise<QueriedRecord[]> {
  const config = resolveConfig(options);
  const withData = filter.withData !== false;

  // Metadata for every match is fetched first, unpaginated. The limit cannot be
  // pushed down to GraphQL: the node orders by upload time, and a queued retry is
  // uploaded late while belonging early. Taking the first N by upload time and
  // then sorting by sequence would silently return the wrong N.
  const nodes = await queryByTags(buildTagFilters(filter), config, { order: "ASC" });

  let results = nodes
    .map((node) => toQueriedRecord(node, tagsToRecord(node.tags)))
    .filter((r) => Number.isSafeInteger(r.sequence))
    // The close timestamp is a tag, so the time window costs no body fetches.
    .filter((r) => matchesTimeWindow(r, filter));

  results.sort((a, b) => a.sequence - b.sequence);
  if (filter.sort === "DESC") results.reverse();
  if (filter.limit !== undefined) results = results.slice(0, filter.limit);

  if (!withData) return results;

  // Bodies are fetched only for the records that survived, one gateway GET each.
  return await Promise.all(
    results.map(async (result) => ({
      ...result,
      record: validateSignedRecord(JSON.parse(await fetchData(result.arweaveId, config))),
    })),
  );
}

/** Fetches a single record by Arweave id. */
export async function getRecord(
  arweaveId: string,
  options: ClientConfig = {},
): Promise<{ record: SignedTradeRecord; node: GraphqlNode | null; raw: string }> {
  const config = resolveConfig(options);
  const raw = await fetchData(arweaveId, config);
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (cause) {
    throw new RecordNotFoundError(`${arweaveId} is not JSON`, { cause });
  }
  return {
    record: validateSignedRecord(parsed),
    node: await queryById(arweaveId, config).catch(() => null),
    raw,
  };
}

/**
 * Reports missing and duplicated sequence numbers for an owner.
 *
 * Nobody can delete an Arweave record, but a dishonest recorder can simply never
 * write a losing trade. A missing sequence number is what makes that visible.
 *
 * A gap is not proof of dishonesty — a crashed process leaves one too, and so
 * does an upload that Irys has not indexed yet. It is a question worth asking,
 * not a verdict.
 */
export async function findGaps(
  owner: string,
  options: ClientConfig = {},
): Promise<SequenceReport> {
  const config = resolveConfig(options);
  const nodes = await queryByTags(
    [
      { name: TAG_NAMES.appName, values: [APP_NAME] },
      { name: TAG_NAMES.owner, values: [owner] },
    ],
    config,
    { order: "ASC" },
  );
  return sequenceReport(owner, nodes);
}

/** Builds the report from already-fetched transaction metadata. */
export function sequenceReport(owner: string, nodes: GraphqlNode[]): SequenceReport {
  const bySequence = new Map<number, string[]>();
  for (const node of nodes) {
    const tags = tagsToRecord(node.tags);
    const raw = tags[TAG_NAMES.sequence];
    if (raw === undefined) continue;
    const sequence = Number(raw);
    if (!Number.isSafeInteger(sequence) || sequence < 0) continue;
    const ids = bySequence.get(sequence) ?? [];
    ids.push(node.id);
    bySequence.set(sequence, ids);
  }

  const sequences = [...bySequence.keys()].sort((a, b) => a - b);
  if (sequences.length === 0) {
    return { owner, count: 0, min: null, max: null, gaps: [], duplicates: [], contiguous: true };
  }

  const min = sequences[0] as number;
  const max = sequences[sequences.length - 1] as number;
  const gaps: number[] = [];
  for (let i = 0; i <= max; i++) {
    if (!bySequence.has(i)) gaps.push(i);
  }
  const duplicates = sequences
    .filter((s) => (bySequence.get(s)?.length ?? 0) > 1)
    .map((sequence) => ({ sequence, arweaveIds: bySequence.get(sequence) as string[] }));

  return {
    owner,
    count: nodes.length,
    min,
    max,
    gaps,
    duplicates,
    contiguous: gaps.length === 0 && duplicates.length === 0,
  };
}

function buildTagFilters(filter: QueryFilter): TagFilter[] {
  const tags: TagFilter[] = [
    { name: TAG_NAMES.appName, values: [APP_NAME] },
    { name: TAG_NAMES.owner, values: [filter.owner] },
  ];
  if (filter.venue) tags.push({ name: TAG_NAMES.venue, values: [filter.venue] });
  if (filter.pair) tags.push({ name: TAG_NAMES.pair, values: [filter.pair] });
  if (filter.strategyId) {
    tags.push({ name: TAG_NAMES.strategyId, values: [filter.strategyId] });
  }
  return tags;
}

function matchesTimeWindow(record: QueriedRecord, filter: QueryFilter): boolean {
  if (filter.from === undefined && filter.to === undefined) return true;
  const closeTag = record.tags[TAG_NAMES.closeTimestamp];
  const closedAt = record.record?.trade.close_timestamp ?? (closeTag ? Number(closeTag) : NaN);
  if (!Number.isFinite(closedAt)) return false;
  if (filter.from !== undefined && closedAt < filter.from) return false;
  if (filter.to !== undefined && closedAt > filter.to) return false;
  return true;
}

function toQueriedRecord(node: GraphqlNode, tags: Record<string, string>): QueriedRecord {
  return {
    arweaveId: node.id,
    address: node.address,
    uploadedAt: node.receipt?.timestamp ?? node.timestamp,
    tags,
    sequence: Number(tags[TAG_NAMES.sequence] ?? NaN),
  };
}
