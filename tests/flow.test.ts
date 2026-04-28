// Multi-step / cross-context security scenarios. These exist where
// the security property only emerges from the combination of multiple
// modules — not testable from a single unit.
//
// Out of scope (flagged in plan, repeated here):
//   - Real CDP policy enforcement (no live CDP)
//   - Snapshot hub `aliases` query semantics (hub responsibility)
//   - MCP SDK `requireBearerAuth` middleware (third-party)
//   - TLS / browser CSRF / phishing on snapshot.box
//   - Token theft from disk (out-of-band, same as any bearer credential)

import { beforeEach, describe, expect, test } from 'bun:test';
import { setGqlHandler, setJwtSecret } from './helpers.js';
import { SnapshotOAuthProvider } from '../src/auth.js';
import { verifyAccessToken } from '../src/token.js';

const CLIENT_METADATA = {
  redirect_uris: ['http://localhost:17623/oauth/callback'],
  token_endpoint_auth_method: 'none',
  grant_types: ['authorization_code'],
  response_types: ['code'],
  client_name: 'Test Client'
} as any;

function makeRes() {
  let redirectedTo: string | null = null;
  return {
    redirect: (url: string) => {
      redirectedTo = url;
    },
    get redirectedTo() {
      return redirectedTo;
    }
  };
}

async function startAuthorize(provider: SnapshotOAuthProvider, client: any) {
  const res = makeRes();
  await provider.authorize(
    client,
    {
      redirectUri: 'http://localhost:17623/oauth/callback',
      state: 'csrf-state',
      codeChallenge: 'pkce-challenge-fixture',
      codeChallengeMethod: 'S256',
      scopes: []
    } as any,
    res as any
  );
  const url = (res as any).redirectedTo as string;
  const aliasAddress = url.match(/authorize\/(0x[0-9a-fA-F]+)/)![1];
  const sessionId = decodeURIComponent(url).match(/session=([a-f0-9-]+)/)![1];
  return { aliasAddress, sessionId };
}

describe('end-to-end OAuth flow security', () => {
  let provider: SnapshotOAuthProvider;

  beforeEach(async () => {
    setJwtSecret('test-secret-must-be-at-least-32-chars-long-please-yes');
    provider = new SnapshotOAuthProvider();
  });

  test('two parallel users get distinct tokens; tokens cannot be cross-mapped', async () => {
    const userA = '0x000000000000000000000000000000000000aaaa';
    const userB = '0x000000000000000000000000000000000000bbbb';

    const client = await provider.clientsStore.registerClient!(CLIENT_METADATA);

    // Both flows start before either resolves — interleaved.
    const flowA = await startAuthorize(provider, client);
    const flowB = await startAuthorize(provider, client);

    // Sanity: distinct aliases.
    expect(flowA.aliasAddress.toLowerCase()).not.toBe(
      flowB.aliasAddress.toLowerCase()
    );

    // Hub knows: alias_A authorized by user_A; alias_B authorized by user_B.
    setGqlHandler((_q, vars) => {
      const alias = (vars as any)?.where?.alias?.toLowerCase();
      if (alias === flowA.aliasAddress.toLowerCase())
        return { aliases: [{ address: userA }] };
      if (alias === flowB.aliasAddress.toLowerCase())
        return { aliases: [{ address: userB }] };
      return { aliases: [] };
    });

    const codeA = new URL(
      await provider.handleCallback(flowA.sessionId)
    ).searchParams.get('code')!;
    const codeB = new URL(
      await provider.handleCallback(flowB.sessionId)
    ).searchParams.get('code')!;

    const tokensA = await provider.exchangeAuthorizationCode(client, codeA);
    const tokensB = await provider.exchangeAuthorizationCode(client, codeB);

    // Each token resolves to its own user — no leakage.
    expect((await verifyAccessToken(tokensA.access_token)).userAddress).toBe(
      userA
    );
    expect((await verifyAccessToken(tokensB.access_token)).userAddress).toBe(
      userB
    );

    // Sanity: the two tokens are not byte-equal (would imply state leak).
    expect(tokensA.access_token).not.toBe(tokensB.access_token);

    // Attempt the headline cross-user attack: take token A, swap the
    // userAddress (sub claim) in the payload to user B's, present for
    // verification. JWT signature must catch the tamper.
    const [header, payload, sig] = tokensA.access_token.split('.');
    const claims = JSON.parse(Buffer.from(payload, 'base64url').toString());
    claims.sub = userB;
    const morphed = `${header}.${Buffer.from(JSON.stringify(claims)).toString('base64url')}.${sig}`;
    expect(verifyAccessToken(morphed)).rejects.toThrow();
  });

  test('rotating JWT_SECRET invalidates all previously issued tokens (kill switch)', async () => {
    const userA = '0x000000000000000000000000000000000000aaaa';
    const client = await provider.clientsStore.registerClient!(CLIENT_METADATA);
    const flow = await startAuthorize(provider, client);

    setGqlHandler(() => ({ aliases: [{ address: userA }] }));
    const code = new URL(
      await provider.handleCallback(flow.sessionId)
    ).searchParams.get('code')!;
    const { access_token: oldToken } = await provider.exchangeAuthorizationCode(
      client,
      code
    );

    // Sanity: the token works under the original secret.
    expect((await verifyAccessToken(oldToken)).userAddress).toBe(userA);

    // Operator rotates JWT_SECRET.
    setJwtSecret('rotated-secret-also-32-chars-or-more-please-yes');

    // The previously issued token must no longer verify.
    expect(verifyAccessToken(oldToken)).rejects.toThrow();
  });
});
