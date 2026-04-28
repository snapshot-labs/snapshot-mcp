// OAuth provider invariants. Each test pins one specific attack the
// SnapshotOAuthProvider must reject.
import { beforeEach, describe, expect, test } from 'bun:test';
import { setGqlHandler } from './helpers.js';
import { SnapshotOAuthProvider } from '../src/auth.js';

const REDIRECT_URI = 'http://localhost:17623/oauth/callback';
const CLIENT_METADATA = {
  redirect_uris: [REDIRECT_URI],
  token_endpoint_auth_method: 'none',
  grant_types: ['authorization_code'],
  response_types: ['code'],
  client_name: 'Test Client'
} as any;

const PKCE_CHALLENGE = 'test-challenge-7chars-or-more-here';

// Stub Express response just enough for authorize() to call res.redirect.
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

// Drive a complete authorize → callback cycle and return the resulting
// auth code together with the registered client and session metadata.
async function driveAuthCodeFlow(
  provider: SnapshotOAuthProvider,
  userAddress: string,
  opts: { client?: any; codeChallenge?: string } = {}
) {
  const client =
    opts.client ??
    (await provider.clientsStore.registerClient!(CLIENT_METADATA));
  const res = makeRes();
  await provider.authorize(
    client,
    {
      redirectUri: REDIRECT_URI,
      state: 'csrf-state-xyz',
      codeChallenge: opts.codeChallenge ?? PKCE_CHALLENGE,
      codeChallengeMethod: 'S256',
      scopes: []
    } as any,
    res as any
  );
  const snapshotUrl = (res as any).redirectedTo as string;
  // Extract the per-session alias address from the snapshot.box URL —
  // this is the address whose `aliases` query handleCallback will run.
  const aliasMatch = snapshotUrl.match(/authorize\/(0x[0-9a-fA-F]+)/)!;
  const aliasAddress = aliasMatch[1];
  // Extract sessionId from the embedded callback URL.
  const sessionMatch =
    decodeURIComponent(snapshotUrl).match(/session=([a-f0-9-]+)/)!;
  const sessionId = sessionMatch[1];

  // Mock hub: when handleCallback queries `aliases(where: { alias })`,
  // return the user we want this flow to resolve to.
  setGqlHandler((_q, vars) => {
    const aliasInQuery = (vars as any)?.where?.alias;
    if (aliasInQuery?.toLowerCase() === aliasAddress.toLowerCase()) {
      return { aliases: [{ address: userAddress }] };
    }
    return { aliases: [] };
  });

  const redirectUrl = await provider.handleCallback(sessionId);
  const url = new URL(redirectUrl);
  const code = url.searchParams.get('code')!;
  const state = url.searchParams.get('state')!;
  return { client, code, state, sessionId, aliasAddress };
}

describe('OAuth provider security', () => {
  let provider: SnapshotOAuthProvider;

  beforeEach(() => {
    provider = new SnapshotOAuthProvider();
  });

  test('client registration roundtrips through getClient', async () => {
    const registered =
      await provider.clientsStore.registerClient!(CLIENT_METADATA);
    const fetched = await provider.clientsStore.getClient(registered.client_id);
    expect(fetched).toBeDefined();
    expect(fetched!.client_name).toBe('Test Client');
    expect(fetched!.redirect_uris).toEqual([REDIRECT_URI]);
  });

  test('getClient returns undefined for a forged client_id', async () => {
    // An attacker fabricates a client_id without our trusted signer.
    const fabricated = Buffer.from(
      JSON.stringify({
        client_name: 'Forged',
        redirect_uris: ['https://evil.example/cb']
      })
    ).toString('base64url');
    const garbage = `${fabricated}.0xdeadbeef`;
    expect(await provider.clientsStore.getClient(garbage)).toBeUndefined();
    expect(
      await provider.clientsStore.getClient('total-nonsense')
    ).toBeUndefined();
  });

  test('challengeForAuthorizationCode returns the exact stored challenge (PKCE binding)', async () => {
    const { client, code } = await driveAuthCodeFlow(
      provider,
      '0x000000000000000000000000000000000000aaaa'
    );
    const got = await provider.challengeForAuthorizationCode(client, code);
    expect(got).toBe(PKCE_CHALLENGE);
  });

  test('exchangeAuthorizationCode is single-use (replay rejected)', async () => {
    const { client, code } = await driveAuthCodeFlow(
      provider,
      '0x000000000000000000000000000000000000aaaa'
    );
    const tokens = await provider.exchangeAuthorizationCode(client, code);
    expect(tokens.access_token).toBeTruthy();
    await expect(
      provider.exchangeAuthorizationCode(client, code)
    ).rejects.toThrow('Unknown authorization code');
  });

  test('exchangeAuthorizationCode rejects clientId mismatch', async () => {
    const { code } = await driveAuthCodeFlow(
      provider,
      '0x000000000000000000000000000000000000aaaa'
    );
    // Register a *different* client and try to redeem the code.
    const otherClient = await provider.clientsStore.registerClient!({
      ...CLIENT_METADATA,
      client_name: 'Other Client'
    });
    await expect(
      provider.exchangeAuthorizationCode(otherClient, code)
    ).rejects.toThrow('Client mismatch');
  });

  test('handleCallback throws when hub has no alias authorization for the session', async () => {
    const client = await provider.clientsStore.registerClient!(CLIENT_METADATA);
    const res = makeRes();
    await provider.authorize(
      client,
      {
        redirectUri: REDIRECT_URI,
        state: 'x',
        codeChallenge: PKCE_CHALLENGE,
        codeChallengeMethod: 'S256',
        scopes: []
      } as any,
      res as any
    );
    const sessionId = decodeURIComponent((res as any).redirectedTo).match(
      /session=([a-f0-9-]+)/
    )![1];
    // Hub returns no aliases — the user never authorized.
    setGqlHandler(() => ({ aliases: [] }));
    await expect(provider.handleCallback(sessionId)).rejects.toThrow(
      'Alias not authorized'
    );
  });

  test('each authorize() call mints a different per-session alias', async () => {
    const client = await provider.clientsStore.registerClient!(CLIENT_METADATA);
    const aliases = new Set<string>();
    for (let i = 0; i < 3; i++) {
      const res = makeRes();
      await provider.authorize(
        client,
        {
          redirectUri: REDIRECT_URI,
          state: `s${i}`,
          codeChallenge: PKCE_CHALLENGE,
          codeChallengeMethod: 'S256',
          scopes: []
        } as any,
        res as any
      );
      const alias = (res as any).redirectedTo.match(
        /authorize\/(0x[0-9a-fA-F]+)/
      )[1];
      aliases.add(alias.toLowerCase());
    }
    expect(aliases.size).toBe(3);
  });
});
