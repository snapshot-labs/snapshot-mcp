import { randomUUID } from 'node:crypto';
import { OAuthRegisteredClientsStore } from '@modelcontextprotocol/sdk/server/auth/clients.js';
import {
  AuthorizationParams,
  OAuthServerProvider
} from '@modelcontextprotocol/sdk/server/auth/provider.js';
import { AuthInfo } from '@modelcontextprotocol/sdk/server/auth/types.js';
import {
  OAuthClientInformationFull,
  OAuthTokens
} from '@modelcontextprotocol/sdk/shared/auth.js';
import { Request, Response } from 'express';
import { JWTPayload, jwtVerify, SignJWT } from 'jose';
import { resolveUserAddressFromAlias } from './hub.js';
import { createFreshAccount } from './wallet.js';

const ALG = 'HS256';

let cachedSecret: Uint8Array | null = null;
let cachedSecretSource: string | null = null;

function getSecret(): Uint8Array {
  const raw = process.env.JWT_SECRET;
  if (!raw || raw.length < 32) {
    throw new Error(
      'JWT_SECRET must be set and at least 32 characters. Generate one with: openssl rand -hex 32'
    );
  }
  if (raw !== cachedSecretSource) {
    cachedSecret = new TextEncoder().encode(raw);
    cachedSecretSource = raw;
  }
  return cachedSecret!;
}

async function sign(claims: JWTPayload): Promise<string> {
  return new SignJWT({ ...claims, nonce: randomUUID() })
    .setProtectedHeader({ alg: ALG })
    .setIssuedAt()
    .sign(getSecret());
}

async function verify(token: string): Promise<JWTPayload> {
  const { payload } = await jwtVerify(token, getSecret(), {
    algorithms: [ALG]
  });
  return payload;
}

export async function signAccessToken(payload: {
  userAddress: string;
  signerKey: string;
  clientId: string;
}): Promise<string> {
  return sign({
    sub: payload.userAddress,
    aud: payload.clientId,
    signerKey: payload.signerKey
  });
}

export async function verifyAccessToken(token: string) {
  const p = await verify(token);
  if (!p.sub || !p.aud || typeof p.signerKey !== 'string') {
    throw new Error('Invalid token');
  }
  return {
    userAddress: p.sub as string,
    signerKey: p.signerKey,
    clientId: p.aud as string,
    issuedAt: p.iat as number,
    nonce: p.nonce as string
  };
}

async function signClientId(metadata: unknown): Promise<string> {
  return sign({ metadata: JSON.stringify(metadata) });
}

async function verifyClientId(clientId: string): Promise<any> {
  const p = await verify(clientId);
  if (typeof p.metadata !== 'string') throw new Error('Invalid client_id');
  return JSON.parse(p.metadata);
}

const clientsStore: OAuthRegisteredClientsStore = {
  async getClient(clientId) {
    try {
      const metadata = await verifyClientId(clientId);
      return { ...metadata, client_id: clientId };
    } catch {
      return undefined;
    }
  },
  async registerClient(client) {
    const metadata = {
      ...client,
      client_id_issued_at: Math.floor(Date.now() / 1000)
    };
    const client_id = await signClientId(metadata);
    return { ...metadata, client_id } as OAuthClientInformationFull;
  }
};

interface Session {
  clientId: string;
  codeChallenge: string;
  redirectUri: string;
  signerKey: string;
  state?: string;
  signerAddress?: string;
  userAddress?: string;
}

export class SnapshotOAuthProvider implements OAuthServerProvider {
  clientsStore = clientsStore;
  private pendingSessions = new Map<string, Session>();
  private codes = new Map<string, Session>();

  async authorize(
    client: OAuthClientInformationFull,
    params: AuthorizationParams,
    res: Response
  ): Promise<void> {
    const sessionId = randomUUID();
    const { signerKey, signerAddress } = await createFreshAccount();

    this.pendingSessions.set(sessionId, {
      redirectUri: params.redirectUri,
      state: params.state,
      codeChallenge: params.codeChallenge,
      clientId: client.client_id,
      signerKey,
      signerAddress
    });

    const baseUrl =
      process.env.BASE_URL ?? `http://localhost:${process.env.PORT ?? 8080}`;
    const callbackUrl = `${baseUrl}/auth/callback?session=${sessionId}`;

    const snapshotUrl = `https://snapshot.box/#/settings/alias/authorize/${signerAddress}?redirect_uri=${encodeURIComponent(callbackUrl)}`;
    res.redirect(snapshotUrl);
  }

  async challengeForAuthorizationCode(
    _client: OAuthClientInformationFull,
    authorizationCode: string
  ): Promise<string> {
    const record = this.codes.get(authorizationCode);
    if (!record) throw new Error('Unknown authorization code');
    return record.codeChallenge;
  }

  async exchangeAuthorizationCode(
    client: OAuthClientInformationFull,
    authorizationCode: string
  ): Promise<OAuthTokens> {
    const record = this.codes.get(authorizationCode);
    if (!record) throw new Error('Unknown authorization code');
    if (record.clientId !== client.client_id)
      throw new Error('Client mismatch');
    this.codes.delete(authorizationCode);

    const accessToken = await signAccessToken({
      userAddress: record.userAddress!,
      signerKey: record.signerKey,
      clientId: client.client_id
    });

    return { access_token: accessToken, token_type: 'bearer' };
  }

  async exchangeRefreshToken(): Promise<OAuthTokens> {
    throw new Error('Refresh tokens are not supported');
  }

  async verifyAccessToken(token: string): Promise<AuthInfo> {
    const payload = await verifyAccessToken(token);
    return {
      token,
      clientId: payload.clientId,
      scopes: [],
      // SDK's bearerAuth middleware requires a valid expiresAt; tokens never
      // actually expire (only invalidated by JWT_SECRET rotation), so use
      // a far-future timestamp.
      expiresAt: Math.floor(Date.now() / 1000) + 100 * 365 * 24 * 3600,
      extra: {
        userAddress: payload.userAddress,
        signerKey: payload.signerKey
      }
    };
  }

  async handleCallback(sessionId: string): Promise<string> {
    const session = this.pendingSessions.get(sessionId);
    if (!session) throw new Error('Unknown session');

    const userAddress = await resolveUserAddressFromAlias(
      session.signerAddress!
    );
    if (!userAddress) throw new Error('Alias not authorized');

    const code = randomUUID();
    this.codes.set(code, { ...session, userAddress });
    this.pendingSessions.delete(sessionId);

    const url = new URL(session.redirectUri);
    url.searchParams.set('code', code);
    if (session.state) url.searchParams.set('state', session.state);
    return url.toString();
  }

  callback = async (req: Request, res: Response): Promise<void> => {
    const sessionId = req.query.session as string | undefined;
    if (!sessionId) return void res.status(400).send('Missing session');
    try {
      res.redirect(await this.handleCallback(sessionId));
    } catch (e) {
      res.status(400).send(e instanceof Error ? e.message : String(e));
    }
  };
}
