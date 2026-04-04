# Snapshot MCP

A [Model Context Protocol](https://modelcontextprotocol.io) server for the Snapshot API. Lets AI assistants query spaces, proposals, votes, and voting power through Snapshot's GraphQL API and semantic search. Available as a public endpoint at `https://mcp.snapshot.box`.

## Tools

### `snapshot-search`

Semantic search across Snapshot proposals and spaces. Uses vector embeddings + BM25 text search with rank fusion for high-quality results.

| Input | Type | Description |
|-------|------|-------------|
| `q` | `string` | Search query (natural language or keywords) |
| `space` | `string?` | Filter proposals by space ID (e.g. `"ens.eth"`) |
| `type` | `"proposal" \| "space"?` | Limit to proposals or spaces. Omit to search both |

### `snapshot-query`

Executes any GraphQL query against the Snapshot API.

| Input | Type | Description |
|-------|------|-------------|
| `query` | `string` | GraphQL query string |
| `variables` | `object?` | GraphQL variables |

**Example — fetch active proposals for a space:**
```graphql
query ($space: String!) {
  proposals(first: 10, where: { space: $space, state: "active" }) {
    id
    title
    choices
    scores
    votes
    end
  }
}
```

### `snapshot-schema`

Returns the Snapshot GraphQL schema reference — query entry points, filter types, and field definitions. Call this before `snapshot-query` if unsure of available fields or filter syntax.

No inputs required.

## Usage

### Claude Desktop / Claude.ai

```json
{
  "mcpServers": {
    "snapshot": {
      "type": "http",
      "url": "https://mcp.snapshot.box"
    }
  }
}
```

### Self-hosting

**Requirements:** [Bun](https://bun.sh) ≥ 1.0.0

```bash
bun install
bun start
```

The server listens on port `8080` by default. Copy `.env.example` to `.env` to configure:

| Variable | Description |
|----------|-------------|
| `SNAPSHOT_API_KEY` | [Snapshot API key](https://docs.snapshot.box/tools/api/api-keys) for higher rate limits |
| `SNAPSHOT_API_URL` | GraphQL endpoint (default `https://hub.snapshot.org/graphql`) |
| `SEARCH_API_URL` | Search service endpoint (default `https://search.snapshot.box`) |

## Development

```bash
bun dev      # watch mode
bun lint     # ESLint
bun format   # Prettier
```

