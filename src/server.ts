// SX's shutter encryption path does `if (window) await init()` to gate a
// browser-only init, but `window` is undeclared in Node so the bare reference
// throws. Stubbing `window` to undefined makes the check falsy; we then
// initialise shutter-crypto ourselves before the first shielded vote.
(globalThis as { window?: unknown }).window ??= undefined;

import { Wallet } from '@ethersproject/wallet';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { init as shutterInit } from '@shutter-network/shutter-crypto';
import { clients, offchainMainnet } from '@snapshot-labs/sx';
import { z } from 'zod';
import pkg from '../package.json' with { type: 'json' };
import { gql, resolveUserFromAlias, schemaCache } from './hub.js';
import { getWalletForUser } from './wallet.js';

let shutterReady: Promise<void> | undefined;
const ensureShutterReady = () => (shutterReady ??= shutterInit());

function getStdioWallet(): Wallet {
  const privateKey = process.env.ALIAS_PRIVATE_KEY;
  if (!privateKey) {
    throw new Error(
      'ALIAS_PRIVATE_KEY is required for stdio mode. Set it in .env.'
    );
  }
  return new Wallet(privateKey);
}

const sx = new clients.OffchainEthereumSig({
  networkConfig: offchainMainnet
});

async function handle(fn: () => Promise<unknown>) {
  try {
    const result = await fn();
    return {
      content: [
        { type: 'text' as const, text: JSON.stringify(result, null, 2) }
      ]
    };
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    console.error(message);
    return {
      content: [{ type: 'text' as const, text: `Error: ${message}` }],
      isError: true
    };
  }
}

const SERVER_INSTRUCTIONS = `Snapshot governance MCP. The authenticated user's address is auto-injected as the \`$user\` GraphQL variable on every snapshot-query call. Declare it in your operation (e.g. \`query Foo($user: String!) { ... }\`) and reference \`$user\` in the query body, but do NOT include \`user\` in the \`variables\` map you send; the server supplies its value automatically and will overwrite anything you pass.

To find proposals the current user can act on:
1. snapshot-query with \`follows(where: { follower: $user })\` to list spaces they follow.
2. Then \`proposals(where: { space_in: [...spaceIds], state: "active" })\` to list currently-open proposals.
3. To confirm the user can actually vote on one, query \`vp(voter: $user, space: <spaceId>, proposal: <proposalId>)\`. Voting power is evaluated at \`proposal.snapshot\` (the block when the proposal was created), not now.

A vote will only succeed if the proposal is \`state: "active"\` and the user's \`vp.vp > 0\` at that snapshot block.`;

