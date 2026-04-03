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

### `snapshot-vote`

Casts a vote on a Snapshot proposal. Automatically resolves the authorized user. If not yet authorized, returns the authorization URL for the user to visit.

| Input | Type | Description |
|-------|------|-------------|
| `space` | `string` | Space ID (e.g. `"ens.eth"`) |
| `proposal` | `string` | Proposal ID (hex string) |
| `choice` | `number \| number[] \| object` | Vote choice — number for single-choice/basic, array for approval/ranked-choice, object for weighted/quadratic |
| `reason` | `string` | Reason for the vote (optional) |
| `type` | `string` | Voting type: `basic`, `single-choice`, `approval`, `ranked-choice`, `weighted`, `quadratic` (optional, defaults to `basic`) |

> **Note:** `snapshot-vote` requires a wallet to be configured for signing (see below). Without a wallet, it returns a configuration error.

## Usage

### Hosted (Claude Desktop / Claude.ai)

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
```

#### HTTP server

```bash
bun start
```

Listens on port `8080` by default (override with `PORT` env var).

#### Stdio (local)

```bash
bun stdio.ts
```

Claude Desktop config example:

```json
{
  "mcpServers": {
    "snapshot": {
      "command": "bun",
      "args": ["stdio.ts"],
      "cwd": "/path/to/snapshot-mcp",
      "env": {
        "ALIAS_PRIVATE_KEY": "0x..."
      }
    }
  }
}
```

## Configuration

Copy `.env.example` to `.env` and configure:

| Variable | Description |
|----------|-------------|
| `SNAPSHOT_API_KEY` | [Snapshot API key](https://docs.snapshot.box/tools/api/api-keys) for higher rate limits (optional) |
| `PORT` | HTTP server port (default: `8080`) |
| `BASE_URL` | Public URL for OAuth metadata (e.g. `https://mcp.snapshot.box`) |
| `ALIAS_PRIVATE_KEY` | Private key for the alias wallet (option 1) |
| `CDP_API_KEY_ID` | Coinbase CDP API key ID (option 2) |
| `CDP_API_KEY_SECRET` | Coinbase CDP API key secret (option 2) |
| `CDP_WALLET_SECRET` | Coinbase CDP wallet secret (option 2) |

Wallet configuration is optional. Without it, only `snapshot-schema` and `snapshot-query` are available.

## Auth flow

### HTTP (Claude Desktop / Claude.ai) — OAuth 2.0

When a wallet is configured, the HTTP server exposes OAuth 2.0 endpoints. Claude Desktop and Claude.ai will show a **"Connect" button** that triggers the flow automatically:

1. Claude redirects to `/authorize`
2. Server redirects to `snapshot.box/#/settings/alias/authorize/<alias>` with a callback URL
3. User authorizes the alias on Snapshot
4. Snapshot redirects back to `/auth/callback`
5. Server verifies authorization, generates an auth code, and redirects back to Claude
6. Claude exchanges the code for an access token at `/token`
7. All subsequent requests include the token — tools resolve the user automatically

### Stdio (local)

1. Call `snapshot-vote` — if not yet authorized, returns the authorization URL
2. User visits `snapshot.box/#/settings/alias/authorize/<alias>` to authorize
3. Call `snapshot-vote` again — works

## Development

```bash
bun dev      # watch mode
bun lint     # ESLint
bun format   # Prettier
```

