import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { gql, schemaCache, toContent, toError } from './gql.js';
import { search } from './search.js';

export function createMcpServer(): McpServer {
  const server = new McpServer({ name: 'snapshot', version: '0.1.0' });

  server.registerTool(
    'snapshot-schema',
    {
      description:
        'Returns the Snapshot GraphQL schema reference — query entry points, filter types, and key fields. Call this before snapshot-query if you are unsure of available fields or filter syntax.',
      inputSchema: {}
    },
    async () => toContent(await schemaCache)
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
    async ({ query, variables }) => {
      try {
        return toContent(await gql(query, variables));
      } catch (e) {
        return toError(e);
      }
    }
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
    async ({ q, space, type }) => {
      try {
        return toContent(await search(q, space, type));
      } catch (e) {
        return toError(e);
      }
    }
  );

  return server;
}
