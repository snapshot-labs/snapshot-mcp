import { randomUUID } from 'node:crypto';
import { type OAuthRegisteredClientsStore } from '@modelcontextprotocol/sdk/server/auth/clients.js';
import {
  type AuthorizationParams,
  type OAuthServerProvider
} from '@modelcontextprotocol/sdk/server/auth/provider.js';
import { type AuthInfo } from '@modelcontextprotocol/sdk/server/auth/types.js';
import {
  type OAuthClientInformationFull,
  type OAuthTokens
} from '@modelcontextprotocol/sdk/shared/auth.js';
import { type Request, type Response } from 'express';
import { type JWTPayload, jwtVerify, SignJWT } from 'jose';
import { createFreshAccount } from './cdp.js';
import { resolveUserFromAlias } from './hub.js';

const ALG = 'HS256';

function getSecret(): Uint8Array {
  const raw = process.env.JWT_SECRET;
  if (raw === undefined || raw.length < 32) {
    throw new Error(
      'JWT_SECRET must be set and at least 32 characters. Generate one with: openssl rand -hex 32'
    );
  }
  return new TextEncoder().encode(raw);
}

async function sign(claims: JWTPayload, exp?: string): Promise<string> {
  const jwt = new SignJWT({ ...claims, nonce: randomUUID() })
    .setProtectedHeader({ alg: ALG })
    .setIssuedAt();
  if (exp) jwt.setExpirationTime(exp);
  return jwt.sign(getSecret());
}

async function verify(token: string): Promise<JWTPayload> {
  const { payload } = await jwtVerify(token, getSecret(), {
    algorithms: [ALG]
  });
  return payload;
}

export async function signAccessToken(payload: {
  user: string;
  signerKey: string;
  clientId: string;
}): Promise<string> {
  return sign(
    {
      sub: payload.user,
      aud: payload.clientId,
      signerKey: payload.signerKey
    },
    '1y'
  );
}

type ClientMetadata = Omit<OAuthClientInformationFull, 'client_id'>;

async function signClientId(metadata: ClientMetadata): Promise<string> {
  return sign({ metadata });
}

async function verifyClientId(clientId: string): Promise<ClientMetadata> {
  const p = await verify(clientId);
  if (p.metadata == null || typeof p.metadata !== 'object') {
    throw new Error('Invalid client_id');
  }
  return p.metadata as ClientMetadata;
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
    const clientId = await signClientId(metadata);
    return { ...metadata, client_id: clientId } as OAuthClientInformationFull;
  }
};

interface Session {
  clientId: string;
  codeChallenge: string;
  redirectUri: string;
  signerKey: string;
  signerAddress: string;
  state?: string;
}
type CodeSession = Session & { user: string };

export class SnapshotOAuthProvider implements OAuthServerProvider {
  clientsStore = clientsStore;
  private pendingSessions = new Map<string, Session>();
  private codes = new Map<string, CodeSession>();

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
      user: record.user,
      signerKey: record.signerKey,
      clientId: client.client_id
    });

    return { access_token: accessToken, token_type: 'bearer' };
  }

  async exchangeRefreshToken(): Promise<OAuthTokens> {
    throw new Error('Refresh tokens are not supported');
  }

  async verifyAccessToken(token: string): Promise<AuthInfo> {
    const p = await verify(token);
    if (
      typeof p.sub !== 'string' ||
      typeof p.aud !== 'string' ||
      typeof p.signerKey !== 'string' ||
      typeof p.exp !== 'number'
    ) {
      throw new Error('Invalid token');
    }
    return {
      token,
      clientId: p.aud,
      scopes: [],
      expiresAt: p.exp,
      extra: {
        user: p.sub,
        signerKey: p.signerKey
      }
    };
  }

  async handleCallback(sessionId: string): Promise<string> {
    const session = this.pendingSessions.get(sessionId);
    if (!session) throw new Error('Unknown session');

    const user = await resolveUserFromAlias(session.signerAddress);
    if (!user) throw new Error('Alias not authorized');

    const code = randomUUID();
    this.codes.set(code, { ...session, user });
    this.pendingSessions.delete(sessionId);

    const url = new URL(session.redirectUri);
    url.searchParams.set('code', code);
    if (session.state) url.searchParams.set('state', session.state);
    return url.toString();
  }

  callback = async (req: Request, res: Response): Promise<void> => {
    const sessionId = req.query.session as string | undefined;
    if (sessionId === undefined) {
      res.status(400).send('Missing session');
      return;
    }
    try {
      res.redirect(await this.handleCallback(sessionId));
    } catch (e) {
      res.status(400).send(e instanceof Error ? e.message : String(e));
    }
  };
}
