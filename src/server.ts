import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { clients, offchainMainnet } from '@snapshot-labs/sx';
import { z } from 'zod';
import { gql, schemaCache, toContent, toError } from './hub.js';
import { search } from './search.js';
import { getStdioWallet, getWalletForUser } from './wallet.js';

const sx = new clients.OffchainEthereumSig({
  networkConfig: offchainMainnet
});

async function handle(fn: () => Promise<unknown>) {
  try {
    return toContent(await fn());
  } catch (e) {
    return toError(e);
  }
}

export function createMcpServer({
  mode = 'stdio'
}: { mode?: 'http' | 'stdio' } = {}): McpServer {
  const server = new McpServer({ name: 'snapshot', version: '0.1.0' });

  async function resolveContext(extra?: Record<string, unknown>) {
    const oauthAddress = (extra?.authInfo as any)?.extra?.userAddress as
      | string
      | undefined;
    const oauthSignerKey = (extra?.authInfo as any)?.extra?.signerKey as
      | string
      | undefined;

    if (oauthAddress && oauthSignerKey) {
      return {
        userAddress: oauthAddress,
        signer: await getWalletForUser(oauthSignerKey)
      };
    }

    if (mode === 'http') {
      throw new Error(
        'Not authenticated. Click Connect in your MCP client to authorize with Snapshot.'
      );
    }

    const signer = getStdioWallet();
    const alias = await signer.getAddress();
    const result = await gql(
      `query Aliases($where: AliasWhere) {
        aliases(first: 1, skip: 0, where: $where) { address }
      }`,
      { where: { alias } }
    );
    const userAddress = ((result as any)?.aliases ?? [])[0]?.address;
    if (!userAddress) {
      throw new Error(
        `Not authorized. Visit https://snapshot.box/#/settings/alias/authorize/${alias} to authorize, then retry.`
      );
    }
    return { userAddress, signer };
  }

  server.registerTool(
    'snapshot-schema',
    {
      description:
        'Returns the Snapshot GraphQL schema reference — query entry points, filter types, and key fields. Call this before snapshot-query if you are unsure of available fields or filter syntax.',
      inputSchema: {}
    },
    () => handle(() => schemaCache)
  );

  server.registerTool(
    'snapshot-query',
    {
      description:
        'Execute any GraphQL query against the Snapshot API. Use snapshot-schema first to discover available queries, filters, and fields.',
      inputSchema: {
        query: z.string().describe('GraphQL query string'),
        variables: z
          .record(z.unknown())
          .optional()
          .describe('GraphQL variables')
      }
    },
    ({ query, variables }) => handle(() => gql(query, variables))
  );

  server.registerTool(
    'snapshot-vote',
    {
      description:
        'Cast a vote on a Snapshot proposal. Automatically resolves the authorized user. If not yet authorized, returns the authorization URL for the user to visit. Always fetch the proposal first with snapshot-query to confirm it is active and to get the correct voting type and choices.',
      inputSchema: {
        space: z.string().describe('Space ID (e.g. "ens.eth")'),
        proposal: z.string().describe('Proposal ID (hex string)'),
        choice: z
          .union([z.number(), z.array(z.number()), z.record(z.number())])
          .describe(
            'Vote choice — number for single-choice/basic, array for approval/ranked-choice, object for weighted/quadratic'
          ),
        reason: z.string().optional().describe('Reason for the vote'),
        type: z
          .enum([
            'basic',
            'single-choice',
            'approval',
            'ranked-choice',
            'weighted',
            'quadratic'
          ])
          .optional()
          .describe('Voting type (defaults to "basic")')
      }
    },
    (data, extra) =>
      handle(async () => {
        const { userAddress: from, signer } = await resolveContext(extra);
        const envelope = await sx.vote({
          signer: signer as any,
          data: {
            ...data,
            from,
            reason: data.reason ?? '',
            type: data.type ?? 'basic',
            privacy: 'none',
            app: 'snapshot-mcp',
            authenticator: '',
            strategies: [],
            metadataUri: ''
          }
        });
        return sx.send(envelope);
      })
  );

  server.registerTool(
    'snapshot-search',
    {
      description:
        'Semantic search across Snapshot proposals and spaces. Uses vector embeddings + text search (BM25) with rank fusion for high-quality results. Use this to find proposals or spaces by topic, keyword, or natural language query. Returns scored results sorted by relevance.',
      inputSchema: {
        q: z.string().describe('Search query (natural language or keywords)'),
        space: z
          .string()
          .optional()
          .describe(
            'Filter proposals by space ID (e.g. "ens.eth"). Cannot be used with type "space".'
          ),
        type: z
          .enum(['proposal', 'space'])
          .optional()
          .describe('Limit to "proposal" or "space". Omit to search both.')
      }
    },
    ({ q, space, type }) => handle(() => search(q, space, type))
  );

  return server;
}
