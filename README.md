# Snapshot MCP

A [Model Context Protocol](https://modelcontextprotocol.io) server for the Snapshot API. Lets AI assistants query spaces, proposals, votes, and voting power directly from Snapshot's GraphQL API. Available as a hosted service at `https://mcp.snapshot.box`.

## Tools

### `snapshot-schema`

Returns the Snapshot GraphQL schema — query entry points, filter types, and field definitions. Call this first when unsure of available fields or filter syntax.

No inputs required.

### `snapshot-query`

Executes any GraphQL query against the Snapshot API (`https://hub.snapshot.org/graphql`).

| Input | Type | Description |
|-------|------|-------------|
| `query` | `string` | GraphQL query string |
| `variables` | `object` | GraphQL variables (optional) |

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

**Example — search for spaces:**
```graphql
query {
  ranking(first: 5, where: { search: "uniswap" }) {
    items {
      id
      name
      followersCount
      proposalsCount
    }
  }
}
```

## Usage

### Claude Desktop / Claude.ai

Add to your MCP client configuration:

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

The server listens on port `8080` by default. Copy `.env.example` to `.env` and configure:

| Variable | Description |
|----------|-------------|
| `SNAPSHOT_API_KEY` | [Snapshot API key](https://docs.snapshot.box/tools/api/api-keys) for higher rate limits (optional) |

## Development

```bash
bun dev      # watch mode
bun lint     # ESLint
bun format   # Prettier
```