export function createMcpServer({
  mode = 'stdio'
}: { mode?: 'http' | 'stdio' } = {}): McpServer {
  const server = new McpServer(
    {
      name: 'snapshot',
      title: 'Snapshot',
      version: pkg.version,
      websiteUrl: 'https://snapshot.box',
      icons: [
        {
          src: 'https://snapshot.box/favicon-dark.svg',
          mimeType: 'image/svg+xml',
          sizes: ['any'],
          theme: 'light'
        },
        {
          src: 'https://snapshot.box/favicon.svg',
          mimeType: 'image/svg+xml',
          sizes: ['any'],
          theme: 'dark'
        }
      ]
    },
    { instructions: SERVER_INSTRUCTIONS }
  );

  async function resolveContext(extra?: Record<string, unknown>) {
    const { user, signerKey } =
      ((extra?.authInfo as any)?.extra as
        | { user?: string; signerKey?: string }
        | undefined) ?? {};

    if (user && signerKey) {
      return { user, signer: await getWalletForUser(signerKey) };
    }

    if (mode === 'http') {
      throw new Error(
        'Not authenticated. Click Connect in your MCP client to authorize with Snapshot.'
      );
    }

    const signer = getStdioWallet();
    const alias = await signer.getAddress();
    const resolved = await resolveUserFromAlias(alias);
    if (!resolved) {
      throw new Error(
        `Not authorized. Visit https://snapshot.box/#/settings/alias/authorize/${alias} to authorize, then retry.`
      );
    }
    return { user: resolved, signer };
  }

  server.registerTool(
    'snapshot-schema',
    {
      description:
        'Returns the Snapshot GraphQL schema reference: query entry points, filter types, and key fields. Call this before snapshot-query if you are unsure of available fields or filter syntax.',
      inputSchema: {}
    },
    () => handle(() => schemaCache)
  );

  server.registerTool(
    'snapshot-query',
    {
      description:
        "Execute any GraphQL query against the Snapshot API. The authenticated user's address is auto-bound as `$user`: declare it in your operation (`query Foo($user: String!) { ... }`) and reference `$user` in the query body, but do NOT include `user` in the `variables` map (the server fills it in and overwrites anything you pass). Use snapshot-schema first to discover available queries, filters, and fields. Useful queries: `follows` (spaces a user follows), `proposals` (filter by `state` and `space_in`), `vp` (voting power for a voter on a specific proposal, evaluated at the proposal's snapshot block).",
      inputSchema: {
        query: z.string().describe('GraphQL query string'),
        variables: z
          .record(z.unknown())
          .optional()
          .describe('GraphQL variables')
      }
    },
    ({ query, variables }, extra) =>
      handle(async () => {
        let user: string | undefined;
        try {
          ({ user } = await resolveContext(extra));
        } catch {
          // anonymous read-only queries are still allowed
        }
        return gql(query, user ? { ...variables, user } : variables);
      })
  );

  server.registerTool(
    'snapshot-vote',
    {
      description:
        'Cast a vote on a Snapshot proposal. Preconditions: (a) the proposal must currently be in `state: "active"`; votes on `pending` or `closed` proposals are rejected by the hub. (b) the user must have voting power at the proposal\'s snapshot block, queryable via `vp(voter: $user, space, proposal)` on the GraphQL API. Always run snapshot-query first to fetch `state`, `type`, `choices`, `snapshot`, `privacy`, `space.id` and confirm `vp.vp > 0` for the voter. If the proposal\'s `privacy` is `"shutter"`, pass `privacy: "shutter"` so the choice is encrypted until the proposal closes. If not yet authorized, this tool returns the authorization URL for the user to visit.',
      inputSchema: {
        space: z.string().describe('Space ID (e.g. "ens.eth")'),
        proposal: z.string().describe('Proposal ID (hex string)'),
        choice: z
          .union([z.number(), z.array(z.number()), z.record(z.number())])
          .describe(
            'Vote choice. Number for single-choice/basic, array for approval/ranked-choice, object for weighted/quadratic'
          ),
        reason: z.string().default('').describe('Reason for the vote'),
        type: z
          .enum([
            'basic',
            'single-choice',
            'approval',
            'ranked-choice',
            'weighted',
            'quadratic'
          ])
          .default('basic')
          .describe('Voting type (defaults to "basic")'),
        privacy: z
          .enum(['none', 'shutter'])
          .default('none')
          .describe(
            'Privacy mode. "shutter" encrypts the choice via the Shutter network until the proposal closes. Must match the proposal\'s `privacy` field.'
          )
      }
    },
    (data, extra) =>
      handle(async () => {
        const { user: from, signer } = await resolveContext(extra);
        if (data.privacy === 'shutter') await ensureShutterReady();
        const envelope = await sx.vote({
          signer: signer as any,
          data: {
            ...data,
            from,
            app: 'snapshot-mcp',
            authenticator: '',
            strategies: [],
            metadataUri: ''
          }
        });
        const result = (await sx.send(envelope)) as { id?: string };
        return {
          result,
          links: {
            voter: `https://snapshot.box/#/profile/${from}`,
            space: `https://snapshot.box/#/${data.space}`,
            proposal: `https://snapshot.box/#/${data.space}/proposal/${data.proposal}`
          }
        };
      })
  );

  return server;
}
