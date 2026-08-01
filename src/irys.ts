/**
 * Everything that talks to Irys or Arweave.
 *
 * Reads are plain HTTP against public endpoints — one GraphQL POST and one
 * gateway GET — so the queries in docs/VERIFY.md are literally the requests this
 * library makes. There is no indexer, no database and no backend service to
 * trust: the tags are the query layer.
 */

import { LyraRecordError, RecordNotFoundError } from "./errors.js";
import type { ClientConfig, IrysReceipt } from "./types.js";

/** Irys upload node. Mainnet only — devnet data is not retained, so it is not a record. */
export const DEFAULT_UPLOADER_URL = "https://uploader.irys.xyz";
/** Irys GraphQL endpoint for mainnet transaction metadata. */
export const DEFAULT_GRAPHQL_URL = "https://arweave.mainnet.irys.xyz/graphql";
/** Gateway used to download record bodies. arweave.net serves the same data. */
export const DEFAULT_GATEWAY_URL = "https://gateway.irys.xyz";

/** Irys uploads at or below this size are free, so a record costs nothing to write. */
export const FREE_TIER_BYTES = 100 * 1024;

/**
 * Bytes reserved for the data item header (owner key, signature, tags, nonce).
 * The free tier applies to the whole data item, not just the body, so the body
 * budget is the free tier minus this allowance. 4 KiB is far more than the ~1 KiB
 * a real header takes; the margin is deliberate, because guessing low would mean
 * quietly charging an unfunded key.
 */
export const HEADER_ALLOWANCE_BYTES = 4 * 1024;

/** Largest record body this library will upload for free. */
export const MAX_PAYLOAD_BYTES = FREE_TIER_BYTES - HEADER_ALLOWANCE_BYTES;

export const TAG_NAMES = {
  appName: "App-Name",
  schemaVersion: "Schema-Version",
  owner: "Owner",
  venue: "Venue",
  venueAddress: "Venue-Address",
  pair: "Pair",
  strategyId: "Strategy-Id",
  sequence: "Sequence",
  closeTimestamp: "Close-Timestamp",
  contentType: "Content-Type",
} as const;

export const APP_NAME = "lyra-record";

export type ResolvedConfig = Required<Omit<ClientConfig, "rpcUrl">> & { rpcUrl?: string };

export function resolveConfig(config: ClientConfig = {}): ResolvedConfig {
  return {
    uploaderUrl: trimSlash(config.uploaderUrl ?? DEFAULT_UPLOADER_URL),
    graphqlUrl: config.graphqlUrl ?? DEFAULT_GRAPHQL_URL,
    gatewayUrl: trimSlash(config.gatewayUrl ?? DEFAULT_GATEWAY_URL),
    dataDir: config.dataDir ?? ".lyra-record",
    ...(config.rpcUrl ? { rpcUrl: config.rpcUrl } : {}),
  };
}

function trimSlash(url: string): string {
  return url.replace(/\/+$/, "");
}

/**
 * Builds an Irys client bound to a wallet.
 *
 * Imported lazily so that reading and verifying records — which is what most
 * callers do, and all a sceptic needs — never pulls in the upload stack.
 */
export async function createUploader(
  irysWallet: string,
  config: ResolvedConfig,
): Promise<IrysUploader> {
  const [{ Uploader }, { Solana }] = await Promise.all([
    import("@irys/upload"),
    import("@irys/upload-solana"),
  ]);
  let builder = Uploader(Solana).withWallet(irysWallet).bundlerUrl(config.uploaderUrl);
  if (config.rpcUrl) builder = builder.withRpc(config.rpcUrl);
  return (await builder) as unknown as IrysUploader;
}

export type IrysUploader = {
  address: string;
  upload(
    data: string | Buffer,
    opts?: { tags?: { name: string; value: string }[] },
  ): Promise<IrysReceipt & { verify: () => Promise<boolean> }>;
  utils: { verifyReceipt(receipt: unknown): Promise<boolean> };
};

export type GraphqlNode = {
  id: string;
  address: string;
  timestamp: number;
  tags: { name: string; value: string }[];
  receipt?: {
    signature: string;
    timestamp: number;
    version: string;
    deadlineHeight: number;
  } | null;
};

const TRANSACTION_FIELDS = `
  id
  address
  timestamp
  tags { name value }
  receipt { signature timestamp version deadlineHeight }
`;

export type TagFilter = { name: string; values: string[] };

/**
 * Fetches every transaction matching a set of tags, following pagination.
 *
 * `order` is applied by the Irys node on upload timestamp. Callers that care
 * about trade order sort on the record's own fields instead, because upload
 * order and trade order are not the same thing.
 */
export async function queryByTags(
  tags: TagFilter[],
  config: ResolvedConfig,
  opts: { limit?: number; order?: "ASC" | "DESC" } = {},
): Promise<GraphqlNode[]> {
  const pageSize = Math.min(opts.limit ?? 100, 100);
  const order = opts.order ?? "ASC";
  const nodes: GraphqlNode[] = [];
  let after: string | undefined;

  for (;;) {
    const query = `query ($tags: [TagFilter!], $first: Int!, $order: SortOrder, $after: String) {
      transactions(tags: $tags, first: $first, order: $order, after: $after) {
        edges {
          cursor
          node {${TRANSACTION_FIELDS}}
        }
        pageInfo { hasNextPage }
      }
    }`;
    const data = await graphql<{
      transactions: {
        edges: { cursor: string; node: GraphqlNode }[];
        pageInfo: { hasNextPage: boolean };
      };
    }>(query, { tags, first: pageSize, order, after: after ?? null }, config);

    const edges = data.transactions?.edges ?? [];
    for (const edge of edges) {
      nodes.push(edge.node);
      if (opts.limit !== undefined && nodes.length >= opts.limit) return nodes;
    }
    if (!data.transactions?.pageInfo?.hasNextPage || edges.length === 0) return nodes;
    after = edges[edges.length - 1]?.cursor;
    if (!after) return nodes;
  }
}

