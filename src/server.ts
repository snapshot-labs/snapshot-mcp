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

const SERVER_INSTRUCTIONS = `Snapshot governance MCP. Reads via snapshot-query, writes via snapshot-vote, schema introspection only on demand.

The user's address is auto-bound as \`$user\` on every snapshot-query: declare it (\`query Foo($user: String!)\`) and reference it; do NOT pass \`user\` in \`variables\`.

Common patterns:
- Find a space by name: \`spaces(where: { search: "<name>" })\`. Space \`id\` is a slug ("ens.eth"), never the display name.
- Search proposals: \`proposals(where: { title_contains: "<text>", space_in: [...] })\`.
- User profile: \`user(id: $user) { name about avatar }\`.
- Followed spaces: \`follows(where: { follower: $user })\`.
- Active proposals: \`proposals(where: { space_in: [...], state: "active" })\`.
- Voting power: \`vp(voter: $user, space, proposal)\`. Evaluated at \`proposal.snapshot\` (a block), not now.

Timestamps (\`created\`, \`start\`, \`end\`, \`updated\`) are unix seconds UTC, not ms. Format with \`new Date(t * 1000)\` and verify the year before showing dates.

Re-calling snapshot-vote on the same proposal replaces the previous vote (this is how to change a vote).`;

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
        'Returns the Snapshot GraphQL schema. Large response: call only when a snapshot-query fails on an unknown field, not preemptively. Common queries are listed in the server instructions.',
      inputSchema: {}
    },
    () => handle(() => schemaCache)
  );

  server.registerTool(
    'snapshot-query',
    {
      description:
        'Execute any GraphQL query against the Snapshot API. The user\'s address is auto-bound as $user: declare `query Foo($user: String!)` and do NOT pass `user` in `variables` (it is overwritten). Common queries: `spaces(where: { search })` to find a space by name (ids are slugs like "ens.eth", not names); `proposals(where: { space_in, state })`; `proposals(where: { title_contains })`; `vp(voter: $user, space, proposal)` for voting power; `user(id: $user) { name about }` for the user\'s profile. Timestamps are unix seconds UTC. Use snapshot-schema only when this query errors on an unknown field.',
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
        'Cast a vote on a Snapshot proposal. Re-calling this on the same proposal REPLACES the previous vote (use it to change a vote). The proposal\'s `type` and `privacy` are fetched and applied automatically; shutter-encrypted proposals strip the reason. Preconditions: proposal `state: "active"` and `vp(voter: $user, space, proposal).vp > 0`. If not yet authorized, returns the authorization URL.',
      inputSchema: {
        space: z.string().describe('Space ID (e.g. "ens.eth")'),
        proposal: z.string().describe('Proposal ID (hex string)'),
        choice: z
          .union([z.number(), z.array(z.number()), z.record(z.number())])
          .describe(
            'Vote choice. Number for single-choice/basic, array for approval/ranked-choice, object for weighted/quadratic'
          ),
        reason: z
          .string()
          .default('')
          .describe(
            'Reason for the vote (ignored on shutter-encrypted proposals)'
          )
      }
    },
    (data, extra) =>
      handle(async () => {
        const { user: from, signer } = await resolveContext(extra);
        const { proposal } = (await gql(
          'query ($id: String!) { proposal(id: $id) { type privacy } }',
          { id: data.proposal }
        )) as { proposal: { type: string; privacy: string } | null };
        if (!proposal) throw new Error(`Proposal not found: ${data.proposal}`);
        const privacy = proposal.privacy === 'shutter' ? 'shutter' : 'none';
        if (privacy === 'shutter') await ensureShutterReady();
        const envelope = await sx.vote({
          signer: signer as any,
          data: {
            ...data,
            from,
            type: proposal.type as any,
            privacy,
            reason: privacy === 'shutter' ? '' : data.reason,
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
            space: `https://snapshot.box/#/s:${data.space}`,
            proposal: `https://snapshot.box/#/s:${data.space}/proposal/${data.proposal}`
          }
        };
      })
  );

  return server;
}
