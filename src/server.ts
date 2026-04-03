import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { clients, offchainMainnet } from '@snapshot-labs/sx';
import { z } from 'zod';
import { gql, schemaCache } from './hub.js';
import { getWallet } from './wallet.js';

const sx = new clients.OffchainEthereumSig({
  networkConfig: offchainMainnet
});

function toContent(result: unknown) {
  return {
    content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }]
  };
}

function toError(e: unknown) {
  const message = e instanceof Error ? e.message : String(e);
  console.error('[snapshot-mcp]', message);
  return {
    content: [{ type: 'text' as const, text: `Error: ${message}` }],
    isError: true
  };
}

async function handle(fn: () => Promise<unknown>) {
  try {
    return toContent(await fn());
  } catch (e) {
    return toError(e);
  }
}

export function createMcpServer(): McpServer {
  const server = new McpServer({ name: 'snapshot', version: '0.1.0' });

  let userAddress: string | null = null;

  async function resolveUser(extra?: Record<string, unknown>): Promise<string> {
    const oauthAddress = (extra?.authInfo as any)?.extra?.userAddress as
      | string
      | undefined;
    if (oauthAddress) return oauthAddress;
    if (userAddress) return userAddress;

    const alias = await (await getWallet()).getAddress();
    const result = await gql(
      `query Aliases($where: AliasWhere) {
        aliases(first: 1, skip: 0, where: $where) {
          address
        }
      }`,
      { where: { alias } }
    );

    const found = ((result as any)?.aliases ?? [])[0]?.address;
    if (!found)
      throw new Error(
        `Not authorized. Visit https://snapshot.box/#/settings/alias/authorize/${alias} to authorize, then retry.`
      );

    return (userAddress = found);
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
        const from = await resolveUser(extra);
        const envelope = await sx.vote({
          signer: (await getWallet()) as any,
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

  return server;
}