/** Fetches one transaction's metadata by id, or null when it is not indexed yet. */
export async function queryById(
  id: string,
  config: ResolvedConfig,
): Promise<GraphqlNode | null> {
  const query = `query ($ids: [String!]) {
    transactions(ids: $ids, first: 1) {
      edges { node {${TRANSACTION_FIELDS}} }
    }
  }`;
  const data = await graphql<{ transactions: { edges: { node: GraphqlNode }[] } }>(
    query,
    { ids: [id] },
    config,
  );
  return data.transactions?.edges?.[0]?.node ?? null;
}

export type IrysTransaction = {
  id: string;
  token: string;
  /** Base58 address of the uploader (for Solana, the wallet's public key). */
  address: string;
  /** Base64url public key of the uploader. */
  owner: string;
  /** The data item's own signature by the uploader's key. */
  signature: string;
  tags: { name: string; value: string }[];
};

export type IrysStatus = {
  /** "CONFIRMED" once the Irys node has accepted and committed the upload. */
  status: string;
  /** Arweave transactions the data item has been bundled into, once seeded. */
  seededTo?: unknown[];
};

/**
 * Fetches a transaction's metadata straight from the Irys node.
 *
 * This is the endpoint the GraphQL index is not: it answers immediately, for
 * any accepted upload, with the full tag set. The index can take hours to catch
 * up, so anything that needs a single known id should come through here.
 *
 * It cannot replace GraphQL for *searching* — there is no tag search on the
 * node — which is why finding an owner's records still depends on the index.
 */
export async function fetchTransaction(
  id: string,
  config: ResolvedConfig,
): Promise<IrysTransaction | null> {
  const response = await fetch(`${config.uploaderUrl}/tx/${id}`);
  if (response.status === 404) return null;
  if (!response.ok) {
    throw new LyraRecordError(`Irys /tx/${id} returned ${response.status}`);
  }
  return (await response.json()) as IrysTransaction;
}

/** Whether the Irys node has committed an upload, and whether it has reached Arweave. */
export async function fetchStatus(
  id: string,
  config: ResolvedConfig,
): Promise<IrysStatus | null> {
  const response = await fetch(`${config.uploaderUrl}/tx/${id}/status`);
  if (response.status === 404) return null;
  if (!response.ok) {
    throw new LyraRecordError(`Irys /tx/${id}/status returned ${response.status}`);
  }
  return (await response.json()) as IrysStatus;
}

export async function graphql<T>(
  query: string,
  variables: Record<string, unknown>,
  config: ResolvedConfig,
): Promise<T> {
  const response = await fetch(config.graphqlUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ query, variables }),
  });
  if (!response.ok) {
    throw new LyraRecordError(
      `GraphQL request to ${config.graphqlUrl} failed with ${response.status}`,
    );
  }
  const body = (await response.json()) as { data?: T; errors?: { message: string }[] };
  if (body.errors?.length) {
    throw new LyraRecordError(`GraphQL error: ${body.errors.map((e) => e.message).join("; ")}`);
  }
  if (!body.data) throw new LyraRecordError("GraphQL response contained no data");
  return body.data;
}

/** Downloads a record body from the gateway. */
export async function fetchData(id: string, config: ResolvedConfig): Promise<string> {
  const response = await fetch(`${config.gatewayUrl}/${id}`);
  if (response.status === 404) {
    throw new RecordNotFoundError(`no data at ${config.gatewayUrl}/${id}`);
  }
  if (!response.ok) {
    throw new LyraRecordError(
      `gateway request for ${id} failed with ${response.status}`,
    );
  }
  return await response.text();
}

/** The Irys node's RSA public key, used to check receipt signatures. */
export async function fetchNodePublicKey(config: ResolvedConfig): Promise<string> {
  const response = await fetch(`${config.uploaderUrl}/public`);
  if (!response.ok) {
    throw new LyraRecordError(
      `could not fetch the Irys node public key from ${config.uploaderUrl}/public ` +
        `(${response.status})`,
    );
  }
  return (await response.text()).trim();
}

/**
 * Rebuilds a receipt for an upload from public data alone.
 *
 * Note the `public` key comes from the node rather than from the indexed
 * transaction, which is why a receipt saved locally at upload time is worth
 * keeping: it is self-contained.
 */
export async function fetchReceipt(
  id: string,
  config: ResolvedConfig,
): Promise<IrysReceipt> {
  const node = await queryById(id, config);
  if (!node) throw new RecordNotFoundError(`transaction ${id} is not indexed on Irys`);
  if (!node.receipt) throw new RecordNotFoundError(`transaction ${id} has no receipt`);
  return {
    id,
    public: await fetchNodePublicKey(config),
    signature: node.receipt.signature,
    deadlineHeight: node.receipt.deadlineHeight,
    timestamp: node.receipt.timestamp,
    version: node.receipt.version,
  };
}

export function tagsToRecord(tags: { name: string; value: string }[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const tag of tags) out[tag.name] = tag.value;
  return out;
}

/** Public URL for a record's body. */
export function gatewayUrlFor(id: string, config: ResolvedConfig): string {
  return `${config.gatewayUrl}/${id}`;
}
