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
| `SNAPSHOT_API_URL` | GraphQL endpoint (default `https://hub.snapshot.org/graphql`) |
| `SEARCH_API_URL` | Search service endpoint (default `https://search.snapshot.box`) |
| `PORT` | HTTP server port (default: `8080`) |
| `BASE_URL` | Public URL for OAuth metadata (e.g. `https://mcp.snapshot.box`) |
| `JWT_SECRET` | HS256 secret used to sign access tokens — **required for HTTP mode** (≥32 chars; `openssl rand -hex 32`) |
| `CDP_API_KEY_ID` | Coinbase CDP API key ID — **required for HTTP mode** |
| `CDP_API_KEY_SECRET` | Coinbase CDP API key secret — **required for HTTP mode** |
| `CDP_WALLET_SECRET` | Coinbase CDP wallet secret — **required for HTTP mode** |
| `ALIAS_PRIVATE_KEY` | Single private key — **stdio mode only** (ignored by HTTP server) |

The HTTP server requires CDP credentials and a JWT secret. Each user who connects via OAuth gets their own CDP-managed alias wallet, so votes can only be signed by the user who authorized the specific alias. Access tokens are stateless JWTs (HS256) signed with `JWT_SECRET`; rotating that secret invalidates every issued token.

## Auth flow

### HTTP (Claude Desktop / Claude.ai) — OAuth 2.0

The HTTP server exposes OAuth 2.0 endpoints. Claude Desktop and Claude.ai will show a **"Connect" button** that triggers the flow automatically:

1. Claude redirects to `/authorize`
2. Server mints a fresh per-session CDP alias wallet and redirects to `snapshot.box/#/settings/alias/authorize/<alias>` with a callback URL
3. User authorizes that alias on Snapshot
4. Snapshot redirects back to `/auth/callback`
5. Server resolves the authorizing user from the alias, generates an auth code, and redirects back to Claude
6. Claude exchanges the code for a JWT (HS256) access token at `/token`
7. All subsequent requests include the token — the server verifies the signature and reads the user and their CDP account from the claims

Each user gets their own CDP alias, so one user cannot sign votes on behalf of another. Tokens are self-verifiable and survive server restarts (until `JWT_SECRET` rotates).

### Stdio (local)

1. Call `snapshot-vote` — if not yet authorized, returns the authorization URL
2. User visits `snapshot.box/#/settings/alias/authorize/<alias>` to authorize
3. Call `snapshot-vote` again — works

## Development

```bash
bun dev      # watch mode
bun test     # run security tests
bun lint     # ESLint
bun format   # Prettier
```
